// tests/sapu-cleanup.test.ts — scripts/sapu-cleanup.mjs must never delete unmerged work: which branches
// are proven merged (plan), the facts it reads from a real repository (gitFacts) and when a worktree
// must stay (worktreeUnsafe).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script without types
import { branchesOnlySteps, branchIssues, carryOut, coverage, gitFacts, parseArgs, plan, removeWorktree, SAPU_BRANCH, worktreeUnsafe } from "../plugins/sapu/scripts/sapu-cleanup.mjs";

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

  it("--branches-only removes no worktree: a branch checked out in one stays, a detached one is not listed", () => {
    expect(parseArgs(["--apply", "--branches-only"])).toEqual({ apply: true, all: false, keep: [], branchesOnly: true });
    const steps = plan(facts({
      branches: [{ name: "fix/issue-1-a", tip: "a" }, { name: "fix/issue-2-b", tip: "b" }],
      inBase: new Set(["fix/issue-1-a", "fix/issue-2-b"]),
      worktrees: { "fix/issue-2-b": "/m/.claude/worktrees/b" },
      detached: [{ worktree: "/m/.claude/worktrees/qa", head: "h" }],
      headsInBase: new Set(["h"]),
    }));
    expect(by(branchesOnlySteps(steps))).toEqual({ "fix/issue-1-a": "delete: in main", "fix/issue-2-b": "keep: checked out in worktree /m/.claude/worktrees/b (--branches-only)" });
  });

  it("an agent worktree's branch counts as sapu's own whatever its name; a detached agent worktree goes only with a merged HEAD", () => {
    const f = facts({
      branches: [{ name: "fix-3597", tip: "a" }],
      inBase: new Set(["fix-3597"]),
      worktrees: { "fix-3597": "/m/.claude/worktrees/x" },
      owned: new Set(["fix-3597"]),
      reach: new Set(["h2"]),
      detached: [
        { worktree: "/m/.claude/worktrees/qa1", head: "h1" },
        { worktree: "/m/.claude/worktrees/qa2", head: "h2" },
        { worktree: "/m/.claude/worktrees/qa3", head: "h3" },
        { worktree: "/m/.claude/worktrees/qa4", head: "h1" },
      ],
      headsInBase: new Set(["h1"]),
      unsafe: { "/m/.claude/worktrees/qa4": "saw git activity in the last hour (a session may still use it)" },
    });
    expect(by(plan(f))).toEqual({
      "fix-3597": "delete: in main",
      "(detached) /m/.claude/worktrees/qa1": "delete: HEAD in main",
      "(detached) /m/.claude/worktrees/qa2": "delete: HEAD is in a PR merged into main",
      "(detached) /m/.claude/worktrees/qa3": "keep: HEAD not proven merged",
      "(detached) /m/.claude/worktrees/qa4": "keep: worktree saw git activity in the last hour (a session may still use it)",
    });
  });

  it("parses --keep both ways and refuses unknown arguments", () => {
    expect(parseArgs(["--apply", "--keep", "a", "--keep=b"])).toEqual({ apply: true, all: false, keep: ["a", "b"], branchesOnly: false });
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

  it("a base missing on origin stops it before any plan (nothing would be proven)", () => {
    expect(() => gitFacts(main, "develop", [], Date.now())).toThrow(/origin\/develop does not exist/);
  });

  it("a merged head proves only itself and its ancestors", () => {
    const f = gitFacts(main, "main", [head2], Date.now());
    expect(by(plan({ ...f, open: new Set(), base: "main" }))).toEqual({
      "fix/issue-1-old": "delete: in main",
      "fix/issue-2-sq": "delete: every commit is in a PR merged into main",
      "fix/issue-5-more": "keep: not proven merged",
      "feat/issue-7-again": "keep: not proven merged",
    });
  });

  it("reads detached agent worktrees and their merged HEADs; an agent worktree's branch is owned", () => {
    mkdirSync(join(main, ".claude/worktrees"), { recursive: true });
    g(main, "worktree", "add", "-q", "--detach", join(main, ".claude/worktrees/qa-a"), "main");
    g(main, "worktree", "add", "-q", "--detach", join(main, ".claude/worktrees/qa-c"), "feat/issue-7-again");
    g(main, "worktree", "add", "-q", "--detach", join(top, "outside"), "main"); // not an agent worktree: never read
    const f = gitFacts(main, "main", [head2], Date.now());
    expect(f.detached.map((d: { worktree: string }) => d.worktree.replace(main, ""))).toEqual(["/.claude/worktrees/qa-a", "/.claude/worktrees/qa-c"]);
    const steps = by(plan({ ...f, open: new Set(), base: "main" }));
    expect(steps[`(detached) ${join(main, ".claude/worktrees/qa-a")}`]).toMatch(/^keep: worktree saw git activity/);
    expect(steps[`(detached) ${join(main, ".claude/worktrees/qa-c")}`]).toBe("keep: HEAD not proven merged");
    for (const w of [join(main, ".claude/worktrees/qa-a"), join(main, ".claude/worktrees/qa-c"), join(top, "outside")]) g(main, "worktree", "remove", "--force", w);
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

describe("sapu-cleanup — the agent-memory link Claude Code puts in a worktree (worktree.symlinkDirectories) is not work", () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "sapu-cleanup-link-")));
  const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const main = join(top, "main");
  g(top, "init", "-q", "-b", "main", main);
  // A pattern ending in `/` ignores <MAIN>'s real directory but not the link: the link shows as untracked.
  writeFileSync(join(main, ".gitignore"), "/.claude/worktrees/\n/.claude/agent-memory/\n");
  g(main, "add", ".gitignore");
  g(main, "commit", "-q", "-m", "ignore");
  mkdirSync(join(main, ".claude/agent-memory/reviewer"), { recursive: true });
  writeFileSync(join(main, ".claude/agent-memory/reviewer/notes.md"), "keep me");
  const later = Date.now() + 2 * 3600_000;
  const add = (name: string) => {
    const wt = join(main, ".claude/worktrees", name);
    g(main, "worktree", "add", "-q", "-b", `worktree-wf_${name}`, wt);
    mkdirSync(join(wt, ".claude"), { recursive: true });
    return wt;
  };

  it("an untracked link at .claude/agent-memory(-local) leaves the worktree clean, and removing the worktree removes only the link", () => {
    const wt = add("l1");
    symlinkSync(join(main, ".claude/agent-memory"), join(wt, ".claude/agent-memory"));
    symlinkSync(join(main, ".claude/agent-memory"), join(wt, ".claude/agent-memory-local"));
    expect(g(wt, "status", "--porcelain", "--untracked-files=all")).toMatch(/\?\? \.claude\/agent-memory/);
    expect(worktreeUnsafe(wt, later, main)).toBe("");
    expect(removeWorktree(main, wt)).toBe(true);
    expect(existsSync(wt)).toBe(false);
    expect(readFileSync(join(main, ".claude/agent-memory/reviewer/notes.md"), "utf8")).toBe("keep me");
  });

  it("a worktree git refuses to remove (locked: an agent still runs in it) keeps its link", () => {
    const wt = add("l4");
    symlinkSync(join(main, ".claude/agent-memory"), join(wt, ".claude/agent-memory"));
    g(main, "worktree", "lock", wt);
    expect(removeWorktree(main, wt)).toBe(false);
    expect(readFileSync(join(wt, ".claude/agent-memory/reviewer/notes.md"), "utf8")).toBe("keep me");
  });

  it("a real agent-memory directory in the worktree is work (notes written there, ignored or not), and so is any other untracked file", () => {
    const wt = add("l2");
    mkdirSync(join(wt, ".claude/agent-memory"));
    writeFileSync(join(wt, ".claude/agent-memory/n.md"), "x");
    expect(worktreeUnsafe(wt, later, main)).toMatch(/agent memory written inside it/);
    mkdirSync(join(wt, ".claude/agent-memory-local"));
    writeFileSync(join(wt, ".claude/agent-memory-local/n.md"), "x");
    expect(worktreeUnsafe(wt, later, main)).toMatch(/uncommitted or untracked/);
    const wt3 = add("l3");
    symlinkSync(join(main, ".claude/agent-memory"), join(wt3, ".claude/agent-memory"));
    writeFileSync(join(wt3, "new.txt"), "x");
    expect(worktreeUnsafe(wt3, later, main)).toMatch(/uncommitted or untracked/);
  });
});

describe("sapu-cleanup — stale remote branches: a closed PR's head, and a branch no PR names", () => {
  const remoteOnly = (name: string, tip = name) => ({ remotes: [{ name, tip }] });
  const closedPr = (over: Record<string, unknown> = {}) => ({ number: 40, oid: "t1", issues: [12], ...over });

  it("knows the issue a branch name carries, and the wip/ handoff names", () => {
    expect(branchIssues("fix/issue-12-x")).toEqual([12]);
    expect(branchIssues("wip/issue-7-handoff")).toEqual([7]);
    expect(branchIssues("worktree-wf_ab-3")).toEqual([]);
    expect("wip/issue-7-handoff").toMatch(SAPU_BRANCH);
  });

  it("deletes a closed PR's head only while the tip is still that head and its issues are closed (or a merged PR closes one)", () => {
    const f = (over: Record<string, unknown> = {}) => facts({ ...remoteOnly("fix/issue-12-a", "t1"), closed: { "fix/issue-12-a": closedPr() }, issues: { 12: "closed" }, ...over });
    const out = plan(f());
    expect(by(out)).toEqual({ "fix/issue-12-a": "delete: closed PR #40, issue #12 closed" });
    expect(out[0]).toMatchObject({ remote: true, local: false, tip: "t1" });
    // the issue was closed as not planned, or by a duplicate: still closed
    // the tip moved after the PR closed: later commits are in no PR
    expect(by(plan(f({ remotes: [{ name: "fix/issue-12-a", tip: "t2" }] })))).toEqual({ "fix/issue-12-a": "keep: not proven merged" });
    // the issue is open, and no merged PR closes it
    expect(by(plan(f({ issues: { 12: "open" } })))).toEqual({ "fix/issue-12-a": "keep: not proven merged" });
    // the issue is open but a merged PR closes it: the replacement landed
    expect(by(plan(f({ issues: { 12: "open" }, mergedIssues: new Set([12]) })))).toEqual({ "fix/issue-12-a": "delete: closed PR #40, a merged PR closes issue #12" });
    // an unknown issue state proves nothing
    expect(by(plan(f({ issues: {} })))).toEqual({ "fix/issue-12-a": "keep: not proven merged" });
    // never: an open PR's head, --keep
    expect(by(plan(f({ open: new Set(["fix/issue-12-a"]) })))).toEqual({ "fix/issue-12-a": "keep: open PR" });
    expect(by(plan({ ...f(), keep: ["fix/issue-12-a"] }))).toEqual({ "fix/issue-12-a": "keep: --keep" });
  });

  it("a closed PR's head with a local copy: both go when the tips agree; a differing local tip or a checked-out worktree keeps it", () => {
    const f = (over: Record<string, unknown> = {}) => facts({ branches: [{ name: "fix/issue-12-a", tip: "t1" }], ...remoteOnly("fix/issue-12-a", "t1"), closed: { "fix/issue-12-a": closedPr() }, issues: { 12: "closed" }, ...over });
    expect(plan(f())[0]).toMatchObject({ action: "delete", remote: true, local: true });
    expect(by(plan(f({ branches: [{ name: "fix/issue-12-a", tip: "t9" }] })))).toEqual({ "fix/issue-12-a": "keep: not proven merged" });
    expect(by(plan(f({ worktrees: { "fix/issue-12-a": "/wt/a" } })))).toEqual({ "fix/issue-12-a": "keep: checked out in worktree /wt/a" });
    // a clean, idle worktree does not make it deletable either: the issue says "locked or not"
    expect(by(plan(f({ worktrees: { "fix/issue-12-a": "/wt/a" }, unsafe: {} })))).toEqual({ "fix/issue-12-a": "keep: checked out in worktree /wt/a" });
  });

  it("deletes a branch no PR names when every commit but the handoff ones is found in the base and its issues are closed", () => {
    const f = (v: Record<string, unknown>, over: Record<string, unknown> = {}) => facts({ ...remoteOnly("wip/issue-9-handoff", "w1"), issues: { 9: "closed" }, covered: { "wip/issue-9-handoff": { matched: 2, unmatched: 0, handoff: 1, issues: [9], ...v } }, ...over });
    expect(by(plan(f({})))).toEqual({ "wip/issue-9-handoff": "delete: no PR, 2 commit(s) found in the base and 1 handoff, issue #9 closed" });
    expect(by(plan(f({ matched: 0, handoff: 3 })))).toEqual({ "wip/issue-9-handoff": "delete: no PR, 0 commit(s) found in the base and 3 handoff, issue #9 closed" });
    // one commit not in the base: report it, keep the branch
    expect(by(plan(f({ unmatched: 1 })))).toEqual({ "wip/issue-9-handoff": "keep: not proven merged" });
    // the issue is open, or no issue is named
    expect(by(plan(f({}, { issues: { 9: "open" } })))).toEqual({ "wip/issue-9-handoff": "keep: not proven merged" });
    expect(by(plan(f({ issues: [] })))).toEqual({ "wip/issue-9-handoff": "keep: not proven merged" });
    // a worktree has it checked out
    expect(by(plan(f({}, { worktrees: { "wip/issue-9-handoff": "/wt/w" } })))).toEqual({ "wip/issue-9-handoff": "keep: checked out in worktree /wt/w" });
    // an open PR uses it
    expect(by(plan(f({}, { open: new Set(["wip/issue-9-handoff"]) })))).toEqual({ "wip/issue-9-handoff": "keep: open PR" });
    // a workflow branch with only a PR-less handoff, its issue found in its commit messages
    expect(by(plan(facts({ ...remoteOnly("worktree-wf_ab-3", "w2"), issues: { 15: "closed" }, covered: { "worktree-wf_ab-3": { matched: 1, unmatched: 0, handoff: 1, issues: [15] } } })))).toEqual({ "worktree-wf_ab-3": "delete: no PR, 1 commit(s) found in the base and 1 handoff, issue #15 closed" });
  });

  it("lists a remote-only sapu branch it cannot prove, and says nothing of someone else's remote branch", () => {
    const out = plan(facts({ remotes: [{ name: "fix/issue-3-x", tip: "a" }, { name: "dependabot/npm/foo", tip: "b" }] }));
    expect(by(out)).toEqual({ "fix/issue-3-x": "keep: not proven merged" });
    expect(by(plan(facts({ remotes: [{ name: "dependabot/npm/foo", tip: "b" }], all: true, issues: {}, closed: {} })))).toEqual({ "dependabot/npm/foo": "keep: not proven merged" });
  });

  it("a local-only closed-PR branch is deleted locally, with no remote step", () => {
    const out = plan(facts({ branches: [{ name: "fix/issue-12-a", tip: "t1" }], closed: { "fix/issue-12-a": closedPr() }, issues: { 12: "closed" } }));
    expect(out[0]).toMatchObject({ action: "delete", remote: false, local: true });
  });
});

describe("sapu-cleanup — coverage and remotes on a real repository", () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "sapu-cleanup-cov-")));
  const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const origin = join(top, "origin.git");
  const main = join(top, "main");
  g(top, "init", "-q", "--bare", "-b", "main", origin);
  g(top, "clone", "-q", origin, main);
  const commit = (f: string, msg: string) => {
    writeFileSync(join(main, f), f);
    g(main, "add", f);
    g(main, "commit", "-q", "-m", msg);
  };
  commit("a", "initial commit of the repo");
  // the base after a squash merge: the PR's commit subjects are listed in the squash commit's body
  commit("s", "feat(hr): separation record (#41)\n\n* feat(hr): add the separation record table\n* test(hr): cover the separation record");
  g(main, "push", "-q", "origin", "HEAD:main");
  // the branch, from before the squash: handoff snapshots plus the PR's original commits
  g(main, "checkout", "-q", "-b", "wip/issue-9-handoff", "HEAD~1");
  commit("b1", "feat(hr): add the separation record table");
  commit("b2", "wip: handoff 1 (#9)");
  commit("b3", "test(hr): cover the separation record");
  commit("b4", "fix");
  g(main, "push", "-q", "origin", "wip/issue-9-handoff");
  g(main, "checkout", "-q", "main");
  g(main, "fetch", "-q", "origin");

  it("counts matched, handoff and unmatched commits; a short subject never matches", () => {
    const tip = g(main, "rev-parse", "wip/issue-9-handoff");
    const v = coverage(main, "main", tip);
    expect(v).toMatchObject({ matched: 2, handoff: 1, unmatched: 1 }); // "fix" is 3 characters: unmatched
    expect(v.refs).toEqual([9]);
    g(main, "checkout", "-q", "-b", "tmp", tip);
    g(main, "reset", "-q", "--hard", "HEAD~1"); // without the short-subject commit
    expect(coverage(main, "main", g(main, "rev-parse", "HEAD"))).toMatchObject({ matched: 2, handoff: 1, unmatched: 0 });
    g(main, "checkout", "-q", "main");
  });

  it("a commit absent from the base is unmatched, and a base-only tip has nothing to prove", () => {
    g(main, "checkout", "-q", "-b", "lone", "main");
    commit("z", "feat(hr): something never merged anywhere");
    expect(coverage(main, "main", g(main, "rev-parse", "lone"))).toMatchObject({ matched: 0, unmatched: 1, handoff: 0 });
    g(main, "checkout", "-q", "main");
    expect(coverage(main, "main", "main")).toMatchObject({ matched: 0, unmatched: 0, handoff: 0 });
  });

  it("gitFacts lists origin's branches except the base", () => {
    const f = gitFacts(main, "main", [], Date.now());
    expect(f.remotes.map((b: { name: string }) => b.name).sort()).toEqual(["wip/issue-9-handoff"]);
  });
});

describe("sapu-cleanup — carrying out a remote deletion on a real origin", () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "sapu-cleanup-del-")));
  const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const origin = join(top, "origin.git");
  const main = join(top, "main");
  g(top, "init", "-q", "--bare", "-b", "main", origin);
  g(top, "clone", "-q", origin, main);
  const commit = (f: string, msg: string) => {
    writeFileSync(join(main, f), f);
    g(main, "add", f);
    g(main, "commit", "-q", "-m", msg);
  };
  commit("a", "initial commit of the repo");
  g(main, "push", "-q", "origin", "HEAD:main");
  for (const b of ["fix/issue-12-old", "wip/issue-9-handoff"]) {
    g(main, "checkout", "-q", "-b", b, "main");
    commit(b.replace("/", "_"), `wip: handoff snapshot for ${b}`);
    g(main, "push", "-q", "origin", b);
  }
  g(main, "checkout", "-q", "main");
  const onOrigin = (b: string) => g(main, "ls-remote", "--heads", "origin", b) !== "";
  const logged = (steps: unknown[], apply: boolean) => {
    const lines: string[] = [];
    const r = carryOut(main, steps, apply, (l: string) => lines.push(l));
    return { ...r, lines };
  };
  const stale = () => {
    g(main, "fetch", "-q", "--prune", "origin");
    const f = gitFacts(main, "main", [], Date.now());
    const tip = (b: string) => f.remotes.find((r: { name: string }) => r.name === b).tip;
    return plan({ ...f, open: new Set(), base: "main", closed: { "fix/issue-12-old": { number: 40, oid: tip("fix/issue-12-old"), issues: [12] } }, issues: { 12: "closed", 9: "closed" }, covered: { "wip/issue-9-handoff": { matched: 0, unmatched: 0, handoff: 1, issues: [9] } } });
  };

  it("the plan alone (no --apply) deletes nothing and names each proof", () => {
    const steps = stale();
    expect(by(steps)).toEqual({ "fix/issue-12-old": "delete: closed PR #40, issue #12 closed", "wip/issue-9-handoff": "delete: no PR, 0 commit(s) found in the base and 1 handoff, issue #9 closed" });
    const r = logged(steps, false);
    expect(r.lines).toEqual(["DELETE origin/fix/issue-12-old + local — closed PR #40, issue #12 closed", "DELETE origin/wip/issue-9-handoff + local — no PR, 0 commit(s) found in the base and 1 handoff, issue #9 closed"]);
    expect(r.deleted).toBe(0);
    expect(onOrigin("fix/issue-12-old") && onOrigin("wip/issue-9-handoff")).toBe(true);
  });

  it("--apply deletes the remote branch, keeps its tip under refs/sapu-trash, and the branch can be pushed back", () => {
    const tip = g(main, "rev-parse", "origin/fix/issue-12-old");
    const r = logged(stale(), true);
    expect(r.deleted).toBe(2);
    expect(onOrigin("fix/issue-12-old") || onOrigin("wip/issue-9-handoff")).toBe(false);
    expect(g(main, "rev-parse", "refs/sapu-trash/fix/issue-12-old")).toBe(tip);
    expect(g(main, "branch", "--list", "fix/issue-12-old")).toBe(""); // the local copy went with it
    g(main, "push", "-q", "origin", "refs/sapu-trash/fix/issue-12-old:refs/heads/fix/issue-12-old");
    expect(onOrigin("fix/issue-12-old")).toBe(true);
  });

  it("a remote deletion git refuses is reported and counted as kept", () => {
    const lines: string[] = [];
    const r = carryOut(main, [{ branch: "fix/issue-404-gone", action: "delete", why: "x", worktree: "", remote: true, local: false, tip: g(main, "rev-parse", "HEAD") }], true, (l: string) => lines.push(l));
    expect(r.deleted).toBe(0);
    expect(lines).toEqual(["KEEP   fix/issue-404-gone — git push origin --delete failed"]);
  });
});
