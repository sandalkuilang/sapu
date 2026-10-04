// tests/sapu-cleanup.test.ts — scripts/sapu-cleanup.mjs: which branches are proven merged (plan) and
// the git facts it reads from a real repository (gitFacts).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script without types
import { gitFacts, issueRefs, plan, SAPU_BRANCH } from "../plugins/sapu/scripts/sapu-cleanup.mjs";

type Step = { branch: string; action: string; why: string; worktree: string };
const facts = (over: Record<string, unknown> = {}) => ({
  branches: [] as { name: string; tip: string; subjects: string }[],
  worktrees: {} as Record<string, string>,
  dirty: new Set<string>(),
  inBase: new Set<string>(),
  reach: new Set<string>(),
  mergedNames: new Set<string>(),
  open: new Set<string>(),
  closedByMerge: () => false,
  base: "main",
  mainBranch: "main",
  ...over,
});
const b = (name: string, tip = `t-${name}`, subjects = "") => ({ name, tip, subjects });
const by = (steps: Step[]) => Object.fromEntries(steps.map((s) => [s.branch, `${s.action}: ${s.why}`]));

describe("sapu-cleanup — plan: only sapu's own branches, only when proven merged", () => {
  it("knows sapu's branch names", () => {
    for (const n of ["fix/issue-12-x", "feat/issue-3-y", "worktree-wf_ab12-3", "worktree-agent-a1b2", "sapu-12-fix3"]) expect(n).toMatch(SAPU_BRANCH);
    for (const n of ["main", "feature/login", "fix/login", "wip", "release/1.2"]) expect(n).not.toMatch(SAPU_BRANCH);
  });

  it("reads issue numbers from the name and the commit subjects", () => {
    expect(issueRefs("fix/issue-12-x feat: thing (#12)\nfix: other #40")).toEqual([12, 40]);
  });

  it("deletes on each proof, keeps everything unproven", () => {
    const steps = plan(
      facts({
        branches: [b("main"), b("fix/issue-1-a"), b("fix/issue-2-b", "tip2"), b("fix/issue-3-c"), b("worktree-wf_x-1", "t", "feat: y (#4)"), b("fix/issue-5-e"), b("worktree-agent-z", "tz", "wip")],
        inBase: new Set(["fix/issue-1-a"]),
        reach: new Set(["tip2"]),
        mergedNames: new Set(["fix/issue-3-c"]),
        closedByMerge: (n: number) => n === 4,
      }),
    );
    expect(by(steps)).toEqual({
      "fix/issue-1-a": "delete: in main",
      "fix/issue-2-b": "delete: inside a merged PR",
      "fix/issue-3-c": "delete: merged PR of this name",
      "worktree-wf_x-1": "delete: issue #4 closed by merged PRs",
      "fix/issue-5-e": "keep: not proven merged",
      "worktree-agent-z": "keep: not proven merged",
    });
  });

  it("an issue proof needs EVERY named issue closed by a merged PR", () => {
    const steps = plan(facts({ branches: [b("fix/issue-6-a", "t", "also touches #7")], closedByMerge: (n: number) => n === 6 }));
    expect(by(steps)["fix/issue-6-a"]).toBe("keep: not proven merged");
  });

  it("never touches: an open PR's head, --keep, a non-sapu branch (unless --all), a dirty worktree, the main checkout's branch", () => {
    const base = facts({
      branches: [b("fix/issue-8-a"), b("fix/issue-9-b"), b("feature/login"), b("fix/issue-10-c"), b("fix/issue-11-d")],
      inBase: new Set(["fix/issue-8-a", "fix/issue-9-b", "feature/login", "fix/issue-10-c", "fix/issue-11-d"]),
      open: new Set(["fix/issue-8-a"]),
      worktrees: { "fix/issue-10-c": "/wt/c" },
      dirty: new Set(["/wt/c"]),
      mainBranch: "fix/issue-11-d",
    });
    expect(by(plan({ ...base, keep: ["fix/issue-9-b"] }))).toEqual({
      "fix/issue-8-a": "keep: open PR",
      "fix/issue-9-b": "keep: --keep",
      "feature/login": "keep: not a sapu branch (--all to include)",
      "fix/issue-10-c": "keep: its worktree has uncommitted changes (/wt/c)",
    });
    expect(by(plan({ ...base, all: true }))["feature/login"]).toBe("delete: in main");
  });
});

describe("sapu-cleanup — gitFacts on a real repository", () => {
  it("finds branches in the base, inside a merged PR head, worktrees and dirty ones", () => {
    const top = realpathSync(mkdtempSync(join(tmpdir(), "sapu-cleanup-")));
    const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const origin = join(top, "origin.git");
    const main = join(top, "main");
    g(top, "init", "-q", "--bare", "-b", "main", origin);
    g(top, "clone", "-q", origin, main);
    const commit = (cwd: string, f: string) => {
      writeFileSync(join(cwd, f), f);
      g(cwd, "add", f);
      g(cwd, "commit", "-q", "-m", `add ${f} (#12)`);
    };
    commit(main, "a");
    g(main, "push", "-q", "origin", "HEAD:main");
    // in the base: a branch whose tip is already on origin/main
    g(main, "branch", "fix/issue-1-old");
    // squash-merged: its tip is inside a merged PR's head (the PR head SHA exists locally)
    g(main, "checkout", "-q", "-b", "fix/issue-2-sq");
    commit(main, "b");
    const prHead = g(main, "rev-parse", "HEAD");
    g(main, "checkout", "-q", "main");
    // a worktree with uncommitted changes, on a branch with its own commit
    const wt = join(main, ".claude/worktrees/w1");
    mkdirSync(join(main, ".claude/worktrees"), { recursive: true });
    g(main, "worktree", "add", "-q", "-b", "worktree-wf_w-1", wt);
    commit(wt, "c");
    writeFileSync(join(wt, "dirty.txt"), "x");
    g(main, "fetch", "-q", "origin");

    const f = gitFacts(main, "main", [prHead, "0".repeat(40)]);
    expect(f.mainBranch).toBe("main");
    expect([...f.inBase]).toEqual(expect.arrayContaining(["main", "fix/issue-1-old"]));
    expect(f.inBase.has("fix/issue-2-sq")).toBe(false);
    expect(f.reach.has(prHead)).toBe(true);
    expect(f.worktrees["worktree-wf_w-1"]).toBe(wt);
    expect(f.dirty.has(wt)).toBe(true);
    expect(f.branches.find((x: { name: string }) => x.name === "worktree-wf_w-1")?.subjects).toBe("add c (#12)");
    expect(by(plan({ ...f, mergedNames: new Set(), open: new Set(), closedByMerge: () => false, base: "main" }))).toEqual({
      "fix/issue-1-old": "delete: in main",
      "fix/issue-2-sq": "delete: inside a merged PR",
      "worktree-wf_w-1": "keep: not proven merged",
    });
  });
});
