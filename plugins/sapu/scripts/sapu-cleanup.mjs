#!/usr/bin/env node
// sapu-cleanup.mjs — deletes sapu's own local branches that are PROVEN merged, with their clean
// worktrees. The orchestrator runs it after asking the owner (end of a session, and at Finish).
//
// Squash merges make `git branch --merged` useless, so a branch counts as merged only when one of
// these holds: its tip is in origin/<base>; its tip is inside a merged PR's head; a merged PR has its
// name; or every issue it names (in the branch name or its commit subjects) is closed by a merged PR.
// Never touched: the base branch, the main checkout's branch, an open PR's head, a `--keep` name, a
// branch outside sapu's own names (`<type>/issue-<N>-…`, `worktree-wf_*`, `worktree-agent-*`,
// `sapu-*`; `--all` lifts this), a worktree with uncommitted changes (never `--force`).
//
// USAGE (from the main checkout or any of its worktrees):
//   node sapu-cleanup.mjs [--apply] [--all] [--keep <branch>]...
// Without --apply it only prints the plan. Last line: `🧹 branches: N deleted, M kept; worktrees: X removed`.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { findMain, loadContract, lockProblems } from "./sapu-contract.mjs";

export const SAPU_BRANCH = /^((feat|fix|perf|refactor|chore|docs|test|ci|build|style)\/issue-\d+|worktree-(wf_|agent-)|sapu-)/;

/** The issue numbers a branch names: `issue-<N>` / `#<N>` in its name and commit subjects. */
export const issueRefs = (text) => [...new Set([...text.matchAll(/(?:issue-|#)(\d+)\b/g)].map((m) => Number(m[1])))];

/**
 * The plan, from facts only (no git, no gh): [{ branch, action: "delete"|"keep", why, worktree }].
 * @param {object} f
 * @param {{name: string, tip: string, subjects: string}[]} f.branches local branches
 * @param {Record<string, string>} f.worktrees branch → worktree path (the main checkout excluded)
 * @param {Set<string>} f.dirty worktree paths with uncommitted changes
 * @param {Set<string>} f.inBase branch names whose tip is in origin/<base>
 * @param {Set<string>} f.reach commits inside merged PR heads (not in the base)
 * @param {Set<string>} f.mergedNames heads of merged PRs
 * @param {Set<string>} f.open heads of open PRs
 * @param {(n: number) => boolean} f.closedByMerge an issue closed by a merged PR
 */
export function plan({ branches, worktrees, dirty, inBase, reach, mergedNames, open, closedByMerge, base, mainBranch, keep = [], all = false }) {
  const out = [];
  for (const { name, tip, subjects } of branches) {
    if (name === base || name === mainBranch) continue;
    const worktree = worktrees[name] || "";
    const keepIt = (why) => out.push({ branch: name, action: "keep", why, worktree });
    if (keep.includes(name)) keepIt("--keep");
    else if (!all && !SAPU_BRANCH.test(name)) keepIt("not a sapu branch (--all to include)");
    else if (open.has(name)) keepIt("open PR");
    else {
      const issues = issueRefs(`${name} ${subjects}`);
      const proof = inBase.has(name)
        ? `in ${base}`
        : reach.has(tip)
          ? "inside a merged PR"
          : mergedNames.has(name)
            ? "merged PR of this name"
            : issues.length && issues.every(closedByMerge)
              ? `issue${issues.length > 1 ? "s" : ""} ${issues.map((n) => `#${n}`).join(", ")} closed by merged PRs`
              : null;
      if (!proof) keepIt("not proven merged");
      else if (worktree && dirty.has(worktree)) keepIt(`its worktree has uncommitted changes (${worktree})`);
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

/** The git facts of `main` (a checkout whose origin/<base> is fresh), given merged PR head SHAs. */
export function gitFacts(main, base, mergedOids) {
  const git = (...a) => run("git", ["-C", main, ...a], main);
  const branches = git("for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [name, tip] = l.split(" ");
      return { name, tip, subjects: tryRun("git", ["-C", main, "log", "--format=%s", `origin/${base}..${name}`], main) || "" };
    });
  const worktrees = {};
  const dirty = new Set();
  let cur = null;
  for (const l of git("worktree", "list", "--porcelain").split("\n")) {
    if (l.startsWith("worktree ")) cur = l.slice(9);
    if (l.startsWith("branch refs/heads/") && cur !== main) {
      worktrees[l.slice(18)] = cur;
      if (tryRun("git", ["-C", cur, "status", "--porcelain"], main)) dirty.add(cur);
    }
  }
  const inBase = new Set(branches.filter((b) => tryRun("git", ["-C", main, "merge-base", "--is-ancestor", b.tip, `origin/${base}`], main) !== null).map((b) => b.name));
  const local = (tryRun("git", ["-C", main, "cat-file", "--batch-check=%(objectname) %(objecttype)"], main, mergedOids.join("\n") + "\n") || "")
    .split("\n")
    .filter((l) => l.endsWith(" commit"))
    .map((l) => l.split(" ")[0]);
  const reach = new Set(local.length ? (tryRun("git", ["-C", main, "rev-list", "--stdin", `^origin/${base}`], main, local.join("\n") + "\n") || "").split("\n").filter(Boolean) : []);
  const mainBranch = tryRun("git", ["-C", main, "symbolic-ref", "--short", "HEAD"], main) || "";
  return { branches, worktrees, dirty, inBase, reach, mainBranch };
}

function main(argv) {
  const apply = argv.includes("--apply");
  const all = argv.includes("--all");
  const keep = argv.flatMap((a, i) => (argv[i - 1] === "--keep" ? [a] : []));
  const MAIN = findMain(process.cwd());
  const { contract: c, error } = loadContract(MAIN);
  if (!c) throw new Error(`no usable sapu contract: ${error}`);
  const lock = lockProblems(MAIN, c);
  if (lock.length) throw new Error(`scope lock: ${lock.join("; ")}`);
  const base = c.baseBranch;
  run("git", ["-C", MAIN, "fetch", "--prune", "-q", "origin"], MAIN);
  run("git", ["-C", MAIN, "worktree", "prune"], MAIN);
  const gh = (...a) => JSON.parse(run("gh", [...a, "--repo", c.repo], MAIN) || "[]");
  const merged = gh("pr", "list", "--state", "merged", "--limit", "1000", "--json", "headRefName,headRefOid");
  const open = new Set(gh("pr", "list", "--state", "open", "--limit", "500", "--json", "headRefName").map((p) => p.headRefName));
  const facts = gitFacts(MAIN, base, merged.map((p) => p.headRefOid));
  const issueCache = new Map();
  const closedByMerge = (n) => {
    if (!issueCache.has(n)) {
      const i = tryRun("gh", ["issue", "view", String(n), "--repo", c.repo, "--json", "state,closedByPullRequestsReferences"], MAIN);
      const j = i ? JSON.parse(i) : null;
      issueCache.set(n, Boolean(j && j.state === "CLOSED" && (j.closedByPullRequestsReferences || []).length));
    }
    return issueCache.get(n);
  };
  const steps = plan({ ...facts, mergedNames: new Set(merged.map((p) => p.headRefName)), open, closedByMerge, base, keep, all });
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
  const kept = steps.length - (apply ? deleted : steps.filter((s) => s.action === "delete").length);
  const n = apply ? deleted : steps.filter((s) => s.action === "delete").length;
  const w = apply ? removed : steps.filter((s) => s.action === "delete" && s.worktree).length;
  console.log(`🧹 branches: ${n} ${apply ? "deleted" : "would be deleted (dry run, --apply to do it)"}, ${kept} kept; worktrees: ${w} ${apply ? "removed" : "would be removed"}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`sapu-cleanup: ${e.message}\n`);
    process.exit(1);
  }
}
