// tests/sapu-cleanup.test.ts — scripts/sapu-cleanup.mjs must never delete unmerged work: which branches
// are proven merged (plan), the facts it reads from a real repository (gitFacts) and when a worktree
// must stay (worktreeUnsafe).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script without types
import { gitFacts, parseArgs, plan, SAPU_BRANCH, worktreeUnsafe } from "../plugins/sapu/scripts/sapu-cleanup.mjs";

type Step = { branch: string; action: string; why: string; worktree: string };
const by = (steps: Step[]) => Object.fromEntries(steps.map((s) => [s.branch, `${s.action}: ${s.why}`]));
const facts = (over: Record<string, unknown> = {}) => ({
  branches: [] as { name: string; tip: string }[],
  worktrees: {} as Record<string, string>,
  unsafe: {} as Record<string, string>,
  inBase: new Set<string>(),
  reach: new Set<string>(),
  open: new Set<string>(),
  base: "main",
  mainBranch: "main",
  ...over,
});

describe("sapu-cleanup — plan", () => {
  it("knows sapu's branch names", () => {
    for (const n of ["fix/issue-12-x", "feat/issue-3-y", "worktree-wf_ab12-3", "worktree-agent-a1b2", "sapu-12-fix3"]) expect(n).toMatch(SAPU_BRANCH);
    for (const n of ["main", "feature/login", "fix/login", "wip", "release/1.2"]) expect(n).not.toMatch(SAPU_BRANCH);
  });

  it("deletes only a tip in the base or inside a merged PR's head; keeps everything else", () => {
    const steps = plan(facts({ branches: [{ name: "fix/issue-1-a", tip: "a" }, { name: "fix/issue-2-b", tip: "b" }, { name: "fix/issue-3-c", tip: "c" }], inBase: new Set(["fix/issue-1-a"]), reach: new Set(["b"]) }));
    expect(by(steps)).toEqual({ "fix/issue-1-a": "delete: in main", "fix/issue-2-b": "delete: every commit is in a PR merged into main", "fix/issue-3-c": "keep: not proven merged" });
  });

  it("never touches: an open PR's head, --keep, a non-sapu branch (unless --all), an unsafe worktree, the main checkout's branch", () => {
    const f = facts({
      branches: ["fix/issue-8-a", "fix/issue-9-b", "feature/login", "fix/issue-10-c", "fix/issue-11-d"].map((name) => ({ name, tip: name })),
      inBase: new Set(["fix/issue-8-a", "fix/issue-9-b", "feature/login", "fix/issue-10-c", "fix/issue-11-d"]),
      open: new Set(["fix/issue-8-a"]),
      worktrees: { "fix/issue-10-c": "/wt/c" },
      unsafe: { "/wt/c": "has uncommitted or untracked changes" },
      mainBranch: "fix/issue-11-d",
    });
    expect(by(plan({ ...f, keep: ["fix/issue-9-b"] }))).toEqual({
      "fix/issue-8-a": "keep: open PR",
      "fix/issue-9-b": "keep: --keep",
      "feature/login": "keep: not a sapu branch (--all to include)",
      "fix/issue-10-c": "keep: its worktree has uncommitted or untracked changes (/wt/c)",
    });
    expect(by(plan({ ...f, all: true }))["feature/login"]).toBe("delete: in main");
  });

  it("parses --keep both ways and refuses unknown arguments", () => {
    expect(parseArgs(["--apply", "--keep", "a", "--keep=b"])).toEqual({ apply: true, all: false, keep: ["a", "b"] });
    expect(() => parseArgs(["--aply"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--keep"])).toThrow(/unknown argument/);
  });
});

describe("sapu-cleanup — a real repository: no unmerged commit is ever proven merged", () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "sapu-cleanup-")));
  const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const origin = join(top, "origin.git");
  const main = join(top, "main");
  g(top, "init", "-q", "--bare", "-b", "main", origin);
  g(top, "clone", "-q", origin, main);
  const commit = (cwd: string, f: string, msg = `add ${f}`) => {
    writeFileSync(join(cwd, f), f);
    g(cwd, "add", f);
    g(cwd, "commit", "-q", "-m", msg);
    return g(cwd, "rev-parse", "HEAD");
  };
  commit(main, "a");
  g(main, "push", "-q", "origin", "HEAD:main");
  g(main, "branch", "fix/issue-1-old"); // in the base
  // squash-merged: the PR head SHA is known locally
  g(main, "checkout", "-q", "-b", "fix/issue-2-sq");
  const head2 = commit(main, "b");
  // merged, then one more local commit: must stay
  g(main, "checkout", "-q", "-b", "fix/issue-5-more", head2);
  commit(main, "b2");
  // a reused name / second attempt naming a closed issue: must stay
  g(main, "checkout", "-q", "-b", "feat/issue-7-again", "main");
  commit(main, "c", "second attempt (#7, see #1)");
  g(main, "checkout", "-q", "main");
  g(main, "fetch", "-q", "origin");

  it("a merged head proves only itself and its ancestors", () => {
    const f = gitFacts(main, "main", [head2], Date.now());
    expect(by(plan({ ...f, open: new Set(), base: "main" }))).toEqual({
      "fix/issue-1-old": "delete: in main",
      "fix/issue-2-sq": "delete: every commit is in a PR merged into main",
      "fix/issue-5-more": "keep: not proven merged",
      "feat/issue-7-again": "keep: not proven merged",
    });
  });

  it("a worktree stays when dirty, untracked, holding an ignored env file, recently used or the cwd", () => {
    const wt = join(main, ".claude/worktrees/w1");
    mkdirSync(join(main, ".claude/worktrees"), { recursive: true });
    writeFileSync(join(main, ".gitignore"), ".env*\nnode_modules/\n.claude/\n");
    g(main, "add", ".gitignore");
    g(main, "commit", "-q", "-m", "ignore");
    g(main, "worktree", "add", "-q", "-b", "worktree-wf_w-1", wt);
    const later = Date.now() + 2 * 3600_000; // an hour past the last git activity
    expect(worktreeUnsafe(wt, later, main)).toBe("");
    expect(worktreeUnsafe(wt, Date.now(), main)).toMatch(/last hour/);
    expect(worktreeUnsafe(wt, later, wt)).toMatch(/working directory/);
    mkdirSync(join(wt, "node_modules"));
    writeFileSync(join(wt, "node_modules/x.js"), "x");
    expect(worktreeUnsafe(wt, later, main)).toBe("");
    writeFileSync(join(wt, ".env.local"), "SECRET=1");
    expect(worktreeUnsafe(wt, later, main)).toMatch(/env file/);
    writeFileSync(join(wt, "new.txt"), "x");
    expect(worktreeUnsafe(wt, later, main)).toMatch(/uncommitted or untracked/);
  });
});
