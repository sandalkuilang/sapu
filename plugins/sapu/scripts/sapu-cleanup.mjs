#!/usr/bin/env node
// sapu-cleanup.mjs — deletes sapu's own local branches whose every commit is PROVEN merged, with their
// clean worktrees. The orchestrator runs it per the repo's policy `cleanup` (set once in /sapu:init).
//
// Squash merges make `git branch --merged` useless. A branch counts as merged only when its tip is in
// origin/<base>, or its tip IS, or is an ancestor of, the head commit of a PR merged into <base>: then
// no commit of the branch is missing from what was merged. Nothing weaker counts (a merged PR of the
// same name, a closed issue): a reused name, a later local commit or a second attempt would be lost.
// A deleted branch that is not in the base keeps its tip under refs/sapu-trash/<branch> (hidden from
// `git branch`), so even a wrong merge record loses nothing.
// Never touched: the base, the main checkout's branch, an open PR's head, a --keep name, a branch
// outside sapu's own names (`<type>/issue-<N>-…`, `worktree-wf_*`, `worktree-agent-*`, `sapu-*`;
// --all lifts this). A worktree is removed only when it has no uncommitted or untracked change, no
// ignored env file, is not this process's cwd and saw no git activity for an hour; else the branch
// stays too. Policy `cleanup: "never"` refuses to run.
//
// USAGE (from the main checkout or any of its worktrees):
//   node sapu-cleanup.mjs [--apply] [--all] [--keep <branch>]...
// Without --apply it changes no branch or worktree (it still fetches with --prune and prunes stale
// worktree records) and prints the plan. Last line: `🧹 branches: N deleted, M kept; worktrees: X removed`.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { findMain, loadContract, lockProblems, resolvePolicy } from "./sapu-contract.mjs";

export const SAPU_BRANCH = /^((feat|fix|perf|refactor|chore|docs|test|ci|build|style)\/issue-\d+|worktree-(wf_|agent-)|sapu-)/;
const ACTIVE_MS = 60 * 60 * 1000;

/**
 * The plan, from facts only (no git, no gh): [{ branch, action: "delete"|"keep", why, worktree }].
 * @param {object} f
 * @param {{name: string, tip: string}[]} f.branches local branches
 * @param {Record<string, string>} f.worktrees branch → worktree path (the main checkout excluded)
 * @param {Record<string, string>} f.unsafe worktree path → why it must stay (dirty, env file, active, cwd)
 * @param {Set<string>} f.inBase branch names whose tip is in origin/<base>
 * @param {Set<string>} f.reach commits that are, or are ancestors of, heads of PRs merged into <base>
 * @param {Set<string>} f.open heads of open PRs
 */
export function plan({ branches, worktrees, unsafe, inBase, reach, open, base, mainBranch, keep = [], all = false }) {
  const out = [];
  for (const { name, tip } of branches) {
    if (name === base || name === mainBranch) continue;
    const worktree = worktrees[name] || "";
    const keepIt = (why) => out.push({ branch: name, action: "keep", why, worktree });
    if (keep.includes(name)) keepIt("--keep");
    else if (!all && !SAPU_BRANCH.test(name)) keepIt("not a sapu branch (--all to include)");
    else if (open.has(name)) keepIt("open PR");
    else {
      const proof = inBase.has(name) ? `in ${base}` : reach.has(tip) ? "every commit is in a PR merged into " + base : null;
      if (!proof) keepIt("not proven merged");
      else if (worktree && unsafe[worktree]) keepIt(`its worktree ${unsafe[worktree]} (${worktree})`);
      else out.push({ branch: name, action: "delete", why: proof, worktree });
    }
  }
  return out;
}

const run = (cmd, args, cwd, input) => execFileSync(cmd, args, { cwd, encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], maxBuffer: 64 << 20 }).trim();
const tryRun = (...a) => {
  try {
    return run(...a);
  } catch {
    return null;
  }
};

/** Why a worktree must stay, or "": changes, an ignored env file, this process's cwd, recent git activity. */
export function worktreeUnsafe(wt, now = Date.now(), cwd = process.cwd()) {
  const rel = path.relative(wt, fs.realpathSync(cwd));
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return "is this process's working directory";
  const status = tryRun("git", ["-C", wt, "status", "--porcelain", "--ignored", "--untracked-files=all"], wt);
  if (status === null) return "could not be read";
  const lines = status.split("\n").filter(Boolean);
  if (lines.some((l) => !l.startsWith("!!"))) return "has uncommitted or untracked changes";
  if (lines.some((l) => /(^|\/)\.env[^/]*$/.test(l.slice(3).replace(/\/$/, "")))) return "holds an ignored env file";
  const gitDir = tryRun("git", ["-C", wt, "rev-parse", "--absolute-git-dir"], wt);
  const touched = gitDir ? Math.max(...["index", "HEAD", "logs/HEAD"].map((f) => { try { return fs.statSync(path.join(gitDir, f)).mtimeMs; } catch { return 0; } })) : now;
  if (now - touched < ACTIVE_MS) return "saw git activity in the last hour (a session may still use it)";
  return "";
}

/** The git facts of `main` (a checkout whose origin/<base> is fresh), given the heads of PRs merged into <base>. */
export function gitFacts(main, base, mergedOids, now = Date.now()) {
  const branches = run("git", ["-C", main, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"], main)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [name, tip] = l.split(" ");
      return { name, tip };
    });
  const worktrees = {};
  const unsafe = {};
  let cur = null;
  for (const l of run("git", ["-C", main, "worktree", "list", "--porcelain"], main).split("\n")) {
    if (l.startsWith("worktree ")) cur = l.slice(9);
    if (l.startsWith("branch refs/heads/") && cur !== main) {
      worktrees[l.slice(18)] = cur;
      const why = worktreeUnsafe(cur, now);
      if (why) unsafe[cur] = why;
    }
  }
  // one rev-list for all branches: those reachable from origin/<base>
  const tips = new Set(branches.map((b) => b.tip));
  const notInBase = new Set((tryRun("git", ["-C", main, "rev-list", "--stdin", `^origin/${base}`], main, [...tips].join("\n") + "\n") || "").split("\n").filter(Boolean));
  const inBase = new Set(branches.filter((b) => !notInBase.has(b.tip)).map((b) => b.name));
  const local = (tryRun("git", ["-C", main, "cat-file", "--batch-check=%(objectname) %(objecttype)"], main, mergedOids.join("\n") + "\n") || "")
    .split("\n")
    .filter((l) => l.endsWith(" commit"))
    .map((l) => l.split(" ")[0]);
  const reach = new Set(local.length ? (tryRun("git", ["-C", main, "rev-list", "--stdin"], main, local.join("\n") + "\n") || "").split("\n").filter(Boolean) : []);
  const mainBranch = tryRun("git", ["-C", main, "symbolic-ref", "--short", "HEAD"], main) || "";
  return { branches, worktrees, unsafe, inBase, reach, mainBranch };
}

/** --apply, --all, --keep <b> / --keep=<b>; anything else is an error. */
export function parseArgs(argv) {
  const o = { apply: false, all: false, keep: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") o.apply = true;
    else if (a === "--all") o.all = true;
    else if (a === "--keep" && argv[i + 1]) o.keep.push(argv[++i]);
    else if (a.startsWith("--keep=") && a.length > 7) o.keep.push(a.slice(7));
    else throw new Error(`unknown argument "${a}" (usage: [--apply] [--all] [--keep <branch>]...)`);
  }
  return o;
}

function main(argv) {
  const { apply, all, keep } = parseArgs(argv);
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
  const steps = plan({ ...facts, open, base, keep, all });
  let deleted = 0;
  let removed = 0;
  for (const s of steps) {
    if (s.action === "keep") {
      console.log(`KEEP   ${s.branch} — ${s.why}`);
      continue;
    }
    if (!apply) {
      console.log(`DELETE ${s.branch} — ${s.why}${s.worktree ? ` (+ worktree ${s.worktree})` : ""}`);
      continue;
    }
    // anything not already in the base keeps its tip: `git branch <name> refs/sapu-trash/<name>` restores it
    if (!s.why.startsWith("in ") && tryRun("git", ["-C", MAIN, "update-ref", `refs/sapu-trash/${s.branch}`, `refs/heads/${s.branch}`], MAIN) === null) {
      console.log(`KEEP   ${s.branch} — could not save its tip to refs/sapu-trash`);
      continue;
    }
    if (s.worktree) {
      if (tryRun("git", ["-C", MAIN, "worktree", "remove", s.worktree], MAIN) === null) {
        console.log(`KEEP   ${s.branch} — its worktree could not be removed (${s.worktree})`);
        continue;
      }
      removed++;
    }
    if (tryRun("git", ["-C", MAIN, "branch", "-D", s.branch], MAIN) === null) console.log(`KEEP   ${s.branch} — git branch -D failed`);
    else {
      deleted++;
      console.log(`DELETE ${s.branch} — ${s.why}`);
    }
  }
  const planned = steps.filter((s) => s.action === "delete");
  const n = apply ? deleted : planned.length;
  const w = apply ? removed : planned.filter((s) => s.worktree).length;
  console.log(`🧹 branches: ${n} ${apply ? "deleted" : "would be deleted (dry run, --apply to do it)"}, ${steps.length - n} kept; worktrees: ${w} ${apply ? "removed" : "would be removed"}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`sapu-cleanup: ${e.message}\n`);
    process.exit(1);
  }
}
