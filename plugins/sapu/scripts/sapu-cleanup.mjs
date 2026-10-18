#!/usr/bin/env node
// sapu-cleanup.mjs — deletes sapu's own local branches whose every commit is PROVEN merged, with their
// clean worktrees. The orchestrator runs it per the repo's policy `cleanup` (set once in /sapu:init).
//
// Squash merges make `git branch --merged` useless. A branch counts as merged only when its tip is in
// origin/<base>, or its tip IS, or is an ancestor of, the head commit of a PR merged into <base>: then
// no commit of the branch is missing from what was merged. Nothing weaker counts (a merged PR of the
// same name, a closed issue): a reused name, a later local commit or a second attempt would be lost.
// Every deleted branch keeps its tip under refs/sapu-trash/<branch> (hidden from `git branch`), so
// even a wrong merge record loses nothing — for TRASH_DAYS: --apply then deletes the older trash refs
// (saved when their reflog says; one with no reflog, from before 2.26, by its tip's commit date). No origin/<base> stops the script before any plan.
// Two more classes pile up on the remote, because no merged PR ever names them, and are deleted (the
// remote branch, and a local copy with the same tip) only with a proof of their own:
//   - a CLOSED, unmerged PR's head (a superseded attempt): the branch tip is still the PR's head, and
//     every issue the PR or the branch name links is closed, or a merged PR closes one of them;
//   - a branch with no PR (a `wip: handoff` snapshot, a workflow branch): every commit in
//     origin/<base>..tip other than a `wip: handoff` one has its subject in a commit message of
//     origin/<base> (a squash merge leaves no ancestor), and the issues it names are all closed.
// Neither is deleted while any worktree has the branch checked out, while the local and remote tips
// differ, or while one commit is unmatched; the tip is saved under refs/sapu-trash first, so
// `git push origin refs/sapu-trash/<branch>:refs/heads/<branch>` brings a remote branch back.
//
// Never touched: the base, the main checkout's branch, an open PR's head, a --keep name, a branch
// outside sapu's own names (`<type>/issue-<N>-…`, `worktree-wf_*`, `worktree-agent-*`, `sapu-*`;
// --all lifts this) unless it is checked out in an agent worktree (under <MAIN>/.claude/worktrees/).
// A DETACHED agent worktree goes too when its HEAD is in origin/<base> or a merged PR's head (nothing
// of it is lost) and it passes the same safety checks. A worktree is removed only when it has no uncommitted or untracked change, no
// ignored env file, no agent memory written inside it, is not this process's cwd and saw no git
// activity for an hour; else the branch stays too. The agent-memory link Claude Code puts in a worktree
// (MEMORY_LINKS) is not a change: only the link is removed, never the main checkout's memory behind
// it. Policy `cleanup: "never"` refuses to run.
//
// USAGE (from the main checkout or any of its worktrees):
//   node sapu-cleanup.mjs [--apply] [--all] [--branches-only] [--keep <branch>]...
// --branches-only removes no worktree and keeps any branch checked out in one: sapu-merge.sh runs it so after
// every merge, while other lanes may still be using their worktrees.
// Without --apply it changes no branch or worktree (it still fetches with --prune and prunes stale
// worktree records) and prints the plan. Last line: `🧹 branches: N deleted, M kept; worktrees: X removed; trash: T expired (older than 14 days)`.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { findMain, loadContract, lockProblems, resolvePolicy } from "./sapu-contract.mjs";

export const SAPU_BRANCH = /^((feat|fix|perf|refactor|chore|docs|test|ci|build|style|wip)\/issue-\d+|worktree-(wf_|agent-)|sapu-)/;
const ACTIVE_MS = 60 * 60 * 1000;
export const TRASH_DAYS = 14;
const HANDOFF = /^wip: handoff/;
const MIN_SUBJECT = 12; // a shorter subject ("fix") would match almost any base commit

/** The issue a branch name carries: `<type>/issue-<N>-…`. */
export const branchIssues = (name) => {
  const m = /\/issue-(\d+)/.exec(name);
  return m ? [Number(m[1])] : [];
};

const issueList = (ns) => `issue${ns.length > 1 ? "s" : ""} ${ns.map((n) => "#" + n).join(", ")}`;

/**
 * The network-backed proof for a branch no merged PR covers, or null: its closed PR (the tip is still that
 * PR's head; its issues closed, or one closed by a merged PR), else its commits all found in the base.
 */
function extraProof({ name, tip, closed, mergedIssues, issues, covered }) {
  const done = (n) => issues[n] === "closed";
  const c = closed[name];
  if (c && c.oid === tip) {
    const linked = [...new Set([...c.issues, ...branchIssues(name)])];
    if (linked.length && linked.every(done)) return `closed PR #${c.number}, ${issueList(linked)} closed`;
    const twin = linked.find((n) => mergedIssues.has(n));
    if (twin !== undefined) return `closed PR #${c.number}, a merged PR closes issue #${twin}`;
  }
  const v = covered[name];
  if (v && v.unmatched === 0 && v.issues.length && v.issues.every(done)) return `no PR, ${v.matched} commit(s) found in the base${v.handoff ? ` and ${v.handoff} handoff` : ""}, ${issueList(v.issues)} closed`;
  return null;
}

/**
 * The plan, from facts only (no git, no gh): [{ branch, action: "delete"|"keep", why, worktree }].
 * @param {object} f
 * @param {{name: string, tip: string}[]} f.branches local branches
 * @param {Record<string, string>} f.worktrees branch → worktree path (the main checkout excluded)
 * @param {Record<string, string>} f.unsafe worktree path → why it must stay (dirty, env file, active, cwd)
 * @param {Set<string>} f.inBase branch names whose tip is in origin/<base>
 * @param {Set<string>} f.reach commits that are, or are ancestors of, heads of PRs merged into <base>
 * @param {Set<string>} f.open heads of open PRs
 * @param {{name: string, tip: string}[]} [f.remotes] origin's branches (the base excluded)
 * @param {Record<string, {number: number, oid: string, issues: number[]}>} [f.closed] closed, unmerged PRs by head branch
 * @param {Set<number>} [f.mergedIssues] issues a merged PR closes
 * @param {Record<number, "open"|"closed">} [f.issues] issue states
 * @param {Record<string, {matched: number, unmatched: number, handoff: number, issues: number[]}>} [f.covered] commit proofs
 * @param {Set<string>} [f.owned] branches checked out in an agent worktree (<MAIN>/.claude/worktrees/): sapu's or Claude's own, whatever the name
 * @param {{worktree: string, head: string}[]} [f.detached] detached agent worktrees
 * @param {Set<string>} [f.headsInBase] detached heads that are in origin/<base>
 */
export function plan({ branches, remotes = [], worktrees, unsafe, inBase, reach, open, base, mainBranch, keep = [], all = false, closed = {}, mergedIssues = new Set(), issues = {}, covered = {}, owned = new Set(), detached = [], headsInBase = new Set() }) {
  const out = [];
  for (const { worktree, head } of detached) {
    const proof = headsInBase.has(head) ? `HEAD in ${base}` : reach.has(head) ? "HEAD is in a PR merged into " + base : null;
    const branch = `(detached) ${worktree}`;
    if (!proof) out.push({ branch, action: "keep", why: "HEAD not proven merged", worktree });
    else if (unsafe[worktree]) out.push({ branch, action: "keep", why: `worktree ${unsafe[worktree]}`, worktree });
    else out.push({ branch, action: "delete", why: proof, worktree, detached: true });
  }
  const local = new Map(branches.map((b) => [b.name, b.tip]));
  const remote = new Map(remotes.map((b) => [b.name, b.tip]));
  for (const name of new Set([...local.keys(), ...remote.keys()])) {
    if (name === base || name === mainBranch) continue;
    const L = local.get(name) ?? null;
    const R = remote.get(name) ?? null;
    const worktree = worktrees[name] || "";
    const keepIt = (why) => out.push({ branch: name, action: "keep", why, worktree });
    if (keep.includes(name)) keepIt("--keep");
    else if (!all && !SAPU_BRANCH.test(name) && !owned.has(name)) {
      if (L) keepIt("not a sapu branch (--all to include)"); // a remote-only branch of someone else is not listed
    } else if (open.has(name)) keepIt("open PR");
    else {
      const proof = L && (inBase.has(name) ? `in ${base}` : reach.has(L) ? "every commit is in a PR merged into " + base : null);
      if (proof) {
        if (worktree && unsafe[worktree]) keepIt(`its worktree ${unsafe[worktree]} (${worktree})`);
        else out.push({ branch: name, action: "delete", why: proof, worktree });
        continue;
      }
      const tip = R ?? L;
      const why = L && R && L !== R ? null : extraProof({ name, tip, closed, mergedIssues, issues, covered });
      if (!why) keepIt("not proven merged");
      else if (worktree) keepIt(`checked out in worktree ${worktree}`);
      else out.push({ branch: name, action: "delete", why, worktree: "", remote: R !== null, local: L !== null, tip });
    }
  }
  return out;
}

// GIT_OPTIONAL_LOCKS=0: our own `git status` must not refresh an index and look like activity
const run = (cmd, args, cwd, input) => execFileSync(cmd, args, { cwd, encoding: "utf8", input, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], maxBuffer: 64 << 20 }).trim();
const tryRun = (...a) => {
  try {
    return run(...a);
  } catch {
    return null;
  }
};

/**
 * Where Claude Code links <MAIN>'s agent memory into a new worktree (`worktree.symlinkDirectories`,
 * written by /sapu:init). The link holds no work of its own: removing the worktree removes only it.
 */
export const MEMORY_LINKS = [".claude/agent-memory", ".claude/agent-memory-local"];
const isLink = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
/** The untracked memory links of a worktree (a tracked path is the repo's, never touched). */
const memoryLinks = (wt) => MEMORY_LINKS.map((d) => path.join(wt, d)).filter((p) => isLink(p) && tryRun("git", ["-C", wt, "ls-files", "--", path.relative(wt, p)], wt) === "");

/** Why a worktree must stay, or "": changes, an ignored env file, agent memory written in it, this process's cwd, recent git activity. */
export function worktreeUnsafe(wt, now = Date.now(), cwd = process.cwd()) {
  const rel = path.relative(wt, fs.realpathSync(cwd));
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return "is this process's working directory";
  const status = tryRun("git", ["-C", wt, "status", "--porcelain", "--ignored", "--untracked-files=all"], wt);
  if (status === null) return "could not be read";
  // A memory link a repo does not ignore shows as untracked; it is not work.
  const lines = status.split("\n").filter((l) => l && !(l.startsWith("?? ") && MEMORY_LINKS.includes(l.slice(3)) && isLink(path.join(wt, l.slice(3)))));
  if (lines.some((l) => !l.startsWith("!!"))) return "has uncommitted or untracked changes";
  if (lines.some((l) => /(^|\/)\.env[^/]*$/.test(l.slice(3).replace(/\/$/, "")))) return "holds an ignored env file";
  // A real memory directory (no link) in the worktree holds notes written there, often ignored: they would be lost.
  if (lines.some((l) => MEMORY_LINKS.some((d) => l.slice(3).startsWith(d + "/")))) return "holds agent memory written inside it (move it to the main checkout's)";
  const gitDir = tryRun("git", ["-C", wt, "rev-parse", "--absolute-git-dir"], wt);
  const touched = gitDir ? Math.max(...["index", "HEAD", "logs/HEAD"].map((f) => { try { return fs.statSync(path.join(gitDir, f)).mtimeMs; } catch { return 0; } })) : now;
  if (now - touched < ACTIVE_MS) return "saw git activity in the last hour (a session may still use it)";
  return "";
}

/**
 * `git worktree remove` for a worktree worktreeUnsafe passed: its untracked memory links go first (git
 * counts them as untracked files and refuses), and come back when git still refuses (a lock).
 */
export function removeWorktree(main, wt) {
  const links = memoryLinks(wt).map((p) => ({ p, to: fs.readlinkSync(p) }));
  for (const { p } of links) fs.unlinkSync(p);
  if (tryRun("git", ["-C", main, "worktree", "remove", wt], main) !== null) return true;
  for (const { p, to } of links) if (!isLink(p)) fs.symlinkSync(to, p);
  return false;
}

/** The git facts of `main` (a checkout whose origin/<base> is fresh), given the heads of PRs merged into <base>. */
export function gitFacts(main, base, mergedOids, now = Date.now()) {
  // no origin/<base> (a renamed base, a stale contract) proves nothing: stop before any plan
  if (tryRun("git", ["-C", main, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`], main) === null) throw new Error(`origin/${base} does not exist: fix baseBranch in the contract or fetch it`);
  const branches = run("git", ["-C", main, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"], main)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [name, tip] = l.split(" ");
      return { name, tip };
    });
  const worktrees = {};
  const unsafe = {};
  const owned = new Set();
  const detached = [];
  const agentDir = path.join(main, ".claude", "worktrees") + path.sep;
  let cur = null;
  let head = null;
  for (const l of run("git", ["-C", main, "worktree", "list", "--porcelain"], main).split("\n")) {
    if (l.startsWith("worktree ")) cur = l.slice(9);
    if (l.startsWith("HEAD ")) head = l.slice(5);
    if (cur === main) continue;
    if (l.startsWith("branch refs/heads/")) {
      worktrees[l.slice(18)] = cur;
      if (cur.startsWith(agentDir)) owned.add(l.slice(18));
      const why = worktreeUnsafe(cur, now);
      if (why) unsafe[cur] = why;
    }
    if (l === "detached" && cur.startsWith(agentDir)) {
      detached.push({ worktree: cur, head });
      const why = worktreeUnsafe(cur, now);
      if (why) unsafe[cur] = why;
    }
  }
  // one rev-list for all branches and detached heads: those reachable from origin/<base>
  const tips = new Set([...branches.map((b) => b.tip), ...detached.map((d) => d.head)]);
  const notInBase = new Set(run("git", ["-C", main, "rev-list", "--stdin", `^origin/${base}`], main, [...tips].join("\n") + "\n").split("\n").filter(Boolean));
  const inBase = new Set(branches.filter((b) => !notInBase.has(b.tip)).map((b) => b.name));
  const headsInBase = new Set(detached.map((d) => d.head).filter((h) => !notInBase.has(h)));
  const local = (tryRun("git", ["-C", main, "cat-file", "--batch-check=%(objectname) %(objecttype)"], main, mergedOids.join("\n") + "\n") || "")
    .split("\n")
    .filter((l) => l.endsWith(" commit"))
    .map((l) => l.split(" ")[0]);
  const reach = new Set(local.length ? (tryRun("git", ["-C", main, "rev-list", "--stdin"], main, local.join("\n") + "\n") || "").split("\n").filter(Boolean) : []);
  const mainBranch = tryRun("git", ["-C", main, "symbolic-ref", "--short", "HEAD"], main) || "";
  const remotes = run("git", ["-C", main, "for-each-ref", "--format=%(refname:lstrip=3) %(objectname)", "refs/remotes/origin"], main)
    .split("\n")
    .filter((l) => l && !l.startsWith("HEAD "))
    .map((l) => {
      const [name, tip] = l.split(" ");
      return { name, tip };
    })
    .filter((b) => b.name !== base);
  return { branches, remotes, worktrees, unsafe, inBase, reach, mainBranch, owned, detached, headsInBase };
}

/**
 * Whether a branch's commits are all in the base though none is an ancestor (a squash merge): its non-merge
 * commits in origin/<base>..<tip>, `wip: handoff` ones counted apart, each other subject (at least
 * MIN_SUBJECT characters) searched, as a fixed string, in the commit messages of origin/<base>. `refs` are
 * the `#N` numbers its commit messages carry.
 */
export function coverage(main, base, tip) {
  const range = `origin/${base}..${tip}`;
  const subjects = (tryRun("git", ["-C", main, "log", "--no-merges", "--format=%s", range], main) || "").split("\n").filter(Boolean);
  let matched = 0;
  let unmatched = 0;
  let handoff = 0;
  for (const subject of subjects) {
    if (HANDOFF.test(subject)) handoff++;
    else if (subject.length >= MIN_SUBJECT && tryRun("git", ["-C", main, "log", `origin/${base}`, "--fixed-strings", `--grep=${subject}`, "--max-count=1", "--format=%H"], main)) matched++;
    else unmatched++;
  }
  const body = tryRun("git", ["-C", main, "log", "--no-merges", "--format=%B", range], main) || "";
  const refs = [...new Set([...body.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))];
  return { matched, unmatched, handoff, refs };
}

/** The refs/sapu-trash refs saved more than `days` ago: by their reflog's date, else (no reflog) their tip's commit date. */
export function expiredTrash(main, now = Date.now(), days = TRASH_DAYS) {
  const refs = (tryRun("git", ["-C", main, "for-each-ref", "--format=%(refname) %(committerdate:unix)", "refs/sapu-trash"], main) || "").split("\n").filter(Boolean);
  return refs
    .map((l) => l.split(" "))
    .filter(([ref, committed]) => {
      const saved = /@\{(\d+)\}/.exec(tryRun("git", ["-C", main, "reflog", "show", "--date=unix", "--format=%gd", "-n", "1", ref], main) || "");
      return now - Number(saved ? saved[1] : committed) * 1000 > days * 86_400_000;
    })
    .map(([ref]) => ref);
}

/** --branches-only (after each merge, while other lanes may still use their worktrees): no worktree is removed, nor the branch checked out in it. */
export const branchesOnlySteps = (steps) =>
  steps.filter((s) => !s.detached).map((s) => (s.action === "delete" && s.worktree ? { ...s, action: "keep", why: `checked out in worktree ${s.worktree} (--branches-only)` } : s));

/** --apply, --all, --keep <b> / --keep=<b>; anything else is an error. */
export function parseArgs(argv) {
  const o = { apply: false, all: false, keep: [], branchesOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") o.apply = true;
    else if (a === "--all") o.all = true;
    else if (a === "--branches-only") o.branchesOnly = true;
    else if (a === "--keep" && argv[i + 1]) o.keep.push(argv[++i]);
    else if (a.startsWith("--keep=") && a.length > 7) o.keep.push(a.slice(7));
    else throw new Error(`unknown argument "${a}" (usage: [--apply] [--all] [--branches-only] [--keep <branch>]...)`);
  }
  return o;
}

/**
 * Prints each step and, with `apply`, carries it out: the tip goes to refs/sapu-trash first, then the
 * worktree, the remote branch (`git push origin --delete`) and the local branch go. Returns the counts.
 */
export function carryOut(MAIN, steps, apply, log = console.log) {
  let deleted = 0;
  let removed = 0;
  const label = (st) => (st.remote ? `origin/${st.branch}${st.local ? " + local" : ""}` : st.branch);
  for (const s of steps) {
    if (s.action === "keep") {
      log(`KEEP   ${s.branch} — ${s.why}`);
      continue;
    }
    if (s.detached) {
      // its HEAD is in the base: nothing to save
      if (!apply) log(`DELETE ${s.branch} — ${s.why}`);
      else if (removeWorktree(MAIN, s.worktree)) {
        removed++;
        log(`DELETE ${s.branch} — ${s.why}`);
      } else log(`KEEP   ${s.branch} — could not be removed`);
      continue;
    }
    if (!apply) {
      log(`DELETE ${label(s)} — ${s.why}${s.worktree ? ` (+ worktree ${s.worktree})` : ""}`);
      continue;
    }
    // every deleted tip is kept: `git branch <name> refs/sapu-trash/<name>` restores it
    if (tryRun("git", ["-C", MAIN, "update-ref", "--create-reflog", `refs/sapu-trash/${s.branch}`, s.tip || `refs/heads/${s.branch}`], MAIN) === null) {
      log(`KEEP   ${s.branch} — could not save its tip to refs/sapu-trash`);
      continue;
    }
    if (s.remote && tryRun("git", ["-C", MAIN, "push", "-q", "origin", "--delete", s.branch], MAIN) === null) {
      log(`KEEP   ${s.branch} — git push origin --delete failed`);
      continue;
    }
    if (s.worktree) {
      if (!removeWorktree(MAIN, s.worktree)) {
        log(`KEEP   ${s.branch} — its worktree could not be removed (${s.worktree})`);
        continue;
      }
      removed++;
    }
    if (s.remote && !s.local) {
      deleted++;
      log(`DELETE ${label(s)} — ${s.why}`);
    } else if (tryRun("git", ["-C", MAIN, "branch", "-D", s.branch], MAIN) === null) log(`KEEP   ${s.branch} — git branch -D failed`);
    else {
      deleted++;
      log(`DELETE ${label(s)} — ${s.why}`);
    }
  }
  return { deleted, removed };
}

function main(argv) {
  const { apply, all, keep, branchesOnly } = parseArgs(argv);
  const MAIN = findMain(process.cwd());
  const { contract: c, error } = loadContract(MAIN);
  if (!c) throw new Error(`no usable sapu contract: ${error}`);
  if (resolvePolicy(c).cleanup === "never") throw new Error('policy cleanup is "never" in this repo: nothing to do (/sapu:init changes it)');
  const lock = lockProblems(MAIN, c);
  if (lock.length) throw new Error(`scope lock: ${lock.join("; ")}`);
  const base = c.baseBranch;
  run("git", ["-C", MAIN, "fetch", "--prune", "-q", "origin"], MAIN);
  run("git", ["-C", MAIN, "worktree", "prune"], MAIN);
  const gh = (...a) => JSON.parse(run("gh", [...a, "--repo", c.repo], MAIN) || "[]");
  const merged = gh("pr", "list", "--state", "merged", "--base", base, "--limit", "1000", "--json", "headRefOid");
  const open = new Set(gh("pr", "list", "--state", "open", "--limit", "1000", "--json", "headRefName").map((p) => p.headRefName));
  const facts = gitFacts(MAIN, base, merged.map((p) => p.headRefOid));
  // the network proofs: closed, unmerged PRs; issues closed by a merged PR; every issue's state; commits found in the base
  const closed = {};
  for (const p of gh("pr", "list", "--state", "closed", "--limit", "1000", "--json", "number,headRefName,headRefOid,mergedAt,closingIssuesReferences")) {
    if (!p.mergedAt && (!closed[p.headRefName] || closed[p.headRefName].number < p.number)) closed[p.headRefName] = { number: p.number, oid: p.headRefOid, issues: (p.closingIssuesReferences || []).map((i) => i.number) };
  }
  const mergedIssues = new Set(gh("pr", "list", "--state", "merged", "--base", base, "--limit", "1000", "--json", "closingIssuesReferences").flatMap((p) => (p.closingIssuesReferences || []).map((i) => i.number)));
  const issues = Object.fromEntries(gh("issue", "list", "--state", "all", "--limit", "1000", "--json", "number,state").map((i) => [i.number, i.state === "CLOSED" ? "closed" : "open"]));
  const covered = {};
  const tips = new Map([...facts.branches, ...facts.remotes].map((b) => [b.name, b.tip]));
  for (const [name, tip] of tips) {
    if (name === base || name === facts.mainBranch || open.has(name) || (!all && !SAPU_BRANCH.test(name) && !facts.owned.has(name)) || facts.inBase.has(name) || facts.reach.has(tip)) continue;
    const v = coverage(MAIN, base, tip);
    // the issue a branch names; else the issues its commit messages mention (a PR number is no issue: it is not in `issues`)
    const named = branchIssues(name);
    covered[name] = { ...v, issues: named.length ? named : v.refs.filter((n) => n in issues) };
  }
  const all_ = plan({ ...facts, open, base, keep, all, closed, mergedIssues, issues, covered });
  const steps = branchesOnly ? branchesOnlySteps(all_) : all_;
  const { deleted, removed } = carryOut(MAIN, steps, apply);
  // the trash is a safety net, not an archive: its refs keep their commits alive
  const expired = expiredTrash(MAIN);
  if (apply && expired.length && tryRun("git", ["-C", MAIN, "update-ref", "--stdin"], MAIN, expired.map((r) => `delete ${r}\n`).join("")) === null) expired.length = 0;
  const planned = steps.filter((s) => s.action === "delete" && !s.detached);
  const n = apply ? deleted : planned.length;
  const w = apply ? removed : steps.filter((s) => s.action === "delete" && s.worktree).length;
  const kept = steps.filter((s) => s.action === "keep" && !s.branch.startsWith("(detached)")).length + (apply ? planned.length - deleted : 0);
  console.log(`🧹 branches: ${n} ${apply ? "deleted" : "would be deleted (dry run, --apply to do it)"}, ${kept} kept; worktrees: ${w} ${apply ? "removed" : "would be removed"}; trash: ${expired.length} ${apply ? "expired" : "would expire"} (older than ${TRASH_DAYS} days)`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`sapu-cleanup: ${e.message}\n`);
    process.exit(1);
  }
}
