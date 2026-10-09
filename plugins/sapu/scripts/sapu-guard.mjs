#!/usr/bin/env node
// sapu-guard.mjs — PreToolUse guard for every SUBAGENT in a repo where the sapu plugin is enabled.
//
// WHY THIS EXISTS. A rule stated only in prose (the subagent brief, the agent bodies) can still be
// broken by an agent: an `npm ci` that empties the main checkout's node_modules through a symlink,
// leftover test DBs, a linked real `.env`, a worker running the full gate beside others. Prose
// asks; a hook refuses. Exit 2 blocks the call and stderr goes back to the
// agent as the reason (hooks reference, "exit code 2").
//
// THREAT MODEL. The guard protects against an HONEST BUT FALLIBLE agent: the mistakes above, and
// the plausible catastrophic mistakes of the same kind (merging, pushing to the base branch,
// skipping hooks, touching shared databases, env files or the main checkout). It is NOT a sandbox
// against a deliberately malicious agent with a shell — a shell has endless ways around any
// parser. Against tampering the backstops are elsewhere: (1) sapu-merge.sh verifies the contract
// and every hook file it runs against a FRESHLY FETCHED origin/<base>, never against <MAIN>'s
// local refs, index or working tree; (2) an independent review reads every PR's diff; (3) only
// the orchestrator merges, pinned to the SHA the merge gate ran on. A gap listed under LIMITS is
// judged by that bar: closed when an honest agent could fall into it, listed when only intent can.
//
// HOW. A Bash command is tokenized like a shell would (quotes, `$'…'`, escapes, `;` `&&` `||` `|`
// `&`, redirection operators as words of their own, subshells, `$( )` and backticks — also inside
// double quotes), wrappers are peeled (`env`, `nice`, `time`, `exec`, `xargs`, `npx`, `bunx`,
// `bun x`, `corepack`, `npm exec`, `pnpm dlx`, `caffeinate`, `arch`, `script`, `do`, ...),
// `bash -c`/`sh -c`/`eval`/`env -S`/`npm exec -c`/`script -c`/`bun exec`/`find -exec` and heredocs
// fed to a shell are checked recursively (nesting deeper than MAX_DEPTH is blocked, never waved
// through), and `cd`/`pushd`/`env -C`/`git -C`/`--git-dir`/`--work-tree`/`GIT_DIR` are followed
// (a `cd` inside `( )`, a pipeline or `&` does not move the parent) to know which checkout a
// command acts on. A regex over the raw text was the first version and the review rounds showed
// how it leaked; every leak they found is a test in sapu-guard.test.ts. Read/Write/Edit/
// MultiEdit/NotebookEdit calls are checked by path: no env file (any letter case) is read or
// written, no git file (`.git`, ~/.gitconfig, ~/.config/git/), nothing in sapu's machine config
// (~/.config/sapu/, whose loss lifts the scope lock) and nothing of a plugin agents run under (its
// folder, Claude Code's plugin store and user settings, a local marketplace's plugin sources:
// pluginDirs; these three in any letter case too) is written by any subagent, and a worker writes
// nothing into the main checkout outside its `.claude/worktrees/` (symlinks resolved, so a
// worktree's linked node_modules counts as <MAIN>). The same holds for the common Bash write
// forms (redirections, tee, cp/mv/install/ln, sed -i, perl -i, rm, patch), with brace lists
// expanded, `~`, `~user`, `~+`, `~-` and `cd -` read as the shell reads them, a copy, move or link
// judged also where it lands (`<dest>/<name>`, or `<dest>` itself for a recursive copy of a
// source's contents, where a directory above a protected path counts), and a glob target judged
// by what it can expand into, segment by segment. Grep/Glob calls are
// checked by their path and path glob: none may name or be able to match an env file.
//
// RULES. The engine rules (git/gh/stash/force/refs/base branch/main checkout, .env/.env.local,
// installs through symlinked node_modules, destructive prisma) hold in every repo. The repo adds
// its own through `guard` in its contract .claude/sapu.json (CONTRACT.md): protected Postgres
// ports/databases (`postgres`), those of MySQL, MongoDB, Redis and SQLite (`databases`), more env
// files, and `deny` rules; its `gate.merge` command is denied
// automatically. The contract is read from <MAIN>'s COMMITTED HEAD, never from a working tree,
// and <MAIN> is the repo a call touches, not the session's folder (TOUCHED REPO, before decide()).
// A contract that exists but is broken blocks every call except the canary; a repo with no
// contract yet keeps the engine floor, except for a sapu worker, which never works without one.
//
// STEP BUDGET. A ladder worker's tool calls are counted per agent id (stepBudget below): a reminder
// block at STEP_SOFT, every STEP_EVERY after and every STEP_EVERY_LATE past STEP_HARD; never a hard stop.
// It is off without an agent_id or a writable counter, so the worker canary's answer also carries
// whether it counts (stepProbe), and the wave logs a WARNING when it does not.
//
// SCOPE. Wired through the plugin's hooks/hooks.json, which fires for every Bash, file and search
// tool call in the session; the CLI acts for every call whose hook input carries an `agent_id`
// (a subagent, a subagent's subagent, ...; a ladder worker or the explorer by its `agent_type`
// alone too); the orchestrator — the main session, also one started with `--agent`, which merges,
// runs the merge gate and fast-forwards <MAIN> through sapu-merge.sh — only for where it dispatches
// agents from (HOME CHECKOUT below: checkHome). Two tiers:
// a sapu worker (`sapu:sapu-*` on the ladder: SAPU_AGENT) gets the whole floor; any other subagent
// (a reviewer, a specialist — the senior-dev-team agents included —,
// argus/momus/nemesis and their helpers) gets the same floor EXCEPT that it may run
// `gh issue create` and may write into <MAIN>'s STATE_DIRS (`.argus/`, `.momus/`, `.nemesis/`,
// `.claude/agent-memory/`, `.claude/agent-memory-local/`, `dreams/`), because filing findings and keeping that state is their
// job. Anywhere else in <MAIN> outside `.claude/worktrees/` stays closed to them too: a subagent
// a worker dispatches is not a way to edit <MAIN>. A nested subagent is policed
// like any other: an `Agent` call is not a way around the guard. The wave workflow proves the
// hook is live with a canary command (`sapu-guard-canary`) before trusting a worker.
//
// LIMITS (deliberate, known — see THREAT MODEL): an interpreter running its own code (`node -e`,
// `python -c`, a script, `expect`, `tmux send-keys`, `parallel`, `watch`, a pty wrapper such as
// `script` fed through stdin) is not parsed; shell variables are not expanded (except a leading
// `$HOME`/`${HOME}`, read like `~`) — a mutating git command whose target is a variable is
// BLOCKED, but a Bash write whose target is another variable (`> "$M/x"`) or comes from stdin
// (`xargs rm`), or whose cwd is such a variable while the path is relative, is allowed. A write
// target with a glob (`*`, `?`, `[`) is matched segment by segment with the shell's dotfile rule
// (`**` reaches any depth): blocked when it can expand into git's own files under HOME, a `.git`,
// or sapu's machine config (or an ancestor of them, or something inside); elsewhere only the
// literal word is checked. A quoted `{a,b}` is expanded like an unquoted one (a false block, never
// a miss); a brace sequence (`{a..z}`) reads as `*`; a zsh named directory (`~name` set by `hash
// -d`) and the directory stack (`~1`, `cd +1`) are not known. A symlink whose target does not exist yet
// is judged by the link's own path (a dangling link inside a state dir can point a later write
// elsewhere: tampering-grade, two deliberate steps). Bash writes are recognised only in the forms above: not `dd of=`,
// `rsync`, `tar -C`, `unzip -d`, `curl -o`, `touch`, `truncate`, `mkdir`, `chmod`,
// `find -delete`, nor files written by the programs a command runs. `HOME=`/`XDG_CONFIG_HOME=`
// and the program variables (`GIT_PAGER`, `GIT_EDITOR`, `GIT_SSH_COMMAND`, `PAGER`, …) are refused
// only in front of git itself, not when exported earlier or given to a program that runs git; a git
// config key names a program by the list in git-config(1) (GIT_CONFIG_PROGRAM), so a key a newer git
// adds is unknown until it is listed. Plugins: `claude plugin` changes are refused, a plugin
// manager other than the claude CLI is not known; a plugin loaded with `--plugin-dir` from a
// worktree makes that folder unwritable for the session's subagents too. A PR's or a fork's code: BLOCKED are `gh pr checkout` (also as `gh co`), fetch/pull of a
// `pull/*` ref, a raw SHA, a ref glob outside refs/heads|refs/tags, another remote or a URL, `git
// clone`, `gh repo clone`, `gh extension install`, `gh release download`, `degit`/`tiged`, `gh api`
// contents/tarball at a pull ref, `git am`, `git apply` (except --check/--stat), `patch` (bare or via
// busybox/toybox, except --dry-run/--check/-C; also a shell's -c fed by `gh pr diff`/`gh api`/`curl`/
// `wget`), and a `curl`/`wget` download piped (through any filter) into tar/bsdtar/unzip/cpio/7z.
// NOT traced (named limits, each needing intent): a download saved to a file and unpacked later
// (`curl -o x.tgz`, then `tar xf x.tgz`), a download piped into a shell (`curl … | sh`, an
// interpreter running its own code), `git merge-file`, a SHA piped into `xargs git fetch`, files an
// interpreter writes, and a label an interpreter or a file-reading program supplies (`gh issue edit
// --add-label` with a word from `xargs` without a replace string is refused only when the option's
// value itself is missing; one from `-I`/`-J`/`--replace` is refused as not literal).
// The touched repo is known by a local path only: gh's -R/--repo and an MCP tool's remote fields name
// a remote, so gh is judged by its cwd's repo and an MCP tool's branch and label fields by the
// session's contract; a place an interpreter reaches on its own is not resolved (see above).
// gh: -R/--repo/--hostname are dropped wherever they stand before the subcommand; a first word outside gh's own command
// set (an alias, an extension) is BLOCKED. The owner labels (contract labels.accepted, needsOwner,
// agentFiled; the last two may still be given to a new issue by `gh issue create`): BLOCKED
// when named by `gh issue|pr edit --add/--remove-label`, `gh label create|edit|delete`, a non-GET `gh
// api` argument, or hidden in a label/issue write's --input; `gh label clone` and the GraphQL label
// mutations are BLOCKED outright. A not-planned close (`gh issue close -r`, REST state_reason,
// GraphQL closeIssue, MCP fields) is BLOCKED: it is the owner's ruling. Grep over a directory relies on ripgrep's ignore rules (an env file is normally
// gitignored); only a path or glob naming one is refused. Package-manager and wrapper options are
// known one by one; an unknown option that takes a value can hide the program after it. An
// exception while checking a call BLOCKS it; only a guard that cannot start at all fails open
// (non-2 exit) — the canary is what catches a dead guard. A subagent is known by the hook input's
// agent_id (SCOPE): a ladder worker or the explorer keeps the floor by its agent_type alone, but any
// other agent_type without an agent_id reads as a `--agent` main session, the orchestrator, so a host
// that dropped agent_id for those subagents would leave them unguarded (not yet probed live; the
// worker canary proves agent_id only for the ladder).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acceptedLabel, agentFiledLabel, checkoutRoot, DEFAULT_TUNING, findMain, gitCommonDir, isHandoffCommand, loadContract, needsOwnerLabel, resolveTuning } from "./sapu-contract.mjs";

const UNKNOWN = Symbol("unknown-dir");
/** Deeper nesting (bash -c inside eval inside $( ) ...) is blocked: never parsed, never allowed. */
const MAX_DEPTH = 6;

/** The plugin's own worker ladder: the only subagents that never run without a contract. */
export const SAPU_AGENT = /(^|:)sapu-(sonnet|opus)-(low|medium|high)$/;

/** The argus journey lane's explorer (docs/specs/argus-journey-lane.md §11). */
export const EXPLORER_AGENT = /(^|:)ui-explorer$/;
/** The only program the explorer's Bash may run: this plugin's own wrapper, never a path from a prompt. */
export const WRAPPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "argus-live.mjs");
// The first character excludes `#` (comment) and `=` (zsh `=cmd` expansion); no `#` at all
// (extendedglob operator) and no `==` (magicequalsubst). A leading `-` is harmless to the shell;
// option filtering is the wrapper's job.
const EXPLORER_WORD = /^[A-Za-z0-9./_-][A-Za-z0-9._:/=@,+-]*$/;
// A single-quoted word, its segments joined only by `\'` (the POSIX apostrophe idiom: 'O'\''Brien').
const EXPLORER_QUOTED = /^'([^']*)'((?:(?:\\')+'[^']*')*)/;

/**
 * The explorer's Bash as argv lists, one per `;`, `&&` or newline, every argument a single-quoted
 * literal or a plain word; null for anything else (expansion, glob, pipe, redirection, substitution).
 */
export function explorerArgv(command) {
  if (typeof command !== "string" || !command.trim()) return null;
  const runs = [[]];
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === " " || ch === "\t") {
      i++;
    } else if (ch === "\n" || ch === ";") {
      runs.push([]);
      i++;
    } else if (command.startsWith("&&", i)) {
      runs.push([]);
      i += 2;
    } else if (ch === "'") {
      const m = EXPLORER_QUOTED.exec(command.slice(i));
      if (!m || /[\r\n]/.test(m[0])) return null;
      const end = i + m[0].length;
      if (end < command.length && !/[\s;&]/.test(command[end])) return null;
      runs.at(-1).push(m[1] + m[2].replace(/((?:\\')+)'([^']*)'/g, (_, q, seg) => "'".repeat(q.length / 2) + seg));
      i = end;
    } else {
      let j = i;
      while (j < command.length && !/[\s;'&]/.test(command[j])) j++;
      const word = command.slice(i, j);
      if (!EXPLORER_WORD.test(word) || word.includes("==") || command[j] === "'" || (command[j] === "&" && !command.startsWith("&&", j))) return null;
      runs.at(-1).push(word);
      i = j;
    }
  }
  return runs.filter((r) => r.length);
}

/** Same file, by real path; an unresolvable path is never the wrapper. */
function isWrapper(p, wrapper) {
  try {
    return path.isAbsolute(p) && fs.realpathSync(p) === fs.realpathSync(wrapper);
  } catch {
    return false;
  }
}

/**
 * The explorer's Bash: one or more `node <wrapper> pw …` runs (the wrapper named by an absolute path
 * that resolves to this plugin's own), so no expansion, glob, pipe, redirection, substitution or
 * environment prefix can reach a shell. A reason, or null.
 */
export function checkExplorerBash(command, wrapper = WRAPPER) {
  const runs = explorerArgv(command);
  if (!runs || !runs.length || runs.some((r) => r[0] !== "node" || !isWrapper(r[1] ?? "", wrapper) || r[2] !== "pw")) return BLOCK.explorerBash;
  return null;
}

/** The worktree of the live journey run (`<MAIN>/.argus/live/run.json`), real path, or null. */
function liveWorktree(main) {
  try {
    const w = JSON.parse(fs.readFileSync(path.join(main, ".argus/live/run.json"), "utf8")).worktree;
    return typeof w === "string" && w ? fs.realpathSync.native(w) : null;
  } catch {
    return null;
  }
}

/**
 * The explorer's Read: only a file whose real path lies in the run's worktree, outside `.argus/`
 * (compared case-folded: macOS is case-insensitive), and committed at HEAD (not merely staged).
 * Page content and code search reach the explorer only through the wrapper.
 */
export function checkExplorerRead({ input, worktree, cwd }) {
  if (!worktree) return BLOCK.explorerRead;
  const raw = input.file_path;
  if (typeof raw !== "string" || !raw) return BLOCK.explorerRead;
  let real;
  try {
    real = fs.realpathSync.native(path.resolve(cwd, raw));
  } catch {
    return BLOCK.explorerRead;
  }
  const rel = path.relative(worktree, real);
  const low = rel.toLowerCase();
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel) || low === ".argus" || low.startsWith(`.argus${path.sep}`)) return BLOCK.explorerRead;
  try {
    if (!fs.statSync(real).isFile()) return BLOCK.explorerRead;
    const posix = rel.split(path.sep).join("/");
    // exactly one entry, a blob (file or symlink) at that very path: never a tree or a gitlink
    const out = execFileSync("git", ["--literal-pathspecs", "-C", worktree, "ls-tree", "-z", "HEAD", "--", posix], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = /^(100644|100755|120000) blob [0-9a-f]+\t([^\0]*)\0$/.exec(out);
    if (!m || m[2] !== posix) return BLOCK.explorerRead;
  } catch {
    return BLOCK.explorerRead;
  }
  return null;
}

/**
 * Drop heredoc bodies (PR bodies, review files) — unless the heredoc feeds a shell, or its
 * terminator never comes (then the "body" is really more commands).
 */
export function stripHeredocs(cmd) {
  const out = [];
  let end = null;
  let keep = false;
  let body = [];
  for (const line of cmd.split("\n")) {
    if (end !== null) {
      if (line.trim() === end) {
        if (keep) out.push(...body);
        end = null;
        body = [];
      } else body.push(line);
      continue;
    }
    out.push(line);
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (m) {
      end = m[2];
      keep =
        /(^|[|;&(]\s*)(\S+=\S*\s+)*(bash|sh|zsh|dash)\b(?![\w.-])/.test(line.slice(0, m.index)) ||
        /\|\s*(bash|sh|zsh|dash)\b/.test(line.slice(m.index));
    }
  }
  if (end !== null) out.push(...body);
  return out.join("\n");
}

/** Index of the `)` closing the `(` at `open`, or src.length. */
function closingParen(src, open) {
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === "(") depth++;
    else if (src[k] === ")" && --depth === 0) return k;
  }
  return src.length;
}

/**
 * Shell-like tokenizer. Returns simple commands, each {toks: [{v, dyn}], pre, post} where
 * pre/post are the operators around it ("|", "&", "(", ")", ";" ...), plus `nested`: the text
 * of every command substitution found inside double quotes, to be checked on its own.
 */
export function tokenize(src) {
  const cmds = [];
  const nested = [];
  let toks = [];
  let tok = null;
  let pre = ";";
  let preCond = false; // the separator before this command was && or || (pre still reads ";")
  let inBacktick = false;
  const push = () => {
    if (tok !== null) toks.push(tok);
    tok = null;
  };
  const end = (op, cond = false) => {
    push();
    const kept = toks.filter((t) => t.v !== "{" && t.v !== "}");
    // A line break (or comment) right after `|`, `&&` or `||` continues that list: `a |⏎ b` is a pipeline.
    if (!kept.length && op === ";" && (pre === "|" || preCond)) {
      toks = [];
      return;
    }
    if (kept.length) cmds.push({ toks: kept, pre, post: op, cond: preCond });
    else if (cmds.length && (op === ")" || op === "|" || op === "&")) {
      // `(…) | x` / `(…) &`: keep the subshell's ")" so its directory is restored; the pipe or job
      // applies to the subshell as a whole, which never moves this shell anyway.
      const last = cmds[cmds.length - 1];
      if (!(last.post === ")" && op !== ")")) last.post = op;
    }
    toks = [];
    pre = op;
    preCond = cond;
  };
  const add = (c, dyn = false) => {
    if (tok === null) tok = { v: "", dyn: false };
    tok.v += c;
    if (dyn) tok.dyn = true;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) {
      if (src[i + 1] !== "\n") add(src[i + 1]);
      i++;
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      add(src.slice(i + 1, j === -1 ? src.length : j));
      i = j === -1 ? src.length : j;
    } else if (c === '"') {
      if (tok === null) tok = { v: "", dyn: false };
      let j = i + 1;
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === "\\" && j + 1 < src.length) add(src[++j]);
        else if (src[j] === "$" && src[j + 1] === "(") {
          const k = closingParen(src, j + 1);
          nested.push(src.slice(j + 2, k));
          add(src.slice(j, k + 1), true);
          j = k;
        } else if (src[j] === "`") {
          const k = src.indexOf("`", j + 1);
          nested.push(src.slice(j + 1, k === -1 ? src.length : k));
          add("`", true);
          j = k === -1 ? src.length : k;
        } else add(src[j], src[j] === "$");
      }
      i = j;
    } else if (c === "$" && src[i + 1] === "'") {
      // $'…' (ANSI-C quoting): decode the escapes, so `$'\x2eenv'` is `.env`.
      let j = i + 2;
      let text = "";
      for (; j < src.length && src[j] !== "'"; j++) {
        if (src[j] !== "\\" || j + 1 >= src.length) {
          text += src[j];
          continue;
        }
        const r = src.slice(j + 1);
        let m;
        if ((m = /^x([0-9a-fA-F]{1,2})/.exec(r))) text += String.fromCharCode(parseInt(m[1], 16));
        else if ((m = /^(?:u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8}))/.exec(r))) text += String.fromCodePoint(Math.min(parseInt(m[1] ?? m[2], 16), 0x10ffff));
        else if ((m = /^[0-7]{1,3}/.exec(r))) text += String.fromCharCode(parseInt(m[0], 8) & 0xff);
        else if ((m = /^c(.)/.exec(r))) text += String.fromCharCode(m[1].charCodeAt(0) & 31);
        else {
          m = [r[0]];
          text += { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v" }[r[0]] ?? r[0];
        }
        j += m[0].length;
      }
      add(text);
      i = j;
    } else if (c === "$" && src[i + 1] === '"') {
      // $"…" (locale string) is a double-quoted string: the next character opens it.
    } else if (c === "<" || c === ">" || (c === "&" && src[i + 1] === ">")) {
      // A redirection operator is a word of its own (`cat<.env` is cat, <, .env), with the file
      // descriptor number written right before it (`2>`).
      let op = "";
      if (tok !== null && !tok.dyn && /^\d+$/.test(tok.v)) {
        op = tok.v;
        tok = null;
      } else push();
      const m = /^(?:&>>?|<<<|<<-?|<>|<&|>>|>&|>\||<|>)/.exec(src.slice(i));
      op += m[0];
      i += m[0].length - 1;
      toks.push({ v: op, dyn: false });
    } else if (c === "$" && src[i + 1] === "(") {
      end("(");
      i++;
    } else if (c === "`") {
      end(inBacktick ? ")" : "(");
      inBacktick = !inBacktick;
    } else if (c === ";" || c === "\n") {
      end(";");
    } else if (c === "(" || c === ")") {
      end(c);
    } else if (c === "&" || c === "|") {
      if (src[i + 1] === c) {
        end(";", true);
        i++;
      } else end(c);
    } else if (c === "#" && tok === null) {
      while (i < src.length && src[i] !== "\n") i++;
      end(";");
    } else if (/\s/.test(c)) {
      push();
    } else {
      add(c, c === "$");
    }
  }
  end(";");
  return { cmds, nested };
}

const KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "time", "command", "builtin", "nohup", "sudo"]);
/** A redirection operator word (the tokenizer splits them out): `>`, `2>>`, `&>`, `>&`, `<`, `<<`, `<<<`, … */
const REDIRECT_OP = /^\d*(?:&>>?|<<<|<<-?|<>|<&|>>|>&|>\||<|>)$/;
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** `env -S <string>` / `--split-string`: env splits the string into a command of its own. */
const ENV_SPLIT = /^(?:-[a-zA-Z]*?S|--split-string(?:=|$))([\s\S]*)$/;
/** `npx -c <string>`, `npm exec --call=<string>`, `script -c|--command <string>`: the string is a shell command. */
const EXEC_CALL = /^(?:-c|--call(?:=|$)|--command(?:=|$))([\s\S]*)$/;
/** `uv run` options whose value is the next word (`uv run --with x pytest`). */
const UV_VALUE_OPTS = /^(--with|--with-editable|--with-requirements|--extra|--group|--only-group|--no-group|--package|-p|--python|--env-file|--directory|--project|--index|--default-index|-i|--index-url|--extra-index-url|-f|--find-links)$/;
/** Package-manager options that take a value before the subcommand (`pnpm --filter api exec …`). */
const PM_VALUE_OPTS = /^(--filter|-F|-C|--dir|--prefix|-w|--workspace|--cwd)$/;

/** Peel env assignments and wrappers; returns the index of the real program in the command. */
function programIndex(t) {
  let i = 0;
  while (i < t.length) {
    const v = path.basename(t[i].v);
    if (REDIRECT_OP.test(t[i].v)) i += 2; // a redirection before the program (`>/dev/null cmd`)
    else if (ASSIGN.test(t[i].v) || KEYWORDS.has(v)) i++;
    else if (v === "exec") {
      i++;
      while (i < t.length && t[i].v.startsWith("-")) i += t[i].v === "-a" ? 2 : 1;
    } else if (v === "caffeinate" || v === "arch") {
      i++;
      while (i < t.length && t[i].v.startsWith("-")) i += (v === "caffeinate" ? /^-[tw]$/ : /^-[ed]$/).test(t[i].v) ? 2 : 1;
    } else if (v === "script") {
      // script [options] [file [command …]]: the first word after the options is the typescript file.
      i++;
      while (i < t.length && t[i].v.startsWith("-")) {
        if (EXEC_CALL.test(t[i].v)) return i; // `script -c '<cmd>'`: checked as a command
        i += /^-[FtTIOBEm]$/.test(t[i].v) ? 2 : 1;
      }
      i++;
    } else if (v === "bun" && t[i + 1]?.v === "x") {
      i += 2;
      while (i < t.length && t[i].v.startsWith("-")) i += /^(-p|--package)$/.test(t[i].v) ? 2 : 1;
    } else if (v === "env") {
      i++;
      while (i < t.length) {
        const o = t[i].v;
        if (ENV_SPLIT.test(o)) return i; // checkCommand checks the split string as a command
        if (/^(-u|--unset|-C|--chdir|-P)$/.test(o)) i += 2;
        else if (o.startsWith("-") || ASSIGN.test(o)) i++;
        else break;
      }
    } else if ((v === "bundle" && t[i + 1]?.v === "exec") || ((v === "uv" || v === "poetry" || v === "pipenv") && t[i + 1]?.v === "run")) {
      // `bundle exec`, `uv run`, `poetry run`, `pipenv run` run the command after them.
      i += 2;
      while (i < t.length && t[i].v.startsWith("-")) i += v === "uv" && UV_VALUE_OPTS.test(t[i].v) ? 2 : 1;
    } else if (v === "nice") {
      i++;
      if (t[i]?.v === "-n") i += 2;
      else if (/^-n?-?\d+$/.test(t[i]?.v ?? "")) i++;
    } else if (v === "timeout") {
      i++;
      while (i < t.length && t[i].v.startsWith("-")) i += /^(-s|--signal|-k|--kill-after)$/.test(t[i].v) ? 2 : 1;
      i++;
    } else if (v === "xargs") {
      i++;
      let rep = null;
      while (i < t.length && t[i].v.startsWith("-")) {
        const o = t[i].v;
        if (/^-[IJ]$/.test(o)) rep = t[i + 1]?.v ?? null;
        else if (/^-[IJ]./.test(o)) rep = o.slice(2);
        else if (o === "-i" || o === "--replace") rep = "{}";
        else if (/^(?:-i|--replace=)./.test(o)) rep = o.replace(/^(?:-i|--replace=)/, "");
        i += /^-[IJndPLs]$/.test(o) ? 2 : 1;
      }
      // xargs puts what it reads in place of its replace string: such a word is not a literal.
      if (rep) for (let k = i; k < t.length; k++) if (t[k].v.includes(rep)) t[k] = { ...t[k], dyn: true };
    } else if (v === "npx" || v === "bunx" || v === "corepack" || (PKG_MANAGERS.has(v) && /^(exec|x|dlx)$/.test(pmSubcommand(t, i)))) {
      // `npm exec`, `npm x`, `pnpm exec|dlx`, `yarn exec|dlx` run their argument like npx does.
      if (PKG_MANAGERS.has(v)) {
        i++;
        while (i < t.length && t[i].v.startsWith("-")) i += PM_VALUE_OPTS.test(t[i].v) ? 2 : 1;
      }
      i++;
      while (i < t.length && t[i].v.startsWith("-")) {
        if (v !== "corepack" && EXEC_CALL.test(t[i].v)) return i; // checkCommand checks the -c string as a command
        i += /^(-p|--package)$/.test(t[i].v) ? 2 : 1;
      }
    } else break;
  }
  // A wrapper or redirection with nothing after it (`exec >`, `script -q`) must not point past the end.
  return Math.min(i, t.length);
}

/** The first word after a package manager's leading options (`pnpm --filter api exec` → exec). */
function pmSubcommand(t, i) {
  let j = i + 1;
  while (j < t.length && t[j].v.startsWith("-")) j += PM_VALUE_OPTS.test(t[j].v) ? 2 : 1;
  return t[j]?.v ?? "";
}

/** A program's name: its basename without an `@version` suffix (`npx prisma@5` runs prisma). */
const bare = (v) => path.basename(v).replace(/(.)@[^@/]*$/, "$1");
const toks = (ws) => ws.map((v) => ({ v, dyn: false }));

function realpathOrSelf(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** The real path of `p`, resolving the symlinks of its deepest existing ancestor (`p` may not exist yet). */
function realPathOf(p) {
  let head = p;
  const tail = [];
  for (;;) {
    try {
      // .native canonicalises case too: on a case-insensitive disk `<MAIN>` spelled in another case
      // is still <MAIN>.
      return path.join(fs.realpathSync.native(head), ...tail);
    } catch {
      const up = path.dirname(head);
      if (up === head) return p;
      tail.unshift(path.basename(head));
      head = up;
    }
  }
}

/** node_modules symlinks at depth <= 3 (what `find . -maxdepth 3 -name node_modules -type l` finds). */
export function symlinkedNodeModules(dir) {
  const hits = [];
  const walk = (d, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.name === "node_modules") {
        if (e.isSymbolicLink()) hits.push(path.relative(dir, p));
        continue; // never descend into node_modules
      }
      if (e.isDirectory() && !e.name.startsWith(".")) walk(p, depth + 1);
    }
  };
  walk(dir, 1);
  return hits;
}

/** The checkout root above `dir` (the directory holding `.git`, file or folder), or null. */
function gitRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return null;
  }
}

const MUTATING_GIT = new Set(["checkout", "switch", "pull", "reset", "stash", "merge", "rebase", "commit", "push", "cherry-pick", "restore", "clean", "am", "revert", "rm", "mv", "apply", "add", "notes"]);
/** Long options git would accept abbreviated (`--no-verif`, `--forc`): a >= 5-character prefix counts as the option. */
const LONG_DANGER = ["--no-verify", "--force", "--delete", "--mirror", "--all", "--update-head-ok", "--ignore-other-worktrees"];
const longName = (f) => {
  const name = f.split("=")[0];
  return f.startsWith("--") && name.length >= 5 ? (LONG_DANGER.find((d) => d.startsWith(name)) ?? f) : f;
};
/** Programs that run a command elsewhere; a Postgres tool among their words is checked like one run here. */
const REMOTE_EXEC = new Set(["docker", "podman", "kubectl", "oc", "ssh"]);
const MESSAGE_FLAGS = new Set(["-m", "--message", "-b", "--body", "-t", "--title", "--subject"]);
const INSTALL_VERBS = new Set(["ci", "install", "i", "add", "update", "up", "uninstall", "remove", "rm", "un", "upgrade"]);
const PG_TOOLS = new Set(["psql", "pg_dump", "pg_restore", "createdb", "dropdb", "pgcli", "vacuumdb"]);
const GREPS = new Set(["grep", "egrep", "fgrep", "rg", "ag"]);
// Options of each grep that take a value (a path glob among them: `rg -g .env`), so the word after
// one is that value, never the search pattern the guard lets through unchecked. grep's -g/--glob
// are ugrep's (Claude Code's Bash runs ugrep as `grep`).
const GREP_LONG = ["--context", "--after-context", "--before-context", "--max-count", "--regexp", "--file"];
/** Option values a grep matches as a path glob itself: no shell dotfile rule, `\\` escapes. */
const GREP_GLOBS = new Set(["-g", "--glob", "--iglob", "--include"]);
/**
 * find's tests that glob-match a file NAME the same way. Not -path/-wholename: the guard checks a
 * glob's last segment, and an excluding `-not -path` glob ending in `/*` would read as `*`.
 */
const FIND_GLOBS = new Set(["-name", "-iname", "-lname", "-ilname"]);
const GREP_OPTS = {
  grep: { short: "ABCmdDefg", long: [...GREP_LONG, "--glob", "--include", "--exclude", "--exclude-dir", "--exclude-from", "--label", "--binary-files", "--devices", "--directories", "--group-separator"] },
  rg: { short: "ABCmjMEgtTrdef", long: [...GREP_LONG, "--glob", "--iglob", "--type", "--type-not", "--type-add", "--type-clear", "--replace", "--max-depth", "--max-filesize", "--pre", "--pre-glob", "--ignore-file", "--sort", "--sortr", "--colors", "--color", "--encoding", "--engine", "--path-separator", "--threads", "--max-columns", "--context-separator", "--field-match-separator", "--field-context-separator", "--dfa-size-limit", "--regex-size-limit"] },
  ag: { short: "ABCmGgpef", long: [...GREP_LONG, "--file-search-regex", "--ignore", "--ignore-dir", "--path-to-ignore", "--depth", "--after", "--before", "--workers", "--pager"] },
};
/**
 * A grep's argv read for its search pattern: the index of the pattern operand (-1 when none, or
 * when `-e`/`-f`/`--regexp`/`--file` in any form gives it, then every operand is a file) and every
 * option value as {opt, v}, attached ones (`-g.env`, `-uug.env`, `--glob=.env`) split out.
 */
function grepArgs(prog, a) {
  const o = GREP_OPTS[prog] ?? GREP_OPTS.grep;
  const values = [];
  let first = -1;
  for (let i = 1; i < a.length; i++) {
    const v = a[i];
    if (v === "--") {
      if (first < 0 && i + 1 < a.length) first = i + 1;
      break;
    }
    const eq = v.indexOf("=");
    if (v.startsWith("--")) {
      const name = eq > 0 ? v.slice(0, eq) : v;
      if (eq > 0) values.push({ opt: name, v: v.slice(eq + 1) });
      else if (o.long.includes(v)) values.push({ opt: v, v: a[++i] ?? "" });
    } else if (v.startsWith("-") && v.length > 1) {
      const k = [...v.slice(1)].findIndex((ch) => o.short.includes(ch));
      if (k >= 0) values.push({ opt: `-${v[k + 1]}`, v: k + 2 < v.length ? v.slice(k + 2) : a[++i] ?? "" });
    } else if (first < 0) first = i;
  }
  const fromOption = values.some((x) => ["-e", "-f", "--regexp", "--file"].includes(x.opt));
  return { pattern: fromOption ? -1 : first, values };
}
const ENV_FLOOR = [".env", ".env.local"];
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
/** Programs whose arguments name code they execute (`source`/`.` included: sourcing runs a script). */
const INTERPRETERS = new Set([...SHELLS, "node", "tsx", "ts-node", "deno", "bun", "python", "python3", "ruby", "perl", "source", "."]);
const PKG_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
/** npm's aliases of `run` (npm help run-script). */
const RUN_ALIASES = { "run-script": "run", rum: "run", urn: "run" };
/**
 * Git config that can switch off the hook gate or run code on ordinary commands: a hooks path, an
 * alias (`!sh`, `commit --no-verify`), an included file, a clean/smudge filter (it can also make
 * `git hash-object`/`status` report any content as unchanged), an attributes file that assigns
 * one, an fsmonitor hook, an ssh command, an external diff.
 */
const GIT_CONFIG_DANGER = /^(core\.hookspath|alias\.|include\.|includeif\.|filter\.|core\.attributesfile|core\.fsmonitor|core\.sshcommand|diff\.external)/i;
/**
 * The other git config keys whose value is a program git runs (git-config(1)): pager, editors,
 * askpass, proxy and alternate-refs commands, credential helpers (`credential.<url>.helper` too),
 * gpg programs, diff/merge drivers and textconv, difftool/mergetool/browser/man/guitool commands,
 * config hooks (`hook.*`), trailer, tar, sendemail and imap commands, upload-pack and gc hooks.
 * `submodule.<name>.update` runs only a `!command`; `protocol[.ext].allow` lets an `ext::` URL run one.
 */
const GIT_CONFIG_PROGRAM = /^(core\.(pager|editor|askpass|gitproxy|alternaterefscommand)|sequence\.editor|pager\..+|interactive\.difffilter|credential\.(.+\.)?helper|gpg\.((.+\.)?program|ssh\.defaultkeycommand)|diff\..+\.(textconv|command)|merge\..+\.driver|(difftool|mergetool|browser|man)\..+\.(cmd|path)|guitool\..+\.cmd|hook\..+|trailer\..+\.(cmd|command)|tar\..+\.command|sendemail\.(smtpserver|tocmd|cccmd|headercmd)|imap\.tunnel|instaweb\.httpd|uploadpack\.packobjectshook|gc\.recentobjectshook)$/i;
/** The variables git reads for the same programs (a protocol list naming `ext`, a command directory). */
const GIT_PROGRAM_ENV = /^(GIT_PAGER|GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|SSH_ASKPASS|GIT_EXTERNAL_DIFF|GIT_PROXY_COMMAND|PAGER|EDITOR|VISUAL|GIT_EXEC_PATH|GIT_ALLOW_PROTOCOL)=([\s\S]*)$/;
/** A value that runs nothing worth checking: a no-op program, a boolean (`pager.<cmd>`), or empty (resets a helper list). */
const GIT_NOOP = /^(|true|false|:|cat|yes|no|on|off|0|1)$/i;

/**
 * Does setting git config `key` to `value` make git run a program? `value` undefined = unknown (a
 * config-file write, `--config-env`, or a value the shell builds): only the value tells a no-op apart.
 */
function gitConfigRuns(key, value) {
  if (/^submodule\..+\.update$/i.test(key)) return value === undefined || value.trimStart().startsWith("!");
  if (/^protocol\.(ext\.)?allow$/i.test(key)) return value === undefined || !/^never$/i.test(value.trim());
  return GIT_CONFIG_PROGRAM.test(key) && (value === undefined || !GIT_NOOP.test(value.trim()));
}

/** Does `NAME=value` in front of git hand it a program to run? A value the shell builds is unknown. */
function gitEnvRuns(tok) {
  const m = GIT_PROGRAM_ENV.exec(tok.v);
  if (!m) return false;
  if (m[1] === "GIT_EXEC_PATH") return true;
  if (m[1] === "GIT_ALLOW_PROTOCOL") return tok.dyn || /(^|:)ext(:|$)/.test(m[2]);
  return tok.dyn || !GIT_NOOP.test(m[2].trim());
}

/**
 * The commands a git command hands to a shell through its options: `rebase -x|--exec`, `bisect run`,
 * `submodule foreach`, `filter-branch --*-filter`, `difftool -x|--extcmd`, `grep -O|--open-files-in-pager`,
 * `--upload-pack`/`--receive-pack`/`--exec` (`ls-remote -u`). Each is {text} (a shell string) or
 * {argv} (words run as a command). `rest` is the argv after the subcommand.
 */
function gitOptionCommands(sub, rest) {
  const out = [];
  const a = rest.map((x) => x.v);
  if (sub === "bisect" && a[0] === "run") return a.length > 1 ? [{ argv: rest.slice(1) }] : [];
  if (sub === "submodule" && a[0] === "foreach") {
    let k = 1;
    while (k < a.length && a[k].startsWith("-")) k++;
    return k < a.length ? [{ text: a.slice(k).join(" ") }] : [];
  }
  const long = ["--exec", "--upload-pack", "--receive-pack", "--extcmd", "--open-files-in-pager"];
  if (sub === "filter-branch") long.push("--env-filter", "--tree-filter", "--index-filter", "--parent-filter", "--msg-filter", "--commit-filter", "--tag-name-filter");
  const short = { rebase: "-x", difftool: "-x", "ls-remote": "-u" }[sub];
  for (let k = 0; k < a.length; k++) {
    const v = a[k];
    if (v === "--") break;
    const eq = v.indexOf("=");
    const name = eq > 0 ? v.slice(0, eq) : v;
    if (v.startsWith("--") && long.includes(name)) {
      if (eq > 0) out.push({ text: v.slice(eq + 1) });
      else if (name !== "--open-files-in-pager" && k + 1 < a.length) out.push({ text: a[++k] });
    } else if (short && v === short && k + 1 < a.length) out.push({ text: a[++k] });
    else if (short && v.startsWith(short) && v.length > 2) out.push({ text: v.slice(2) });
    else if (sub === "grep" && v.startsWith("-O") && v.length > 2) out.push({ text: v.slice(2) });
  }
  return out;
}
/** Git config that redirects where git pushes or fetches: a remote's url/pushurl/push refspec, a url rewrite. */
const GIT_REMOTE_CONFIG = /^(remote\.|url\.|push\.)/i;
/** Environment that swaps the config file git reads (and with it hooksPath, aliases, includes). */
const GIT_HOME_ENV = /^(HOME|XDG_CONFIG_HOME)=/;
/** Environment that injects git config into every git command. */
const GIT_CONFIG_ENV = /^GIT_CONFIG_(COUNT|KEY_\d+|PARAMETERS|GLOBAL|SYSTEM)=/;
const SCRIPT_EXT = /\.(sh|js|mjs|cjs|ts|mts|cts|py)$/;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const words = (cmd) => cmd.trim().split(/\s+/);
/** Rule words peeled like a command's (`npx playwright test` → `playwright test`). */
const peel = (ws) => {
  const rest = ws.slice(programIndex(toks(ws)));
  return rest.length ? rest : ws;
};

/**
 * The deny rules for the merge gate: a worker never runs it, it is the orchestrator's, one PR at
 * a time. The command's program decides the matcher: a shell + script, or a program written as a
 * path, becomes a `path` rule (it matches when that file is executed, from any cwd); anything else
 * an `argv` rule. Every other word that looks like a repo script gets a `path` rule too. When the
 * fast gate is the merge gate plus extra words (`npm run check` + `-- --fast`), those words allow it.
 */
function gateRules(merge, fast) {
  const m = words(merge);
  const f = words(fast);
  const allowWith = f.length > m.length && m.every((w, i) => f[i] === w) ? f.slice(m.length) : undefined;
  const reason = `\`${merge}\` is the merge gate: the orchestrator's alone. Run \`${fast}\` plus your diff's tests.`;
  const rule = (r) => ({ ...r, ...(allowWith && { allowWith }), reason });
  const w = m.slice(programIndex(toks(m)));
  if (!w.length) return [];
  const rules = [];
  let primary = 0;
  if (SHELLS.has(bare(w[0])) && w.some((x, i) => i > 0 && !x.startsWith("-"))) {
    primary = w.findIndex((x, i) => i > 0 && !x.startsWith("-"));
    rules.push(rule({ path: w[primary] }));
  } else if (w[0].includes("/")) rules.push(rule({ path: w[0] }));
  else rules.push(rule({ argv: w }));
  w.forEach((x, i) => {
    if (i > 0 && i !== primary && !x.startsWith("-") && (x.includes("/") || SCRIPT_EXT.test(x))) rules.push(rule({ path: x }));
  });
  return rules;
}

/**
 * The repo's rules from its contract (null = engine rules only; the CLI never passes null for a
 * sapu worker — a missing contract blocks it instead).
 */
export function compileRules(contract) {
  const g = contract ? contract.guard : { envFiles: [], postgres: null, deny: [] };
  const deny = g.deny.map((r) => (r.argv ? { ...r, argv: peel(r.argv) } : r));
  if (contract) deny.push(...gateRules(contract.gate.merge, contract.gate.fast));
  // guard.postgres, then each guard.databases entry: one matcher per engine and entry.
  const dbEntry = (engine, d) => ({ engine, ports: new Set(d.ports.map(Number)), dbs: new Set(d.databases), label: `${engine === "postgres" ? "" : `${engine} `}${[...d.ports.map((p) => `:${p}`), ...d.databases].join(", ")}` });
  const dbs = [...(g.postgres ? [["postgres", g.postgres]] : []), ...(Array.isArray(g.databases) ? g.databases.map((d) => [d.engine, d]) : [])];
  return {
    base: contract ? contract.baseBranch : null,
    // lowercase: a case-insensitive filesystem (macOS) opens `.ENV` as `.env`
    envFiles: new Set([...ENV_FLOOR, ...g.envFiles].map((f) => f.toLowerCase())),
    dbs: dbs.filter(([, d]) => d.ports.length + d.databases.length > 0).map(([engine, d]) => dbEntry(engine, d)),
    deny,
    // The labels only the owner applies (compared without case, as GitHub does): the one accepting an
    // outsider's issue, the one marking a finding only the owner can rule on, and the provenance of an
    // agent-filed issue (removing it would launder the issue into a plain trusted one).
    ownerLabels: [acceptedLabel(contract), needsOwnerLabel(contract), agentFiledLabel(contract)].map((l) => l.toLowerCase()),
    // The worker step budget: the contract's tuning.stepBudget over the defaults.
    steps: resolveTuning(contract).stepBudget,
  };
}

// gh's own commands (`gh --help`, help topics included). Any other first word is an alias or an
// extension, which the guard cannot see through: refused. `co` is gh's built-in alias for `pr checkout`.
const GH_COMMANDS = new Set([
  "agent-task", "alias", "api", "attestation", "auth", "browse", "cache", "codespace", "completion", "config", "copilot", "discussion",
  "extension", "gist", "gpg-key", "help", "issue", "label", "licenses", "org", "pr", "preview", "project", "release", "repo", "ruleset",
  "run", "search", "secret", "skill", "ssh-key", "status", "variable", "workflow",
  "accessibility", "actions", "environment", "exit-codes", "formatting", "mintty", "reference", "telemetry",
]);
// Options of `git fetch`/`git pull` that take their value as the next word.
const FETCH_VALUE_OPTS = new Set(["--depth", "--deepen", "--shallow-since", "--shallow-exclude", "-j", "--jobs", "--upload-pack", "-o", "--server-option", "--negotiation-tip", "--refmap", "--filter", "-s", "--strategy", "-X", "--strategy-option"]);
/** The words of `v` a label name could be (URL-decoded, lower case): does one of them name one of `labels`? */
const namesLabel = (v, labels) => {
  let s = v;
  try {
    s = decodeURIComponent(v);
  } catch {
    /* not URL-encoded */
  }
  const words = s.toLowerCase().split(/[\s,="'/[\]{}()]+/);
  return [].concat(labels).some((l) => words.includes(l));
};

const ENGINE_ONLY = compileRules(null);

// ---- env files ------------------------------------------------------------------------------

/** Shell brace expansion (`.{env,md}`), innermost group first; null when it would explode (treated as a match). */
function expandBraces(s, out = [], budget = { n: 256 }) {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(s);
  if (!m) {
    if (--budget.n < 0) return null;
    out.push(s);
    return out;
  }
  for (const alt of m[1].split(",")) if (expandBraces(s.slice(0, m.index) + alt + s.slice(m.index + m[0].length), out, budget) === null) return null;
  return out;
}

/**
 * A file-name glob as a regex, by default with the shell's dotfile rule: a leading `*` or `?`
 * never matches a leading `.` (so `*` is not `.env`), but a bracket may (`[.]env` is). `dotfiles`
 * drops that rule (ripgrep's `-g`). Negated brackets and POSIX classes are read as "any
 * character": the guard asks whether a glob COULD match.
 */
/**
 * The bracket expression opening at g[i], read as fnmatch/find read it, or null when it never
 * closes (then `[` is a literal). `\x` is the literal x, also as a range end and before `]`; a `]`
 * first in the set is a member. Negated sets and `[:class:]`, `[.coll.]`, `[=equiv=]` read as
 * "any character" (the guard asks whether a glob COULD match). A reversed range (`[t-h]`, as in a
 * Markdown `[Test-health]`) gets both ends and everything between: tools disagree on it, and a
 * regex built from it as written would throw. `escapes` = false: `\\` is a member like any other.
 */
function bracket(g, i, escapes = true) {
  const e = (ch) => (/[\\\]^-]/.test(ch) ? `\\${ch}` : ch);
  let j = i + 1;
  let any = g[j] === "!" || g[j] === "^";
  if (any) j++;
  let cls = "";
  const lit = (k) => (escapes && g[k] === "\\" && k + 1 < g.length ? [g[k + 1], k + 1] : [g[k], k]);
  for (let first = true; j < g.length; j++, first = false) {
    if (g[j] === "]" && !first) return { end: j, cls: any ? "[^/]" : `[${cls}]` };
    if (g[j] === "[" && /[:.=]/.test(g[j + 1] ?? "")) {
      const close = g.indexOf(`${g[j + 1]}]`, j + 2);
      if (close > 0) {
        any = true;
        j = close + 1;
        continue;
      }
    }
    const [lo, k] = lit(j);
    j = k;
    if (g[j + 1] === "-" && j + 2 < g.length && g[j + 2] !== "]") {
      const [hi, m] = lit(j + 2);
      const [a, b] = [lo, hi].sort();
      cls += `${e(a)}-${e(b)}`;
      j = m;
    } else cls += e(lo);
  }
  // `[.\]env` never closes when `\]` is an escape, yet macOS fnmatch reads it as the set {.} then
  // `env`: read `\` as a member and close at the first `]`, as the guard always did.
  return escapes ? bracket(g, i, false) : null;
}

function globRegex(g, dotfiles = false) {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") re += i === 0 && !dotfiles ? "(?!\\.)[^/]*" : "[^/]*";
    else if (c === "?") re += i === 0 && !dotfiles ? "[^./]" : "[^/]";
    else if (c === "\\" && i + 1 < g.length) re += esc(g[++i]);
    else if (c === "[") {
      const b = bracket(g, i);
      if (!b) {
        re += "\\[";
        continue;
      }
      re += b.cls;
      i = b.end;
    } else re += esc(c);
  }
  try {
    return new RegExp(`^${re}$`, "i");
  } catch {
    return /[\s\S]*/;
  }
}

function isEnvName(name, rules, dotfiles, escapes) {
  if (rules.envFiles.has(name.toLowerCase())) return true;
  if (!(escapes ? /[*?[\\]/ : /[*?[]/).test(name)) return false; // `escapes`: `\.env` is `.env` to find/fnmatch
  const re = globRegex(name, dotfiles);
  return [...rules.envFiles].some((n) => re.test(n));
}

/**
 * Does this word name a protected env file — itself, as an option/assignment value
 * (`--env-file=.env`), a glob or a brace list? `dotfiles`: a leading wildcard may match a dotfile.
 * `escapes`: a backslash escapes, as in a glob the program matches itself (`find -name '\\.env'`).
 */
function isEnvFile(v, rules, { dotfiles = false, escapes = false } = {}) {
  const eq = v.lastIndexOf("=");
  for (const c of eq >= 0 ? [v, v.slice(eq + 1)] : [v]) {
    const alts = expandBraces(c);
    if (alts === null || alts.some((x) => isEnvName(path.basename(x.replace(/\/+$/, "")), rules, dotfiles, escapes))) return true;
  }
  return false;
}

// ---- protected Postgres targets -----------------------------------------------------------------

const pct = (s) => s.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));

/** A URL (`scheme://[user@]host[:port][,host:port]/db?…`) with a protected port after any host, or a protected database as its path. */
function urlTarget(v, isPort, isDb) {
  for (const m of v.matchAll(/[A-Za-z][A-Za-z0-9+.-]*:\/\/([^\s'"]*)/g)) {
    const rest = m[1];
    const cut = rest.search(/[/?#]/);
    const authority = cut < 0 ? rest : rest.slice(0, cut);
    for (const h of authority.slice(authority.lastIndexOf("@") + 1).split(",")) if (isPort(/:(\d+)$/.exec(pct(h))?.[1])) return true;
    if (cut >= 0 && rest[cut] === "/" && isDb(pct(rest.slice(cut + 1).split(/[/?#]/)[0]))) return true;
  }
  return false;
}

/** Ports compare as numbers (`-p 06543` is 6543); a database path counts only inside a URL (`2>/dev/null` is not db `dev`). */
function dbTarget(values, prog, pg) {
  if (!pg) return false;
  if (REMOTE_EXEC.has(prog)) {
    // `docker exec db psql app_dev`, `ssh host "psql app_dev"`: check what the Postgres tool gets.
    const flat = values.flatMap((v) => v.split(/\s+/)).filter(Boolean);
    const k = flat.findIndex((v) => PG_TOOLS.has(bare(v)));
    if (k >= 0 && dbTarget(flat.slice(k + 1), bare(flat[k]), pg)) return true;
  }
  const isPort = (x) => /^\d+$/.test(x ?? "") && pg.ports.has(Number(x));
  const isDb = (x) => x !== undefined && pg.dbs.has(x);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if ((v === "-p" || v === "--port") && isPort(values[i + 1])) return true;
    if ((v === "-d" || v === "--dbname") && isDb(values[i + 1])) return true;
    if (isPort(/^-p(\d+)$/.exec(v)?.[1]) || isDb(/^-d(.+)$/.exec(v)?.[1])) return true;
    if (PG_TOOLS.has(prog) && isDb(v)) return true;
    // key=value inside a word: --port=/--dbname=, PGPORT=/PGDATABASE=, libpq conninfo, URL query parameters
    for (const m of v.matchAll(/(?:^|[^A-Za-z0-9_])(port|dbname|PGPORT|PGDATABASE)\s*=\s*['"]?([^\s'"&;]*)/gi)) {
      if (/port$/i.test(m[1]) ? isPort(pct(m[2])) : isDb(pct(m[2]))) return true;
    }
    if (v.includes("://") && urlTarget(v, isPort, isDb)) return true;
  }
  return false;
}

// ---- protected databases of the other engines (guard.databases) -----------------------------------

/** Each engine's clients, and the flags that name its port and database. */
const DB_CLIENTS = {
  mysql: { tools: new Set(["mysql", "mysqldump", "mysqladmin", "mysqlimport", "mysqlcheck", "mysqlshow", "mysqlsh", "mycli", "mariadb", "mariadb-dump", "mariadb-admin", "mariadb-import", "mariadb-check", "mariadb-show"]), port: ["-P", "--port"], db: ["-D", "--database"], env: /^MYSQL_TCP_PORT=(\d+)$/ },
  mongodb: { tools: new Set(["mongosh", "mongo", "mongodump", "mongorestore", "mongoexport", "mongoimport", "mongofiles", "mongostat", "mongotop"]), port: ["--port"], db: ["-d", "--db"] },
  redis: { tools: new Set(["redis-cli", "valkey-cli", "keydb-cli"]), port: ["-p"], db: ["-n"] },
};

/**
 * Does a command reach protected database `t` (mysql, mongodb, redis)? From any program: a URL with
 * its port or database (`mysql://…:3307/x`, `mongodb://…/app_dev`), MYSQL_TCP_PORT. From the
 * engine's own clients (also through docker/kubectl/ssh): the port and database flags (`-P 3307`,
 * `-P3307`, `--port=3307`, `-D app`, `--db app`, redis `-p`/`-n`), a word naming the database
 * (`mysql app_dev`, `mysqladmin drop app_dev`, SQL in `-e`), and mongosh's `host:port/db`.
 */
function engineTarget(values, prog, t) {
  const c = DB_CLIENTS[t.engine];
  if (REMOTE_EXEC.has(prog)) {
    const flat = values.flatMap((v) => v.split(/\s+/)).filter(Boolean);
    const k = flat.findIndex((v) => c.tools.has(bare(v)));
    if (k >= 0 && engineTarget(flat.slice(k + 1), bare(flat[k]), t)) return true;
  }
  const isPort = (x) => /^\d+$/.test(x ?? "") && t.ports.has(Number(x));
  const isDb = (x) => x !== undefined && t.dbs.has(x);
  const client = c.tools.has(prog);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v.includes("://") && urlTarget(v, isPort, isDb)) return true;
    if (c.env && isPort(c.env.exec(v)?.[1])) return true;
    if (!client) continue;
    if ((c.port.includes(v) && isPort(values[i + 1])) || (c.db.includes(v) && isDb(values[i + 1]))) return true;
    const eq = /^(--[\w-]+)=(.*)$/.exec(v);
    if (eq && ((c.port.includes(eq[1]) && isPort(eq[2])) || (c.db.includes(eq[1]) && isDb(eq[2])))) return true;
    for (const o of [...c.port, ...c.db]) if (/^-[A-Za-z]$/.test(o) && v.length > 2 && v.startsWith(o) && (c.port.includes(o) ? isPort(v.slice(2)) : isDb(v.slice(2)))) return true;
    if (t.engine === "redis") continue; // redis's other words are commands and keys
    if (v.split(/[\s`'";,()=]+/).some(isDb)) return true;
    if (t.engine === "mongodb" && !v.includes("://")) {
      for (const part of v.split(",")) {
        if (isPort(/:(\d+)(?:\/|$)/.exec(part)?.[1]) || isDb(/^[\w.-]+(?::\d+)?\/([\w.-]+)$/.exec(part)?.[1])) return true;
      }
    }
  }
  return false;
}

/**
 * Does a word of the command name a protected SQLite file (absolute, or relative to <MAIN>), as the
 * cwd resolves it? Any program counts: opening it with a client and deleting it are both a reach.
 */
function sqliteTarget(values, t, here, main) {
  const want = [...t.dbs].map((f) => (path.isAbsolute(f) ? f : main ? path.join(main, f) : null)).filter(Boolean).flatMap((f) => [path.normalize(f), realpathOrSelf(f)]);
  if (!want.length) return false;
  return values.some((v) => {
    const w = v.slice(v.lastIndexOf("=") + 1).replace(/^(?:sqlite3?:\/\/|file:)/, "").replace(/\?.*$/, "");
    if (!w || (!path.isAbsolute(w) && (here === UNKNOWN || typeof here !== "string"))) return false;
    const abs = path.resolve(typeof here === "string" ? here : "/", w.replace(/^~(?=\/|$)/, process.env.HOME || "~"));
    return want.includes(path.normalize(abs)) || want.includes(realpathOrSelf(abs));
  });
}

// ---- contract deny rules ------------------------------------------------------------------------------

/** Every word of `need` appears in `args`, in this order (not necessarily adjacent). */
function inOrder(args, need) {
  let k = 0;
  for (const v of args) if (k < need.length && v === need[k]) k++;
  return k === need.length;
}
const runAliases = (prog, ws) => (PKG_MANAGERS.has(prog) ? ws.map((w) => RUN_ALIASES[w] ?? w) : ws);

/** Does the word `tok`, run from `dir`, name the repo path `want` (relative to its checkout root)? */
function samePath(tok, want, dir) {
  const w = path.normalize(want);
  const t = tok.replace(/^~(?=\/|$)/, process.env.HOME || "~");
  if (dir === UNKNOWN) {
    const n = path.normalize(t);
    return n === w || n.endsWith(`/${w}`);
  }
  const abs = path.resolve(dir, t);
  if (path.isAbsolute(w)) return abs === w || realpathOrSelf(abs) === realpathOrSelf(w);
  const root = gitRoot(path.dirname(abs));
  return root ? path.relative(root, abs) === w : abs.endsWith(`/${w}`);
}

/**
 * The `reason` of the first contract deny rule this command hits, or null. `argv` rules: same
 * program, rule words in order among ALL the arguments. `path` rules: only a path that is EXECUTED
 * — the program itself, or an argument of an interpreter — so reading, diffing or staging the
 * file is fine. git and gh are never subject to deny rules (their own rules below cover them).
 */
function denied(a, prog, deny, dir) {
  if (prog === "git" || prog === "gh") return null;
  const args = runAliases(prog, a.slice(1));
  // `node --run <s>` and `bun run <s>` run a package script, like `npm run <s>`.
  let script = null;
  const nodeRun = prog === "node" ? a.findIndex((v) => v === "--run" || v.startsWith("--run=")) : -1;
  if (nodeRun > 0) script = a[nodeRun] === "--run" ? a.slice(nodeRun + 1) : [a[nodeRun].slice("--run=".length), ...a.slice(nodeRun + 1)];
  else if (prog === "bun" && a[1] === "run") script = a.slice(2);
  const executed = [];
  if (a[0].includes("/")) executed.push(a[0]);
  if (INTERPRETERS.has(prog)) for (const v of a.slice(1)) executed.push(v.startsWith("-") ? v.slice(v.indexOf("=") + 1 || v.length) : v);
  for (const r of deny) {
    const rp = r.argv && bare(r.argv[0]);
    const hit = r.argv
      ? (rp === prog && inOrder(args, runAliases(prog, r.argv.slice(1)))) || (script !== null && PKG_MANAGERS.has(rp) && inOrder(["run", ...script], runAliases(rp, r.argv.slice(1))))
      : executed.some((v) => v && samePath(v, r.path, dir));
    if (hit && !(r.allowWith && inOrder(a.slice(1), r.allowWith))) return r.reason;
  }
  return null;
}

/** GraphQL's inline enum; a variable counts only as exactly NOT_PLANNED. */
const GQL_NOT_PLANNED = /\bstateReason\s*:\s*NOT_PLANNED\b/;
/** "not planned" in any spelling gh and GitHub take: not_planned, NOT_PLANNED, "Not Planned", not-planned. */
const notPlanned = (v) => typeof v === "string" && /^not[\s_-]*planned$/i.test(v.trim());

const BLOCK = {
  explorerBash:
    "the journey explorer's shell runs only its wrapper: `node <plugin>/scripts/argus-live.mjs pw …`, joined by `;`, `&&` or newlines, every argument a single-quoted literal or a plain word (no $, double quotes, globs, ~, pipes, redirections, substitutions or environment prefixes).",
  explorerRead:
    "the journey explorer reads only files committed at HEAD in the run's worktree, outside .argus/; page content and code search come through the wrapper.",
  explorerTool: "the journey explorer has only Bash (its wrapper), Read and StructuredOutput; it searches code through the wrapper's `code` command.",
  canary: "canary: the guard hook is live (this block is the expected answer; report guard_active: true).",
  deep: `command nesting too deep to check (more than ${MAX_DEPTH} levels of bash -c/eval/$( )/env -S): split it into simpler commands.`,
  stash: "bare `git stash`/pop/clear, an untagged push, or drop without a ref: the stash is shared by every worktree. Commit WIP instead, or `git stash push -m <tag>` and `apply <sha>`.",
  kill: "pkill/killall can stop another session's process. Kill only a PID you started.",
  merge: "only the orchestrator merges (sapu-merge.sh). Your job ends when the PR is open.",
  prCode:
    "`gh pr checkout`, fetching a PR ref (pull/*), or applying a patch (git apply/git am, or patch other than its --dry-run, whatever file it reads) runs a PR's code here — and a PR can be an outsider's. Only the orchestrator runs a PR, after `sapu-contract.mjs pr-trust` passes it. Read a PR with `gh pr diff <N> --name-only` and `sapu-contract.mjs pr-trust <N> --text`; a continuing worker takes over with `git reset --hard <sha>`.",
  foreignCode:
    "fetching or cloning code that is not origin's branches or tags (another remote or a URL, a raw commit SHA, a ref glob outside refs/heads and refs/tags, `git clone`, `gh repo clone`, `gh extension install`, `gh release download`, degit/tiged, a download piped into tar or unzip) can bring a fork's or a PR's code here, as a PR's code would. Work from origin's branches; only the orchestrator runs a PR, after `sapu-contract.mjs pr-trust` passes it.",
  ghUnknown:
    "that first word is not one of gh's own commands: an alias or an extension, which the guard cannot see through. Run the gh command itself.",
  acceptLabel:
    "the acceptance label, the needs-owner label and the agent-filed label are the owner's own acts: no agent applies, removes, creates, renames, deletes or clones them (an agent only files a new issue with the agent-filed or needs-owner label) — every agent works under the owner's token, so GitHub would record the change as the owner's decision. Report the issue instead.",
  ownerRuling:
    "closing an issue as not planned is the owner's ruling that the finding is intended; no agent makes it under the owner's token. Report it instead.",
  apiWrite: "`gh api` writing repository contents, git objects/refs or branches bypasses review. Push commits with git to your own branch; the orchestrator merges.",
  issue: "sapu files no issues from a subagent. Put the finding in the PR body; a security gap goes in your return (security_gaps).",
  orchestrator: "merging is the orchestrator's (sapu-merge.sh).",
  noVerify: "--no-verify, commit -n, or git config that changes the hook path, defines an alias, includes a config file or runs code (filter.*, core.fsmonitor, core.sshCommand, core.attributesFile, diff.external) — via -c, --config-env, GIT_CONFIG_* or git config — can skip the hook gate or hide changes. Fix what the hook reports.",
  gitProgram:
    "this names a program git runs (core.pager, core.editor, sequence.editor, credential.helper, gpg.program, a merge/diff driver or textconv, pager.<cmd>, hook.*, … through -c, --config-env or git config; or GIT_PAGER, GIT_EDITOR, GIT_SEQUENCE_EDITOR, GIT_SSH_COMMAND, GIT_ASKPASS, GIT_EXTERNAL_DIFF, PAGER, EDITOR … in front of git): code the guard cannot check. For one command only a no-op value passes (true, false, :, cat, or empty — GIT_EDITOR=true, -c core.pager=cat); a config file takes none, since every worktree and the orchestrator read it.",
  force: "plain force push (--force, -f, +refspec). Use --force-with-lease, and only on a branch whose commits are all yours.",
  remote: "git config or `git remote` that redirects where git pushes or fetches (remote.*, url.*) is the orchestrator's: every worktree shares it. Push your own branch to origin.",
  gitHome: "HOME=/XDG_CONFIG_HOME= in front of git swaps the config git reads (hooks path, aliases, includes). Run git with the environment it has.",
  graphqlFile: "`gh api graphql` with --input, a query read from a file (-F query=@…) or a query built by the shell ($( ), backticks, a variable): the mutation cannot be inspected. Pass the query inline with -f query='…'.",
  ghAlias: "`gh alias set/import` defines a command the guard cannot see through (an alias can be `pr merge`). Run the gh command itself.",
  worktrees: "--ignore-other-worktrees / `git worktree add --force` check out a branch another worktree holds; the orchestrator's alone.",
  index: "low-level index and object commands (update-index, checkout-index, read-tree, replace) can hide changes from git status and diff. Use ordinary git commands in your own worktree.",
  gitFiles: "a write to git's own files (a `.git` file or directory, ~/.gitconfig, ~/.config/git/, git config --global/--system/--file) can switch off hooks or redirect git for every checkout.",
  machineConfig: "a write to sapu's machine config (~/.config/sapu/, or removing ~/.config or ~ that holds it) can lift the scope lock its owner set for every repo on this machine. Only the person at this machine edits it.",
  pluginFiles:
    "a write to a plugin agents run under — its folder (CLAUDE_PLUGIN_ROOT), Claude Code's plugin store (~/.claude/plugins/: every installed copy, marketplace clone and the install records), a local marketplace's plugin sources, or the user settings (~/.claude/settings.json: hooks, enabledPlugins) — or `claude plugin install|update|uninstall|enable|disable|marketplace …` changes the rules every agent runs under. Only the person at this machine installs or updates plugins; change a plugin through a PR to its own repo.",
  pushBase: (base) => `a push to the base branch (${base || "main"}), main or master, or with --all/--mirror: only the orchestrator's merge moves those. Push your own branch.`,
  prisma: "can drop data or write an unreviewed migration. Use `prisma migrate dev --create-only` and review the SQL.",
  nodeModules: "a whole-directory node_modules symlink makes every workspace package resolve to <MAIN>'s unedited source. Use the repo's worktree setup (.claude/sapu/worker.md).",
  env: "real env files hold secrets and are never linked, copied, sourced, read or written in a worktree. Tests run on the repo's committed test env (.claude/sapu/worker.md).",
  db: (label) => `protected database (${label}; .claude/sapu.json guard.postgres or guard.databases): other sessions use it. Use your own throwaway test DB (.claude/sapu/worker.md).`,
  refs: "branch deletion/force-moves (local or remote), worktree removal and ref rewrites touch refs every worktree shares; they are the orchestrator's.",
  mainWrite: (main) => `a write into the main checkout (${main}) outside its .claude/worktrees/ (and, for a subagent that is not a sapu worker, outside ${STATE_DIRS.map((d) => `${d}/`).join(", ")}): other sessions share it. Write only inside your own worktree.`,
  brokenContract: (main, error) => `the sapu contract of ${main}, which this call touches, is unreadable, so nothing there is allowed: ${error}`,
};

/** The main checkout among `mains` that `real` is written into (outside its worktrees and, for a non-worker, its state dirs), or null. */
function mainWrittenOf(real, mains, worker) {
  return mains.find((m) => m && inMain(real, m) && !(!worker && inStateDir(real, m))) || null;
}

/** The text a wrapper runs as a command of its own — `env -S '<cmd>'`, `npx -c`/`npm exec -c '<cmd>'` — or null. */
function innerCommand(t, at) {
  if (at >= t.length) return null;
  const wrappers = t.slice(0, at).map((x) => bare(x.v));
  const m = (wrappers.includes("env") && ENV_SPLIT.exec(t[at].v)) || (wrappers.some((w) => w === "npx" || w === "bunx" || w === "script" || PKG_MANAGERS.has(w)) && EXEC_CALL.exec(t[at].v));
  if (!m) return null;
  const inline = m[1] !== "";
  return [inline ? m[1] : (t[at + 1]?.v ?? ""), ...t.slice(at + (inline ? 1 : 2)).map((x) => x.v)].join(" ");
}

/**
 * The directories of <MAIN> where a NON-worker subagent may write: the plugin's own state (argus,
 * momus and nemesis cycles, specialists' agent memory, dream journals). A sapu worker writes none
 * of them; nobody writes anywhere else in <MAIN> outside `.claude/worktrees/`.
 */
export const STATE_DIRS = [".argus", ".momus", ".nemesis", ".claude/agent-memory", ".claude/agent-memory-local", "dreams"];

/** Is `real` (a real path) inside one of <MAIN>'s STATE_DIRS? */
function inStateDir(real, main) {
  const m = realPathOf(main);
  return STATE_DIRS.some((d) => {
    const dir = path.join(m, d);
    return real === dir || real.startsWith(dir + path.sep);
  });
}

/** Is `real` (a real path) inside <MAIN> but outside its `.claude/worktrees/`? */
function inMain(real, main) {
  const m = realPathOf(main);
  return inside(real, m) && !inside(real, path.join(m, ".claude", "worktrees"));
}

const USER_HOMES = new Map();
/** The home directory the shell gives `~name` (the passwd entry, not $HOME), or null for no such user. */
function userHome(name) {
  if (!USER_HOMES.has(name)) {
    let home = null;
    try {
      const me = os.userInfo();
      if (name === me.username) home = me.homedir;
      else {
        // `name` is [A-Za-z0-9._-] only: nothing in it reaches the shell as syntax.
        const out = execFileSync("/bin/sh", ["-c", `printf %s ~${name}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
        home = out && !out.startsWith("~") ? out : null;
      }
    } catch {
      home = null;
    }
    USER_HOMES.set(name, home);
  }
  return USER_HOMES.get(name);
}

/**
 * The word `tok` with a leading `~`, `$HOME` or `${HOME}` read as HOME, `~name` as that user's home,
 * `~+` as the cwd `dir` and `~-` as the previous one `prev` (only at the start); null while another
 * variable, `$( )` or backtick is left in it, or for a `~+`/`~-` whose directory is unknown. `~name`
 * of no such user stays a literal word, as in the shell.
 */
function expandHome(tok, dir = UNKNOWN, prev = UNKNOWN) {
  const home = process.env.HOME;
  let m = home ? /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(tok.v) : null;
  let base = home;
  if (!m) {
    const u = /^~([+-]|[A-Za-z0-9_][A-Za-z0-9._-]*)(?=\/|$)/.exec(tok.v);
    if (u && (u[1] === "+" || u[1] === "-")) {
      base = u[1] === "+" ? dir : prev;
      if (typeof base !== "string") return null;
      m = u;
    } else if (u && (base = userHome(u[1])) !== null) m = u;
  }
  const rest = m ? tok.v.slice(m[0].length) : tok.v;
  if (tok.dyn && /[$`]/.test(rest)) return null;
  return m ? base + rest : tok.v;
}

/**
 * The words the shell's brace expansion makes of `tok` (`a{,.bak}` → `a a.bak`). A sequence
 * (`{a..z}`), or a list too long to expand, reads as `*`: judged as a glob.
 */
function braceWords(tok) {
  if (!/\{[^{}]*(,|\.\.)[^{}]*\}/.test(tok.v)) return [tok];
  let ws = expandBraces(tok.v);
  if (ws === null) {
    let v = tok.v;
    while (/\{[^{}]*\}/.test(v)) v = v.replace(/\{[^{}]*\}/g, "*");
    ws = [v];
  }
  return ws.map((v) => ({ v: v.replace(/\{[^{}]*\.\.[^{}]*\}/g, "*"), dyn: tok.dyn }));
}

/**
 * Where writing (or removing) the word `tok`, from `dir`, lands: {abs, real, glob}, or null when
 * it cannot be known (a variable other than a leading $HOME, or a relative path from an unknown
 * cwd). `follow` = the write goes through a final symlink (`>`, cp); removing or replacing a link
 * (`rm link`, `ln`, `mv`) does not, unless the word ends in `/`. `glob` = for a word with `*`, `?`
 * or `[`, the absolute pattern, spelled as written and through the real path of its literal
 * directories; null otherwise. `prev` is the previous cwd (`~-`).
 */
function writeTarget(tok, follow, dir, prev = UNKNOWN) {
  if (!tok || tok.v === "") return null;
  const t = expandHome(tok, dir, prev);
  if (t === null || (!path.isAbsolute(t) && dir === UNKNOWN)) return null;
  const base = dir === UNKNOWN ? "/" : dir;
  const abs = path.resolve(base, t);
  const real = follow || t.endsWith("/") ? realPathOf(abs) : path.join(realPathOf(path.dirname(abs)), path.basename(abs));
  if (!/[*?[]/.test(t)) return { abs, real, glob: null };
  const segs = abs.split(path.sep);
  const g = segs.findIndex((s) => /[*?[]/.test(s));
  return { abs, real, glob: [abs, path.join(realPathOf(segs.slice(0, g).join(path.sep) || path.sep), ...segs.slice(g))] };
}

/** Is `x` inside `dir` or `dir` itself? */
const inside = (x, dir) => x === dir || x.startsWith(dir + path.sep);
/**
 * `inside` with letter case ignored, for the protected names: a case-insensitive disk (macOS) opens
 * `.git` as `.GIT`, and the real path of a name that does not exist yet, or of a removed entry's last
 * segment, keeps the case it was written in. On a case-sensitive disk this is a false block, never a miss.
 */
const insideAnyCase = (x, dir) => inside(x.toLowerCase(), dir.toLowerCase());

/** Git's own files under HOME: ~/.gitconfig and git's config dir, for HOME and its real path. */
function gitHomePaths() {
  const home = process.env.HOME;
  if (!home) return [];
  return [home, realPathOf(home)].flatMap((h) => [path.join(h, ".gitconfig"), path.join(process.env.XDG_CONFIG_HOME || path.join(h, ".config"), "git")]);
}

/**
 * Is `p`, or a directory above it, a git directory (HEAD, objects/ and refs/ in it)? That is git's
 * own directory wherever it lies and however it is named: a `--separate-git-dir` store, a
 * submodule's under `.git/modules/`, a bare repository.
 */
function inGitDir(p) {
  for (let d = p; ; d = path.dirname(d)) {
    if (["HEAD", "objects", "refs"].every((x) => fs.existsSync(path.join(d, x)))) return true;
    if (path.dirname(d) === d) return false;
  }
}

/** Is this one of git's own files: a `.git` file or directory (or anything in one), any other git directory, ~/.gitconfig, ~/.config/git/…? */
function isGitFile(p) {
  return p.split(path.sep).some((s) => s.toLowerCase() === ".git") || inGitDir(p) || gitHomePaths().some((x) => insideAnyCase(p, x));
}

/**
 * sapu's machine config dir (~/.config/sapu/) under HOME and HOME's real path, and the real
 * directory behind it (a symlinked ~/.config). Never $XDG_CONFIG_HOME: sapu-contract.mjs reads only
 * this one path.
 */
function machineConfigDirs() {
  const home = process.env.HOME;
  if (!home) return [];
  return [home, realPathOf(home)].flatMap((h) => [path.join(h, ".config", "sapu"), realPathOf(path.join(h, ".config", "sapu"))]);
}

/**
 * Does writing `p` touch sapu's machine config, whose absence or loosening lifts the scope lock its
 * owner set? Anything inside machineConfigDirs(). With `replaces` (the write removes or replaces
 * the entry itself, or writes a whole tree there: rm, mv, ln, a recursive copy, install -d) also
 * every directory above it (`~/.config`, `~`, …), which takes the config with it.
 */
function isMachineConfigFile(p, replaces = false) {
  return machineConfigDirs().some((d) => insideAnyCase(p, d) || (replaces && insideAnyCase(d, p)));
}

/** This plugin's own folder, wherever it was loaded from (an installed copy, or `--plugin-dir`). */
const OWN_PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * What the rules a subagent runs under come from, besides the contract: the active plugin's folder
 * (CLAUDE_PLUGIN_ROOT, which Claude Code sets for the hook, and this script's own plugin root),
 * Claude Code's plugin store (`<CLAUDE_CONFIG_DIR or ~/.claude>/plugins/`: every installed copy,
 * every marketplace clone, the install and marketplace records), its user settings (hooks,
 * enabledPlugins, disableAllHooks), and for a marketplace whose source is a local directory
 * (known_marketplaces.json) its `.claude-plugin/` and every plugin source it lists. Real paths too.
 */
let pluginCache = { key: null, dirs: [] };
function pluginDirs() {
  const cd = process.env.CLAUDE_CONFIG_DIR || (process.env.HOME ? path.join(process.env.HOME, ".claude") : "");
  const key = `${cd}\0${process.env.CLAUDE_PLUGIN_ROOT ?? ""}`;
  if (pluginCache.key === key) return pluginCache.dirs;
  const out = [OWN_PLUGIN_ROOT];
  if (process.env.CLAUDE_PLUGIN_ROOT) out.push(path.resolve(process.env.CLAUDE_PLUGIN_ROOT));
  const readJson = (f) => {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      return null;
    }
  };
  if (cd) {
    const c = path.resolve(cd);
    out.push(path.join(c, "plugins"), path.join(c, "settings.json"), path.join(c, "settings.local.json"));
    const known = readJson(path.join(c, "plugins", "known_marketplaces.json"));
    for (const m of known && typeof known === "object" ? Object.values(known) : []) {
      for (const p of [m?.installLocation, m?.source?.path]) {
        if (typeof p !== "string" || !p) continue;
        let r = path.resolve(p);
        try {
          if (fs.statSync(r).isFile()) r = path.basename(path.dirname(r)) === ".claude-plugin" ? path.dirname(path.dirname(r)) : path.dirname(r);
        } catch {
          continue;
        }
        out.push(path.join(r, ".claude-plugin"));
        const list = readJson(path.join(r, ".claude-plugin", "marketplace.json"))?.plugins;
        for (const pl of Array.isArray(list) ? list : []) if (typeof pl?.source === "string") out.push(path.resolve(r, pl.source));
      }
    }
  }
  pluginCache = { key, dirs: [...new Set(out.flatMap((p) => [p, realPathOf(p)]))] };
  return pluginCache.dirs;
}

/** A checkout's worktrees are not what a marketplace serves, even when a plugin's source is that checkout's root. */
const inPluginDir = (p, d) => insideAnyCase(p, d) && !insideAnyCase(p, path.join(d, ".claude", "worktrees"));

/** Does writing `p` change a plugin a subagent runs under? With `replaces`, a directory above one counts. */
function isPluginFile(p, replaces = false) {
  return pluginDirs().some((d) => inPluginDir(p, d) || (replaces && insideAnyCase(d, p)));
}

const isGlob = (s) => /[*?[]/.test(s);

/**
 * Can the absolute glob `pattern` expand into one of `paths`, an ancestor of one (removing it takes
 * the path along), or anything inside one? Matched segment by segment as the shell expands it (a
 * leading `*`/`?` never matches a leading `.`; `**` reaches any depth), case-insensitively, so
 * `~/.conf/*` and `*.log` in HOME reach nothing of `~/.config/sapu`.
 */
function globReaches(pattern, paths) {
  const ps = pattern.split(path.sep).filter(Boolean);
  return paths.some((x) => {
    const xs = x.split(path.sep).filter(Boolean);
    for (let k = 0; k < Math.min(ps.length, xs.length); k++) {
      if (ps[k] === "**") return true;
      if (isGlob(ps[k]) ? !globRegex(ps[k]).test(xs[k]) : ps[k].toLowerCase() !== xs[k].toLowerCase()) return false;
    }
    return true;
  });
}

/**
 * The block reason when write target `w` is, or as a glob may expand into, git's own files (a
 * `.git` anywhere included) or sapu's machine config; else null. `tree`: the write lands a whole
 * tree there (a recursive copy, install -d), so a directory above a protected path counts.
 */
function protectedTarget(w, follow, tree = false) {
  if (w.glob) {
    if (w.glob.some((g) => globReaches(g, machineConfigDirs()))) return BLOCK.machineConfig;
    if (w.glob.some((g) => globReaches(g, gitHomePaths()) || g.split(path.sep).some((s) => isGlob(s) && globRegex(s).test(".git")))) return BLOCK.gitFiles;
    const literal = (g) => g.split(path.sep).slice(0, g.split(path.sep).findIndex(isGlob)).join(path.sep);
    if (w.glob.some((g) => pluginDirs().some((d) => globReaches(g, [d]) && !inside(literal(g), path.join(d, ".claude", "worktrees"))))) return BLOCK.pluginFiles;
  }
  const replaces = !follow || tree;
  if (isGitFile(w.abs) || isGitFile(w.real)) return BLOCK.gitFiles;
  if (isMachineConfigFile(w.abs, replaces) || isMachineConfigFile(w.real, replaces)) return BLOCK.machineConfig;
  if (replaces && gitHomePaths().some((x) => insideAnyCase(x, w.abs) || insideAnyCase(x, w.real))) return BLOCK.gitFiles;
  if (isPluginFile(w.abs, replaces) || isPluginFile(w.real, replaces)) return BLOCK.pluginFiles;
  return null;
}

/** Output redirection targets: `> f`, `>> f`, `2> f`, `&> f`, `>& f`, `<> f` (`>&2`, `2>&1` duplicate a descriptor: no file). */
function redirectTargets(ts) {
  const out = [];
  for (let k = 0; k + 1 < ts.length; k++) {
    const m = /^\d*(>>?|>\||&>>?|>&|<>)$/.exec(ts[k].v);
    if (!m || (m[1] === ">&" && /^(\d+|-)$/.test(ts[k + 1].v))) continue;
    out.push({ tok: ts[k + 1], follow: true });
  }
  return out;
}

/** The words of a command without its redirections (an operator and the word after it). */
const withoutRedirects = (argv) => argv.filter((x, i) => !REDIRECT_OP.test(x.v) && !(i > 0 && REDIRECT_OP.test(argv[i - 1].v)));

/** The arguments that are not options (`--` ends options); `takesValue(opt)` skips an option's value. */
function nonOptions(argv, takesValue = () => false) {
  const out = [];
  let rest = false;
  for (let i = 1; i < argv.length; i++) {
    const v = argv[i].v;
    if (rest || v === "-" || !v.startsWith("-")) out.push(argv[i]);
    else if (v === "--") rest = true;
    else if (takesValue(v)) i++;
  }
  return out;
}

/**
 * The files a write command writes or removes: tee, cp/mv/install/ln destinations, sed -i/perl -i
 * files, rm, patch; brace lists expanded. A copy, move or link into a directory also lands at
 * `<dest>/<name>` (with --parents, `<dest>/<source path>`), and a recursive copy of a source's
 * contents (`x/`, `x/.`, `.`, -T, or a source the shell builds) in `<dest>` itself; `tree` marks a
 * target written as a whole tree (recursive copy, mv, install -d), where an ancestor counts.
 */
function writeTargets(prog, words) {
  const argv = withoutRedirects(words).flatMap(braceWords);
  const a = argv.map((x) => x.v);
  const each = (toks, follow) => toks.map((tok) => ({ tok, follow }));
  // The value of an option (`-t DIR`, `--target-directory=DIR`, `-tDIR`), or null.
  const optValue = (re) => {
    for (let i = 1; i < argv.length; i++) {
      const m = re.exec(a[i]);
      if (m) return (m[1] ?? m[2]) ? { v: m[1] ?? m[2], dyn: argv[i].dyn } : (argv[i + 1] ?? null);
    }
    return null;
  };
  const targetDir = () => optValue(/^(?:--target-directory(?:=(.+))?|-t(.+)?)$/);
  if (prog === "patch") {
    // patch writes the files it patches where it runs (-d moves that), plus -o and a named original.
    const dir = optValue(/^(?:--directory(?:=(.+))?|-d(.+)?)$/) ?? { v: ".", dyn: false };
    const out = optValue(/^(?:--output(?:=(.+))?|-o(.+)?)$/);
    const pos = nonOptions(argv, (v) => /^(-[dopirBDFVzYg]|--directory|--output|--input|--strip|--reject-file|--prefix|--suffix)$/.test(v));
    return each([dir, out, pos[0]].filter(Boolean), true);
  }
  if (prog === "tee") return each(nonOptions(argv), true);
  if (prog === "rm") return each(nonOptions(argv), false);
  if (prog === "cp" || prog === "mv" || prog === "install" || prog === "ln") {
    const args = nonOptions(argv, (v) => /^(-t|--target-directory|-S|--suffix)$/.test(v) || (prog === "install" && /^-[mog]$/.test(v)));
    const dir = targetDir();
    const last = args[args.length - 1];
    if (prog === "install" && a.some((v) => /^-[a-zA-Z]*d/.test(v))) return args.map((tok) => ({ tok, follow: true, tree: true }));
    const sources = dir ? args : args.slice(0, -1);
    const dest = dir ?? (args.length > 1 ? last : null);
    const tree = prog === "mv" || (prog === "cp" && a.some((v) => /^-[a-zA-Z]*[rRa]/.test(v) || /^--(recursive|archive)$/.test(v)));
    const noTargetDir = a.some((v) => v === "--no-target-directory" || /^-[a-zA-Z]*T/.test(v));
    const follow = prog === "cp" || prog === "install";
    const landings = !dest
      ? []
      : sources.map((s) => {
          const contents = s.dyn || noTargetDir || /(^|\/)\.\.?\/?$/.test(s.v) || (tree && s.v.endsWith("/"));
          const name = a.includes("--parents") ? s.v.replace(/^\/+/, "") : path.basename(s.v);
          return { tok: contents ? dest : { v: `${dest.v.replace(/\/+$/, "")}/${name}`, dyn: dest.dyn }, follow, tree };
        });
    if (prog === "mv") return [...each(sources, false), ...each([dest].filter(Boolean), true), ...landings];
    if (dir) return [...each([dir], true), ...landings];
    if (prog === "ln") return args.length === 1 ? each([{ v: path.basename(args[0].v), dyn: args[0].dyn }], false) : [...each([last].filter(Boolean), false), ...landings];
    return [...each([last].filter(Boolean), true), ...landings];
  }
  if (prog === "sed" || prog === "perl") {
    if (!a.slice(1).some((v) => (prog === "sed" ? /^(-[a-zA-Z]*i|--in-place)/ : /^-[a-zA-Z]*i/).test(v))) return [];
    const code = prog === "sed" ? /^(-[a-zA-Z]*[ef]|--expression|--file)$/ : /^-[a-zA-Z]*[eE]$/;
    const files = nonOptions(argv, (v) => code.test(v)).filter((x) => x.v !== "");
    // Without -e/-f the first word is the script, not a file.
    return each(a.some((v) => code.test(v) || /^--(expression|file)=/.test(v)) ? files : files.slice(1), true);
  }
  return [];
}

/** The directory `env -C/--chdir <dir>` runs its command in (UNKNOWN for a variable), or null. */
function envChdir(t, at, dir) {
  let out = null;
  for (let k = 1; k < at; k++) {
    const m = /^(?:-C|--chdir)(?:=(.*))?$/.exec(t[k].v);
    if (!m || !t.slice(0, k).some((x) => path.basename(x.v) === "env")) continue;
    const target = m[1] !== undefined ? { v: m[1], dyn: t[k].dyn } : t[k + 1];
    out = !target || target.dyn || dir === UNKNOWN ? UNKNOWN : path.resolve(dir, target.v);
  }
  return out;
}

function checkCommand(t, state, depth) {
  if (depth > MAX_DEPTH) return BLOCK.deep;
  const values = t.map((x) => x.v);
  if (values.includes("sapu-guard-canary")) return BLOCK.canary;
  const at = programIndex(t);
  const here = envChdir(t, at, state.dir) ?? state.dir;
  // The repo this command runs in, and its contract (TOUCHED REPO in decide()); without a resolver,
  // or where the place cannot be told, the scope the caller gave.
  const scope = (state.resolve && state.resolve(here)) || state;
  if (scope.error) return BLOCK.brokenContract(scope.main, scope.error);
  const { rules, main } = scope;
  const inner = innerCommand(t, at);
  if (inner !== null) return checkText(inner, here, state, depth + 1);
  const argv = t.slice(at);
  const a = argv.map((x) => x.v);
  const prog = a.length ? bare(a[0]) : "";

  // Values that are prose (commit messages, PR titles/bodies) are data, not targets.
  const skip = new Set();
  if (prog === "git" || prog === "gh") a.forEach((v, i) => MESSAGE_FLAGS.has(v) && skip.add(i + 1));
  const optValues = [];
  // Values the program glob-matches itself (find -name, rg -g): a leading `*` matches `.env` there.
  const globValues = prog === "find" ? a.filter((_, i) => i > 0 && FIND_GLOBS.has(a[i - 1])) : [];
  if (GREPS.has(prog)) {
    const g = grepArgs(prog, a);
    if (g.pattern > 0) skip.add(g.pattern);
    optValues.push(...g.values.map((x) => x.v));
    // a `!glob` only excludes files: `-g '!**/node_modules/**'` never names .env
    globValues.push(...g.values.filter((x) => GREP_GLOBS.has(x.opt) && !x.v.startsWith("!")).map((x) => x.v));
  }
  // A glob of wildcards only (`find -name '*'`, `rg -g '*'`) selects everything: no target, and
  // dropping it selects the same files.
  const globTargets = globValues.filter((v) => !/^[*?]+$/.test(v));
  // Assignments before the program count (`X=.env`, `PGPORT=…`), also with no program at all.
  const scanned = [...values.slice(0, at), ...a.filter((_, i) => i > 0 && !skip.has(i)), ...optValues];
  if (scanned.some((v) => GIT_CONFIG_ENV.test(v))) return BLOCK.noVerify;
  const db = rules.dbs.find((d) => (d.engine === "postgres" ? dbTarget(scanned, prog, d) : d.engine === "sqlite" ? sqliteTarget(scanned, d, here, main) : engineTarget(scanned, prog, d)));
  if (db) return BLOCK.db(db.label);
  if (scanned.some((v) => isEnvFile(v, rules)) || globTargets.some((v) => isEnvFile(v, rules, { dotfiles: true, escapes: true }))) return BLOCK.env;
  if (!a.length) return null;
  // degit/tiged copy another repository's tree here, as a clone would.
  if (prog === "degit" || prog === "tiged") return BLOCK.foreignCode;
  // patch applies a diff, wherever it was saved (`gh pr diff 8 > f` then `patch < f`): like git apply,
  // only its dry run is a read.
  if ((prog === "patch" || ((prog === "busybox" || prog === "toybox") && bare(a[1] ?? "") === "patch")) && !a.some((v) => /^(--dry-run|--check|-C)$/.test(v))) return BLOCK.prCode;

  // Writes: redirections of any command, and the write commands. Git's own files are nobody's;
  // <MAIN> outside its worktrees is off limits, except the STATE_DIRS for non-worker subagents.
  const scan = [...t.slice(0, at), ...argv.filter((_, i) => !skip.has(i))];
  // zsh writes a redirection to every word its braces make (MULTIOS); bash refuses it: judge them all.
  const redirects = redirectTargets(scan).flatMap((r) => braceWords(r.tok).map((tok) => ({ ...r, tok })));
  for (const { tok, follow, tree } of [...redirects, ...writeTargets(prog, argv)]) {
    const w = writeTarget(tok, follow, here, state.prev);
    if (!w) continue;
    const own = protectedTarget(w, follow, tree);
    if (own) return own;
    // The target's own repo decides; the main checkouts already in scope stay closed whatever it resolves to.
    const ts = (state.resolve && state.resolve(w.real)) || scope;
    if (ts.error) return BLOCK.brokenContract(ts.main, ts.error);
    const into = mainWrittenOf(w.real, [ts.main, main, state.main], rules.worker !== false);
    if (into) return BLOCK.mainWrite(into);
  }
  if (prog === "bun" && a[1] === "exec") return checkText(a.slice(2).join(" "), here, state, depth + 1);

  const repoRule = denied(a, prog, rules.deny, here);
  if (repoRule) return repoRule;

  if (SHELLS.has(prog)) {
    const c = a.findIndex((v, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(v));
    if (c > 0 && a[c + 1] !== undefined) return checkText(a[c + 1], here, state, depth + 1);
    const script = a.findIndex((v, i) => i > 0 && !v.startsWith("-") && !/^[-+]o$/.test(a[i - 1]));
    return script > 0 ? checkCommand(argv.slice(script), { ...state, dir: here }, depth + 1) : null;
  }
  if (prog === "eval") return checkText(a.slice(1).join(" "), here, state, depth + 1);
  if (prog === "find") {
    for (let i = 1; i < argv.length; i++) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(a[i])) continue;
      let j = i + 1;
      while (j < argv.length && a[j] !== ";" && a[j] !== "+") j++;
      const r = checkCommand(argv.slice(i + 1, j), { ...state, dir: here }, depth + 1);
      if (r) return r;
      i = j;
    }
    return null;
  }
  if (prog === "cd" || prog === "pushd") {
    let k = 1;
    while (k < argv.length && /^-[LPe@]+$/.test(argv[k].v)) k++;
    if (argv[k]?.v === "--") k++;
    const target = argv[k];
    const from = state.dir;
    // `cd -` returns to the previous directory (the command's cwd before the first cd); an absolute or `~`
    // target is known from anywhere, a relative one only from a known cwd.
    const e = target && target.v !== "-" ? expandHome(target, from, state.prev) : null;
    if (!target) state.dir = process.env.HOME || from;
    else if (target.v === "-") state.dir = state.prev ?? UNKNOWN;
    else if (e === null || /^[+-]\d+$/.test(target.v) || (from === UNKNOWN && !path.isAbsolute(e))) state.dir = UNKNOWN;
    else state.dir = path.resolve(from === UNKNOWN ? "/" : from, e);
    state.prev = from;
    return null;
  }
  if (prog === "pkill" || prog === "killall") return BLOCK.kill;
  // The claude CLI's plugin changes rewrite the plugin store; its reads (list, validate) are fine.
  if (prog === "claude") {
    const w = a.slice(1).filter((v) => !v.startsWith("-"));
    if (/^plugins?$/.test(w[0] ?? "") && !/^(list|validate|help)$/.test(w[1] ?? "list") && !(w[1] === "marketplace" && /^(list|help)$/.test(w[2] ?? "list"))) return BLOCK.pluginFiles;
  }
  if (prog === "sapu-merge.sh") return a.includes("--dry-run") ? null : BLOCK.orchestrator;

  if (prog === "git") {
    let i = 1;
    let dir = here;
    // A path that names the repository to act on: -C, --git-dir, --work-tree, GIT_DIR, GIT_WORK_TREE.
    // --git-dir=<X>/.git points at checkout <X> (its HEAD and index), whatever the cwd.
    const target = (p, gitDir) => {
      if (!p || p.dyn || dir === UNKNOWN) return UNKNOWN;
      const abs = path.resolve(dir, p.v);
      return gitDir && path.basename(abs) === ".git" ? path.dirname(abs) : abs;
    };
    for (const e of t.slice(0, at)) {
      if (GIT_HOME_ENV.test(e.v)) return BLOCK.gitHome;
      if (gitEnvRuns(e)) return BLOCK.gitProgram;
      const m = /^GIT_(DIR|WORK_TREE)=(.*)$/.exec(e.v);
      if (m) dir = target({ v: m[2], dyn: e.dyn }, m[1] === "DIR");
    }
    // `-c key=value` (a key alone is a boolean); `--config-env` reads the value from a variable: unknown.
    const configRisk = (kv, known) => {
      if (GIT_CONFIG_DANGER.test(kv)) return BLOCK.noVerify;
      if (GIT_REMOTE_CONFIG.test(kv)) return BLOCK.remote;
      const eq = kv.indexOf("=");
      return gitConfigRuns(eq < 0 ? kv : kv.slice(0, eq), !known ? undefined : eq < 0 ? "" : kv.slice(eq + 1)) ? BLOCK.gitProgram : null;
    };
    while (i < argv.length && argv[i].v.startsWith("-")) {
      const v = argv[i].v;
      const long = /^--(git-dir|work-tree)(=(.*))?$/.exec(v);
      if (v === "-C") {
        dir = target(argv[i + 1], false);
        i += 2;
      } else if (long) {
        dir = target(long[2] ? { v: long[3], dyn: argv[i].dyn } : argv[i + 1], long[1] === "git-dir");
        i += long[2] ? 1 : 2;
      } else if (v === "-c" || v === "--config-env") {
        const risk = configRisk(argv[i + 1]?.v ?? "", v === "-c" && argv[i + 1] && !argv[i + 1].dyn);
        if (risk) return risk;
        i += 2;
      } else if (v.startsWith("--config-env=")) {
        const risk = configRisk(v.slice("--config-env=".length), false);
        if (risk) return risk;
        i++;
      } else i++;
    }
    const sub = a[i];
    const rest = a.slice(i + 1);
    // The repository git acts on (-C, --git-dir, …) is the touched repo: its base branch and main checkout.
    const gs = (dir !== here && state.resolve && state.resolve(dir)) || scope;
    if (gs.error) return BLOCK.brokenContract(gs.main, gs.error);
    if (sub === "config") {
      if (rest.some((v) => /^core\.hookspath$/i.test(v))) return BLOCK.noVerify;
      // A read: an explicit read option or subcommand, or a lone key (`git config user.name`).
      const fileOpt = rest.findIndex((v) => v === "-f" || v === "--file");
      const positional = rest.filter((v, k) => !v.startsWith("-") && !(fileOpt >= 0 && k === fileOpt + 1));
      const writeFlag = rest.some((v) => /^(--add|--unset(-all)?|--replace-all|--rename-section|--remove-section|-e|--edit)$/.test(v));
      const reads =
        rest[0] === "get" ||
        rest[0] === "list" ||
        rest.some((v) => /^(--get(-all|-regexp|-urlmatch)?|-l|--list)$/.test(v)) ||
        (!writeFlag && positional.length === 1 && !["set", "unset", "edit", "rename-section", "remove-section"].includes(positional[0]));
      if (!reads && rest.some((v) => /^--(global|system)$/.test(v))) return BLOCK.gitFiles;
      const cfgFile = fileOpt >= 0 ? rest[fileOpt + 1] : rest.find((v) => v.startsWith("--file="))?.slice("--file=".length);
      if (!reads && cfgFile) {
        const w = writeTarget({ v: cfgFile, dyn: false }, true, dir);
        if (!w) return BLOCK.gitFiles;
        const own = protectedTarget(w, true);
        if (own) return own;
      }
      if (!reads && rest.some((v) => /^(alias\..|include\.path$|includeif\.|filter\..|core\.(attributesfile|fsmonitor|sshcommand)$|diff\.external$)/i.test(v))) return BLOCK.noVerify;
      if (!reads && rest.some((v) => /^(remote\..+\..|url\..+\..|push\..)/i.test(v))) return BLOCK.remote;
      // A config file keeps the program for every later git command, of every worktree: no value passes.
      if (!reads && rest.some((v) => gitConfigRuns(v, undefined))) return BLOCK.gitProgram;
    }
    for (const c of gitOptionCommands(sub, argv.slice(i + 1))) {
      const r = c.argv ? checkCommand(c.argv, { ...state, dir: here }, depth + 1) : checkText(c.text, here, state, depth + 1);
      if (r) return r;
    }
    if (sub === "remote" && ["add", "set-url", "set-branches", "set-head", "rename", "remove", "rm", "prune", "update"].includes(rest[0])) return BLOCK.remote;
    const flags = rest.filter((v, k) => v.startsWith("-") && !skip.has(i + 1 + k)).map(longName);
    if (flags.includes("--ignore-other-worktrees")) return BLOCK.worktrees;
    if (sub === "worktree" && rest[0] === "add" && flags.some((f) => f === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f))) return BLOCK.worktrees;
    if (sub === "fetch" && flags.some((f) => f === "--update-head-ok" || /^-[a-zA-Z]*u[a-zA-Z]*$/.test(f))) return BLOCK.refs;
    // A PR's code: its refs (`pull/<n>/head`, `refs/pull/*`, with or without `+`), or a patch applied here.
    if ((sub === "fetch" || sub === "pull") && rest.some((v) => !v.startsWith("-") && /(^|[+:])(refs\/)?pull\//.test(v))) return BLOCK.prCode;
    if (sub === "am") return BLOCK.prCode;
    // Only origin's branches and tags come in: not another remote or a URL, not a raw SHA (a PR's
    // head is reachable by it), not a ref glob outside refs/heads and refs/tags, never a clone.
    if (sub === "clone") return BLOCK.foreignCode;
    if (sub === "fetch" || sub === "pull") {
      const pos = [];
      for (let k = 0; k < rest.length; k++) {
        if (FETCH_VALUE_OPTS.has(rest[k])) k++;
        else if (!rest[k].startsWith("-")) pos.push(rest[k]);
      }
      if (pos.length && pos[0] !== "origin") return BLOCK.foreignCode;
      for (const spec of pos.slice(1)) {
        const src = spec.replace(/^\+/, "").split(":")[0];
        if (/^[0-9a-f]{7,40}$/i.test(src) || (src.includes("*") && !/^refs\/(heads|tags)\//.test(src))) return BLOCK.foreignCode;
      }
    }
    if (sub === "apply" && !(rest.some((v) => /^--(check|stat|numstat|summary)$/.test(v)) && !rest.some((v) => /^--(apply|index|cached|3way)$|^-3$/.test(v)))) return BLOCK.prCode;
    if (["replace", "update-index", "checkout-index", "read-tree"].includes(sub)) return BLOCK.index;
    if (sub === "stash") {
      const op = rest[0] === undefined || rest[0].startsWith("-") ? "push" : rest[0];
      if (rest[0] === undefined || op === "pop" || op === "clear") return BLOCK.stash;
      if (op === "drop" && rest.length < 2) return BLOCK.stash;
      if (op === "push" && !rest.includes("-m") && !rest.includes("--message")) return BLOCK.stash;
    }
    if ((sub === "commit" || sub === "push") && flags.some((f) => f === "--no-verify" || (sub === "commit" && /^-[a-zA-Z]*n[a-zA-Z]*$/.test(f)))) return BLOCK.noVerify;
    if (sub === "push") {
      if (flags.some((f) => f === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(f)) || rest.some((v) => v.startsWith("+"))) return BLOCK.force;
      if (flags.some((f) => f === "--delete" || f === "-d") || rest.some((v) => v.startsWith(":"))) return BLOCK.refs;
      if (flags.some((f) => f === "--all" || f === "--mirror" || f === "--branches")) return BLOCK.pushBase(gs.rules.base);
      // Destination of each refspec: after the last `:`, else the refspec itself; the first word is the remote.
      const pos = [];
      for (let k = 0; k < rest.length; k++) {
        if (/^(-o|--push-option|--receive-pack|--exec|--repo)$/.test(rest[k])) k++;
        else if (!rest[k].startsWith("-")) pos.push(rest[k]);
      }
      const bases = new Set(["main", "master", gs.rules.base].filter(Boolean));
      // as git resolves a destination: `main`, `heads/main`, `refs/heads/main`
      const dest = (spec) => spec.slice(spec.lastIndexOf(":") + 1).replace(/^refs\/heads\//, "").replace(/^heads\//, "");
      if (pos.slice(1).some((spec) => bases.has(dest(spec)))) return BLOCK.pushBase(gs.rules.base);
    }
    if (sub === "worktree" && ["remove", "prune", "move"].includes(rest[0])) return BLOCK.refs;
    if (sub === "branch" && flags.some((f) => ["-D", "-d", "-f", "-M", "--delete", "--force"].includes(f))) return BLOCK.refs;
    if (sub === "update-ref" || sub === "symbolic-ref") return BLOCK.refs;
    if ((gs.main || state.main) && MUTATING_GIT.has(sub)) {
      if (dir === UNKNOWN) return `\`git ${sub}\` in a directory that cannot be told (a path held in a shell variable, or after a cd inside a pipeline): write the literal path of your own worktree, with git -C or a plain cd.`;
      const m = [gs.main, main, state.main].find((x) => x && realpathOrSelf(dir) === realpathOrSelf(x));
      if (m) return `\`git ${sub}\` in the main checkout (${m}). Other sessions share it: work only in your own worktree.`;
    }
    return null;
  }

  if (prog === "gh") {
    const { w, i1, i2, ix } = ghWords(a);
    let [g1, g2] = [i1 < 0 ? undefined : w[i1], i2 < 0 ? undefined : w[i2]];
    if (g1 === "co") [g1, g2] = ["pr", "checkout"];
    if (g1 !== undefined && !g1.startsWith("-") && !GH_COMMANDS.has(g1)) return BLOCK.ghUnknown;
    if (g1 === "pr" && g2 === "merge") return BLOCK.merge;
    if (g1 === "issue" && g2 === "create" && rules.worker !== false) return BLOCK.issue;
    if (g1 === "alias" && (g2 === "set" || g2 === "import")) return BLOCK.ghAlias;
    if (g1 === "pr" && g2 === "checkout") return BLOCK.prCode;
    if ((g1 === "repo" && g2 === "clone") || (g1 === "extension" && (g2 === "install" || g2 === "upgrade")) || (g1 === "release" && g2 === "download")) return BLOCK.foreignCode;
    // The owner labels (acceptance, needs-owner), in every spelling gh offers.
    const L = rules.ownerLabels;
    const tail = i2 < 0 ? [] : w.slice(i2 + 1);
    const tailT = i2 < 0 ? [] : ix.slice(i2 + 1).map((k) => argv[k]);
    // A label or reason the shell builds cannot be read: refused like the owner's own.
    if ((g1 === "issue" || g1 === "pr") && g2 === "edit") {
      for (let j = 0; j < tailT.length; j++) {
        const m = /^--(add|remove)-label(?:=([\s\S]*))?$/.exec(tailT[j].v);
        const val = m && optionValue(tailT, j, m[2] === undefined ? null : `=${m[2]}`);
        if (val && (val.dyn || namesLabel(val.v, L))) return BLOCK.acceptLabel;
      }
    }
    // Closing as not planned is the owner's ruling (argus records it as intended).
    if (g1 === "issue" && g2 === "close") {
      for (let j = 0; j < tailT.length; j++) {
        const m = /^(?:--reason(?:=([\s\S]*))?|-r([\s\S]*))$/.exec(tailT[j].v);
        const val = m && optionValue(tailT, j, m[1] !== undefined ? `=${m[1]}` : m[2] || null);
        if (val && (val.dyn || notPlanned(val.v))) return BLOCK.ownerRuling;
      }
    }
    if (g1 === "label" && (g2 === "clone" || (["create", "edit", "delete"].includes(g2) && tail.some((v) => namesLabel(v, L))))) return BLOCK.acceptLabel;
    if (g1 === "api") {
      if (a.some((v) => /\b(addLabelsToLabelable|removeLabelsFromLabelable|clearLabelsFromLabelable|createLabel|updateLabel|deleteLabel)\b/.test(v))) return BLOCK.acceptLabel;
      // closeIssue: NOT_PLANNED inline, a variable exactly NOT_PLANNED, or any field the guard cannot read
      if (a.some((v) => /\bcloseIssue\b/.test(v)) && (a.some((v) => GQL_NOT_PLANNED.test(v)) || ghFields(argv).some((f) => f.dyn || f.file || f.v.slice(f.v.indexOf("=") + 1) === "NOT_PLANNED"))) return BLOCK.ownerRuling;
      if (a.some((v) => { let s = v; try { s = decodeURIComponent(v); } catch { /* raw */ } return /(?:[?&]ref=|\/(?:tarball|zipball)\/)(?:refs\/)?pull\//.test(s); })) return BLOCK.prCode;
      if (a.some((v) => /mergePullRequest|enablePullRequestAutoMerge/.test(v))) return BLOCK.merge;
      if (a.includes("graphql")) {
        // The query must be a literal the guard can read: not --input, not -F query=@file, not built by the shell.
        for (let k = 1; k < argv.length; k++) {
          if (/^--input(=|$)/.test(a[k])) return BLOCK.graphqlFile;
          let val = null;
          let fromFile = false;
          if (/^(-f|-F|--field|--raw-field)$/.test(a[k])) {
            val = argv[k + 1];
            fromFile = /^(-F|--field)$/.test(a[k]);
          } else {
            const m = /^(-f|-F|--field=|--raw-field=)(query=[\s\S]*)$/.exec(a[k]);
            if (m) {
              val = { v: m[2], dyn: argv[k].dyn };
              fromFile = /^(-F|--field=)$/.test(m[1]);
            }
          }
          // an empty `query=` was cut by an unquoted $( ) or backtick
          if (val && /^query=/.test(val.v) && (val.dyn || val.v === "query=" || (fromFile && /^query=@/.test(val.v)))) return BLOCK.graphqlFile;
        }
      }
      if (a.some((v) => /\b(createCommitOnBranch|createRef|updateRefs?|deleteRef|mergeBranch)\b/.test(v))) return BLOCK.apiWrite;
      const m = a.findIndex((v) => v === "-X" || v === "--method");
      const inline = a.map((v) => /^(?:-X|--method=)(.+)$/.exec(v)?.[1]).find(Boolean);
      const method = (m > 0 ? a[m + 1] : inline) || (a.some((v) => /^(-f|-F|--field|--raw-field|--input)$/.test(v)) ? "POST" : "GET");
      if (method.toUpperCase() !== "GET") {
        if (a.some((v) => /\/pulls\/\d+\/merge\b|\/merges\b/.test(v))) return BLOCK.merge;
        if (a.some((v) => /\/(contents|git|branches)\//.test(v))) return BLOCK.apiWrite;
        // REST state_reason not_planned, built by the shell, or read from a file.
        if (argv.some((t) => { const r = /state_reason=([\s\S]*)$/i.exec(t.v); return r && (t.dyn || notPlanned(r[1]) || r[1].startsWith("@")); })) return BLOCK.ownerRuling;
        // A write naming the label, or a label/issue write whose body the guard cannot read.
        if (a.some((v) => namesLabel(v, L))) return BLOCK.acceptLabel;
        const unread = a.some((v) => /^--input(=|$)/.test(v)) || ghFields(argv).some((f) => f.file);
        const route = (v) => v.replace(/[?#][\s\S]*$/, "");
        if (unread && a.some((v) => /\/labels\b/.test(route(v)))) return BLOCK.acceptLabel;
        if (unread && a.some((v) => /\/issues\/\d+\/?$/.test(route(v)))) return BLOCK.ownerRuling;
      }
    }
    return null;
  }

  if (PKG_MANAGERS.has(prog)) {
    // Options can carry values (`-w web`, `--prefix x`), so the verb is found among the
    // words, not assumed to be the first one.
    const w = a.slice(1).filter((v) => !v.startsWith("-"));
    const run = w.findIndex((x) => (RUN_ALIASES[x] ?? x) === "run");
    const head = run < 0 ? w : w.slice(0, run);
    const installs = prog === "yarn" && w.length === 0 ? true : head.some((x) => INSTALL_VERBS.has(x));
    if (installs) {
      if (here === UNKNOWN) return "package install from a directory held in a shell variable: cd to the literal worktree path first.";
      const links = symlinkedNodeModules(gitRoot(here) ?? here);
      if (links.length) {
        return `${prog} install through symlinked node_modules (${links.join(", ")}) empties the TARGET, i.e. <MAIN>'s node_modules. Use the repo's clean-install setup (.claude/sapu/worker.md), which deletes the links first.`;
      }
    }
  }

  const pi = a.findIndex((v) => bare(v) === "prisma");
  if (pi >= 0) {
    const [p1, p2] = [a[pi + 1], a[pi + 2]];
    if ((p1 === "migrate" && p2 === "reset") || (p1 === "db" && p2 === "push") || (p1 === "migrate" && p2 === "dev" && !a.includes("--create-only"))) return BLOCK.prisma;
  }
  if (prog === "ln" && a.some((v, i) => i > 0 && /^-[a-zA-Z]*s/.test(v))) {
    const last = a[a.length - 1];
    if (/^(\.\/)?node_modules\/?$/.test(last)) return BLOCK.nodeModules;
  }
  return null;
}

/** Does this command print a PR's diff or patch (`gh pr diff`, `gh api …/pulls/…`, curl/wget of a PR URL)? */
/**
 * gh's argument words with its repo/host flags removed. gh accepts -R/--repo/--hostname anywhere
 * before the subcommand (`gh pr -R o/r view 1`), so they are dropped wherever they stand, value
 * included, and the first two words that are not flags are the command: no flag may shift a
 * command out of the rules' sight. `a` is the argv with `gh` at index 0.
 */
function ghWords(a) {
  const w = [];
  const ix = []; // each word's index in `a`
  for (let j = 1; j < a.length; j++) {
    if (a[j] === "-R" || a[j] === "--repo" || a[j] === "--hostname") j++;
    else if (!/^(?:--repo|--hostname)=|^-R./.test(a[j])) {
      w.push(a[j]);
      ix.push(j);
    }
  }
  const i1 = w.findIndex((v) => !v.startsWith("-"));
  const i2 = i1 < 0 ? -1 : w.findIndex((v, j) => j > i1 && !v.startsWith("-"));
  return { w, i1, i2, ix };
}

/**
 * The value of an option at `tail[j]` ({v, dyn}): glued (`--x=v`, `-xv`) or the next word. A value
 * the shell builds is dyn; one an unquoted $( ) or backtick cut off is missing, read as dyn too.
 */
function optionValue(tail, j, glued) {
  if (glued) return { v: glued.replace(/^=/, ""), dyn: tail[j].dyn };
  return tail[j + 1] ?? { v: "", dyn: true };
}

/** gh api's field values ({v: "key=value", dyn, file}), separate or glued; `file`: -F/--field reading `@path`. */
function ghFields(argv) {
  const out = [];
  for (let k = 1; k < argv.length; k++) {
    const x = argv[k].v;
    let f = null;
    let typed = false;
    if (/^(-f|-F|--field|--raw-field)$/.test(x)) {
      f = argv[k + 1] ?? { v: "", dyn: true };
      typed = /^(-F|--field)$/.test(x);
      k++;
    } else {
      const m = /^(-f|-F|--field=|--raw-field=)([\s\S]+)$/.exec(x);
      if (m) {
        f = { v: m[2], dyn: argv[k].dyn };
        typed = /^(-F|--field=)$/.test(m[1]);
      }
    }
    if (f) out.push({ v: f.v, dyn: f.dyn, file: typed && /^[^=]*=@/.test(f.v) });
  }
  return out;
}

const NET_FETCHERS = new Set(["curl", "wget"]);
const UNPACKERS = new Set(["tar", "gtar", "bsdtar", "unzip", "funzip", "cpio", "7z", "7za", "7zz"]);

function prSource(toks) {
  const a = toks.slice(programIndex(toks)).map((x) => x.v);
  const prog = a.length ? bare(a[0]) : "";
  if (prog === "gh") {
    const { w, i1, i2 } = ghWords(a);
    const [g1, g2] = [w[i1], w[i2]];
    return (g1 === "pr" && g2 === "diff") || (g1 === "api" && a.some((v) => /\/pulls\/\d+/.test(v)));
  }
  return (prog === "curl" || prog === "wget") && a.some((v) => /\/pull\/\d+|\/pulls\/\d+|\.(diff|patch)(\?|$)/.test(v));
}

/** `base` = the caller's scope: {main, rules, resolve}; each command of `text` re-resolves its own place. */
function checkText(text, dir, base, depth) {
  if (depth > MAX_DEPTH) return BLOCK.deep;
  // A command text starts with OLDPWD = its cwd: Claude Code's Bash sets it so (measured), and a
  // fresh shell's `cd -` stays where it is (bash ignores an inherited OLDPWD, zsh starts it at $PWD).
  const state = { dir, prev: dir, main: base.main, rules: base.rules, resolve: base.resolve };
  const saved = [];
  const { cmds, nested } = tokenize(stripHeredocs(text));
  let fromPr = false; // the previous command pipes a PR's diff into this one
  let fromNet = false; // the previous command pipes a download into this one
  for (const c of cmds) {
    if (c.pre === "(") saved.push(state.dir);
    const before = state.dir;
    if (fromPr && c.pre === "|") {
      // patch itself, through busybox/toybox, or inside a shell's -c text
      const a = c.toks.slice(programIndex(c.toks)).map((x) => x.v);
      const p = a.length ? bare(a[0]) : "";
      if (p === "patch" || ((p === "busybox" || p === "toybox") && bare(a[1] ?? "") === "patch")) return BLOCK.prCode;
      const ci = SHELLS.has(p) ? a.findIndex((v, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(v)) : -1;
      if (ci > 0 && /(^|[\s;&|(])(\S*\/)?(patch|busybox\s+patch|git\s+(apply|am))\b/.test(a[ci + 1] ?? "")) return BLOCK.prCode;
    }
    fromPr = c.post === "|" && (prSource(c.toks) || (fromPr && c.pre === "|"));
    if (fromNet && c.pre === "|") {
      // a download unpacked straight into the worktree (`curl … | tar x`), also through a decompressor
      const a = c.toks.slice(programIndex(c.toks)).map((x) => x.v);
      const p = a.length ? bare(a[0]) : "";
      if (UNPACKERS.has(p) || ((p === "busybox" || p === "toybox") && UNPACKERS.has(bare(a[1] ?? "")))) return BLOCK.foreignCode;
    }
    fromNet = c.post === "|" && (NET_FETCHERS.has(bare(c.toks.slice(programIndex(c.toks))[0]?.v ?? "")) || (fromNet && c.pre === "|"));
    const reason = checkCommand(c.toks, state, depth);
    if (reason) return reason;
    // A cd in a background job runs in a subshell: the parent does not move. In a pipeline it
    // depends on the shell (bash: every element is a subshell; zsh: the last runs in this shell),
    // so a cd there leaves the directory unknowable: what follows is judged fail-closed.
    if (c.pre === "|" || c.post === "|") state.dir = state.dir === before ? before : UNKNOWN;
    else if (c.post === "&") state.dir = before;
    if (c.post === ")" && saved.length) state.dir = saved.pop();
  }
  for (const n of nested) {
    const reason = checkText(n, dir, base, depth + 1);
    if (reason) return reason;
  }
  return null;
}

/**
 * @param {{command: string, cwd: string, main?: string|null, rules?: ReturnType<typeof compileRules>, worker?: boolean, resolve?: Function}} input
 * `resolve` (scopeResolver) makes each command judged by the repo it touches; without it, `main`/`rules` judge all.
 * @returns {string|null} the reason to block, or null to allow
 */
export function check({ command, cwd, main = null, rules = ENGINE_ONLY, worker = true, resolve = null }) {
  if (typeof command !== "string" || !command.trim()) return null;
  return checkText(command, cwd, { main, rules: worker ? rules : { ...rules, worker: false }, resolve }, 0);
}

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * A file-tool call: no env file is read or written (by name, and by the real name behind a
 * symlink), and nothing is written into <MAIN> outside `<MAIN>/.claude/worktrees/` — judged on
 * the real path, so a worktree's symlink into <MAIN> (a linked node_modules) is <MAIN>.
 * @returns {string|null} the reason to block, or null to allow
 */
export function checkFile({ tool, filePath, cwd, main = null, rules = ENGINE_ONLY, worker = true, resolve = null }) {
  if (!FILE_TOOLS.has(tool) || typeof filePath !== "string" || !filePath) return null;
  const abs = path.resolve(cwd || process.cwd(), filePath.replace(/^~(?=\/|$)/, process.env.HOME || "~"));
  const real = realPathOf(abs);
  // The file's own repo and contract decide (TOUCHED REPO in decide()); `main` stays closed whatever it resolves to.
  const s = (resolve && resolve(real)) || { main, rules };
  if (s.error) return BLOCK.brokenContract(s.main, s.error);
  if ([abs, real].some((p) => s.rules.envFiles.has(path.basename(p).toLowerCase()))) return BLOCK.env;
  if (WRITE_TOOLS.has(tool) && (isGitFile(abs) || isGitFile(real))) return BLOCK.gitFiles;
  if (WRITE_TOOLS.has(tool) && (isMachineConfigFile(abs) || isMachineConfigFile(real))) return BLOCK.machineConfig;
  if (WRITE_TOOLS.has(tool) && (isPluginFile(abs) || isPluginFile(real))) return BLOCK.pluginFiles;
  const into = WRITE_TOOLS.has(tool) && mainWrittenOf(real, [s.main, main], worker);
  return into ? BLOCK.mainWrite(into) : null;
}

const SEARCH_TOOLS = new Set(["Grep", "Glob"]);

/**
 * A Grep/Glob call: its `path` may not name an env file, and its path glob (Grep `glob`, Glob
 * `pattern`) may not be able to match one. Grep's glob is ripgrep's `-g`, which has no dotfile
 * rule and overrides ignore files, so a leading `*` counts as matching `.env`; Glob only lists
 * names and keeps the shell's rule. Grep's `pattern` is a content regex, not a path.
 * @returns {string|null} the reason to block, or null to allow
 */
export function checkSearch({ tool, input = {}, cwd, rules: given = ENGINE_ONLY, resolve = null }) {
  if (!SEARCH_TOOLS.has(tool)) return null;
  const p = input.path;
  const abs = typeof p === "string" && p ? path.resolve(cwd || process.cwd(), p.replace(/^~(?=\/|$)/, process.env.HOME || "~")) : null;
  // The searched place's repo decides: the path's, else the cwd's.
  const s = (resolve && resolve(abs ? realPathOf(abs) : cwd || process.cwd())) || { rules: given };
  if (s.error) return BLOCK.brokenContract(s.main, s.error);
  const rules = s.rules;
  if (abs && [abs, realPathOf(abs)].some((x) => isEnvFile(x, rules))) return BLOCK.env;
  const g = tool === "Grep" ? input.glob : input.pattern;
  if (typeof g === "string" && g && isEnvFile(g, rules, { dotfiles: tool === "Grep", escapes: true })) return BLOCK.env;
  return null;
}

// The step budget of subagent-brief.md point 11, enforced here because prose was not obeyed: every
// step re-sends a worker's whole, growing context, so one 225-step agent costs far more than two
// fresh ones. At STEP_SOFT tool calls ONE call is refused as a reminder to hand off, again every
// STEP_EVERY calls, and every STEP_EVERY_LATE past STEP_HARD. Re-issuing the refused call passes, and
// no call is ever refused for good: a worker a few steps from done finishes, and its teardown, WIP
// commit and PR steps always run (a hard stop would leak test resources or lose unpushed work).
// A handoff command is never the call a reminder refuses. Counted per agent id in
// <MAIN>/.git/sapu-steps/ (one byte appended per call, so the file size is the count; parallel calls
// may shift a reminder by one, which is harmless); ladder workers only, and only calls the guard's
// own rules let through. ponytail: hooked tools only (Bash, Monitor, PowerShell, file, search and MCP tools), not WebFetch or
// Agent calls; an unwritable counter switches the budget off rather than block work.
// The defaults; a contract's `tuning.stepBudget` overrides each (resolveTuning, through compileRules).
export const STEP_SOFT = DEFAULT_TUNING.stepBudget.soft;
export const STEP_EVERY = DEFAULT_TUNING.stepBudget.every;
export const STEP_HARD = DEFAULT_TUNING.stepBudget.hard;
export const STEP_EVERY_LATE = DEFAULT_TUNING.stepBudget.everyLate;
const STEP_PRUNE_MS = 3 * 24 * 3600 * 1000;
// A handoff command (isHandoffCommand, in sapu-contract.mjs so /sapu:init's profile check reads the same test).
const isHandoff = isHandoffCommand;

/**
 * The step budget's verdict for one call of a ladder worker: the reminder to block it with, or null.
 * @param {{ main: string|null, agentId?: string, tool: string, command?: string }} i
 */
/** The counters' directory: sapu-steps/ in the repository's git directory (gitCommonDir), or null when there is none. */
const stepsDir = (main) => {
  const gd = gitCommonDir(main);
  return gd ? path.join(gd, "sapu-steps") : null;
};

/** Count one call of `agentId` in <MAIN>/.git/sapu-steps/ and return the count so far; throws when the counter cannot be written. */
function countStep(main, agentId) {
  const dir = stepsDir(main);
  if (!dir) throw Object.assign(new Error("no git directory"), { code: "ENOGITDIR" });
  const file = path.join(dir, agentId.replace(/[^\w.-]/g, "_"));
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, ".");
  const n = fs.statSync(file).size;
  if (n === 1) for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (Date.now() - fs.statSync(p).mtimeMs > STEP_PRUNE_MS) fs.rmSync(p, { force: true });
  }
  return n;
}

/**
 * Whether the step budget counts this worker, as the worker canary reports it: "counting" (the canary
 * call is counted), or "off: <why>". The budget switches itself off silently (no agent_id in the hook
 * input, an unwritable counter), so the canary is what proves it on first use in a host.
 * @param {{ main: string|null, agentId?: string }} i
 */
export function stepProbe({ main, agentId }) {
  if (!main) return "off: no main checkout (this call is outside a repo), so there is nowhere to count";
  if (typeof agentId !== "string" || !agentId) return "off: this hook input carries no agent_id, so no call of this worker is counted";
  try {
    countStep(main, agentId);
    return "counting";
  } catch (e) {
    return `off: ${stepsDir(main) ?? `the git directory of ${main} (none found)`} cannot be written (${e && e.code ? e.code : "error"})`;
  }
}

export function stepBudget({ main, agentId, tool, command, steps = DEFAULT_TUNING.stepBudget }) {
  if (!main || typeof agentId !== "string" || !agentId) return null;
  let n;
  try {
    n = countStep(main, agentId);
  } catch {
    return null;
  }
  const file = path.join(stepsDir(main), agentId.replace(/[^\w.-]/g, "_"));
  // Reminders due so far; one that fell on a handoff command is postponed to the next other call,
  // never skipped. The last one given is kept in `<id>.r`.
  const { soft: SOFT, every: EVERY, hard: HARD, everyLate: LATE } = steps;
  const soft = Math.floor((Math.min(n, HARD) - SOFT) / EVERY) + 1;
  const dueSlots = n < SOFT ? 0 : soft + (n > HARD ? Math.floor((n - HARD) / LATE) : 0);
  let given = 0;
  try {
    given = Number(fs.readFileSync(`${file}.r`, "utf8")) || 0;
  } catch {}
  if (dueSlots <= given || ((tool === "Bash" || tool === "Monitor" || tool === "PowerShell") && isHandoff(command))) return null;
  try {
    fs.writeFileSync(`${file}.r`, String(dueSlots));
  } catch {
    return null; // a reminder that cannot be recorded would repeat on every call: let it through
  }
  return `STEP BUDGET: ${n} tool calls. Unless your PR is a few steps from opened (fixer: pushed), hand off now (brief point 11): WIP commit from your worktree (git add -A && git commit -m 'wip: handoff', unpushed), teardown, return status "handoff" with branch, head_sha and a handoff_note. A fresh worker of your tier continues on a clean context. A few steps from done? Re-issue this call; it passes. Reminders come every ${EVERY} calls, every ${LATE} past ${HARD}.`;
}

// context-mode's MCP tools run shell commands and read files like Bash and Read do, and its own hook
// tells subagents to prefer them, so an honest worker would bypass every rule above. Each call is
// checked as the Bash/Read calls it amounts to: batch commands (in every shape context-mode coerces),
// shell code, paths, and in other languages the command a spawn call runs — a string, a list of
// literal strings, or literals joined by `+`. They are judged where they run (see decide()). ponytail: an interpreter's own code beyond that (built strings, ruby backticks,
// other languages' process APIs) is the LIMITS case above, as with `node -e`.
const CTX_TOOL = /__ctx_(execute|execute_file|batch_execute|index)$/;
const LIT = String.raw`[fr]?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\`(?:\\.|[^\`\\])*\`)`;
// Unambiguous process APIs anywhere; generic names (exec, run, call, system, popen) on a process module
// or `require("child_process")`, or bare when the code imports child_process/subprocess/os — so
// `db.exec("… > 2")`, a regex `.exec`, `suite.run(` or python's builtin `exec("…")` are not commands.
const SPAWN_ANY = String.raw`\b(?:execSync|execFileSync|execFile|spawnSync|spawn|check_output|check_call|Popen|shell_exec|passthru|proc_open)`;
const SPAWN_GENERIC = String.raw`(?:exec|run|call|system|popen)`;
const SPAWN_MODULE = String.raw`(?:\b(?:subprocess|os|child_process|childProcess|child_proc|cp|sp)\s*\.\s*|require\(\s*["'\`](?:node:)?child_process["'\`]\s*\)\s*\.\s*)`;
const IMPORTS_PROCESS = /child_process|\bsubprocess\b|\bimport\s+os\b|\bfrom\s+os\s+import\b/;
const spawnCall = (bare) => new RegExp(String.raw`(?:${SPAWN_ANY}|${SPAWN_MODULE}${SPAWN_GENERIC}${bare ? String.raw`|(?<![\w.$])${SPAWN_GENERIC}` : ""})\s*\(\s*(\[[^\]]*\]|${LIT}(?:\s*,\s*\[[^\]]*\])?)`, "g");
const unquote = (l) => l.replace(/^[fr]?(["'`])([\s\S]*)\1$/, "$2");
const literals = (t) => (t.match(new RegExp(LIT, "g")) || []).map(unquote);

/** context-mode's `commands`, as its coerceCommandsArray reads them: a JSON string, a bare string, strings or {command}. */
function ctxCommands(v) {
  if (typeof v === "string") {
    try {
      const j = JSON.parse(v);
      v = Array.isArray(j) ? j : [v];
    } catch {
      v = [v];
    }
  }
  return Array.isArray(v) ? v.map((c) => (typeof c === "string" ? c : c && c.command)) : [];
}

/** The Bash/Read calls a context-mode MCP call amounts to, or null for any other tool. */
export function ctxCalls(tool, ti) {
  const m = CTX_TOOL.exec(tool || "");
  if (!m) return null;
  const out = [];
  if (m[1] === "batch_execute") for (const c of ctxCommands(ti.commands)) out.push({ command: c });
  if (typeof ti.path === "string" && ti.path) out.push({ filePath: ti.path });
  if (typeof ti.code === "string") {
    if (/^(shell|bash|sh|zsh)$/i.test(ti.language || "")) out.push({ command: ti.code });
    else {
      let code = ti.code;
      const concat = new RegExp(String.raw`(${LIT})\s*\+\s*(${LIT})`); // "git push " + 'origin main'
      for (let i = 0; i < 50 && concat.test(code); i++) code = code.replace(concat, (_, a, b) => JSON.stringify(unquote(a) + unquote(b)));
      for (const s of code.matchAll(spawnCall(IMPORTS_PROCESS.test(code)))) out.push({ command: literals(s[1]).join(" ") });
    }
  }
  return out;
}

// Every other MCP server (terminal, filesystem, git, GitHub, …) and the Monitor/PowerShell tools can
// do what Bash and the file tools do, and agents without a `tools:` allowlist (general-purpose, a
// repo's specialists, agents a worker spawns) inherit them all. They are judged generically, by the
// tool's verbs (the words of its name after the server) and its fields: a merge verb, a write naming
// the base branch or the acceptance label, a command field (as Bash, where the server runs it: a
// cwd-like field, else the session's root = the main checkout) and local paths (absolute, or relative
// for a filesystem/shell-like server) as reads or writes. ponytail: field names are heuristics; an
// effect hidden in a server's own config (its DB connection, a browser click) is a LIMIT.
const READ_VERB = /^(get|list|search|read|view|fetch|find|query|describe|show|status|check|checks|diff|log|count|stat|head|info|inspect)$/;
const WRITE_VERB = /^(write|edit|create|update|put|push|commit|move|rename|delete|remove|rm|mkdir|patch|save|copy|append|set|add|apply|replace|upload|insert|close|reopen|label|labels|enable|run|exec|execute|checkout|reset|stash|rebase|send|interact|type)$/;
const CMD_FIELD = /^(command|cmd|script|shell|shell_command|args|argv)$/i;
// typed into a terminal or process (desktop-commander input, tmux keys, iTerm text): only on a shell-like server
const TYPED_FIELD = /^(input|keys|text|chars)$/i;
const CWD_FIELD = /^(cwd|workdir|working_?dir(ectory)?|dir|directory|repo_?path)$/i;
const PATH_FIELD = /^(path|paths|file_?path|filename|file|source|destination|dest|from|to|target|old_?path|new_?path|relative_?path|path_?in_?project)$/i;
const BRANCH_FIELD = /^(branch|base|target_?branch|branch_?name)$/i; // not `ref`/`head`: often the source
const REMOTE_FIELD = /^(owner|repo|repository|url|uri|bucket|page_?id|database_?id|project_?id)$/i;
const LOCAL_SERVER = /filesystem|\bfs\b|shell|terminal|desktop|commander|local|files|tmux|iterm|serena|jetbrains/i;
const GIT_SERVER = /(^|[^a-z])git([^a-z]|$)/i; // a local git server (mcp-server-git), not github/gitlab
const GQL_MERGE = /\b(mergePullRequest|enablePullRequestAutoMerge)\b/;
const GQL_LABEL = /\b(addLabelsToLabelable|removeLabelsFromLabelable|clearLabelsFromLabelable|createLabel|updateLabel|deleteLabel)\b/;

/** The string fields of a tool input, deep: [key, value]; a command field given as a list is one command. */
function fieldsOf(v, key = "", out = []) {
  if (typeof v === "string") out.push([key, v]);
  else if (Array.isArray(v)) {
    if (CMD_FIELD.test(key) && v.every((x) => typeof x === "string")) out.push([key, v.join(" ")]);
    else for (const x of v) fieldsOf(x, key, out);
  } else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) fieldsOf(x, k, out);
  return out;
}

/** The reason to refuse an MCP (non-context-mode), Monitor or PowerShell call, or null. */
export function checkOther({ tool, ti, here, main, rules = ENGINE_ONLY, worker = true, resolve = null }) {
  if (tool === "Monitor" || tool === "PowerShell") return typeof ti.command === "string" && ti.command.trim() ? check({ command: ti.command, cwd: here, main, rules, worker, resolve }) : null;
  const server = tool.slice(5, Math.max(5, tool.lastIndexOf("__")));
  const words = tool.slice(tool.lastIndexOf("__") + 2).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[_\-.]+/).filter(Boolean);
  const writes = words.some((w) => WRITE_VERB.test(w)); // a write verb wins over a read verb (get_or_create, search_and_replace)
  const f = fieldsOf(ti);
  // merges: merge_pull_request, accept_merge_request, set_auto_merge; not update/approve/list_merge_request(s)
  if ((words[0] === "merge" || (words.includes("merge") && words.some((w) => /^(accept|auto)$/.test(w))) || words.includes("automerge")) && !words.some((w) => /^(get|list|status|check)$/.test(w))) return BLOCK.merge;
  // GraphQL mutations only in a graphql tool's query, or in a field holding a mutation document:
  // a search or a file's prose may name them
  const gqlTool = words.some((w) => /^(graphql|gql)$/.test(w));
  const q = f.filter(([k, x]) => (gqlTool && /^(query|mutation|body|document)$/i.test(k)) || /^\s*mutation\b/.test(x)).map(([, x]) => x);
  if (q.some((x) => GQL_MERGE.test(x))) return BLOCK.merge;
  if (q.some((x) => GQL_LABEL.test(x))) return BLOCK.acceptLabel;
  // any field naming closeIssue makes every field GraphQL: NOT_PLANNED inline, or a value exactly NOT_PLANNED
  if (f.some(([, x]) => /\bcloseIssue\b/.test(x)) && f.some(([, x]) => GQL_NOT_PLANNED.test(x) || x.trim() === "NOT_PLANNED")) return BLOCK.ownerRuling;
  // a reason field, at any depth and whatever the verb, unless the tool only reads (a list filter)
  const reads = !writes && (words.some((w) => /^(get|list|search|read|find|fetch|view|show)$/.test(w)) || f.some(([k, x]) => /^method$/i.test(k) && /^get$/i.test(x.trim())));
  if (!reads && f.some(([k, x]) => /reason/i.test(k) && notPlanned(x))) return BLOCK.ownerRuling;
  if (writes) {
    const bases = new Set([rules.base, "main", "master"].filter(Boolean));
    // a pull/merge request names the base it targets without moving it
    const targetsBase = words.some((w) => /^(pull|pr|request)$/.test(w));
    if (!targetsBase && f.some(([k, x]) => BRANCH_FIELD.test(k) && bases.has(x.replace(/^refs\/heads\//, "").trim()))) return BLOCK.pushBase(rules.base);
    // only a label field, or any field of a label tool: a file's content may contain the word
    const labelTool = words.some((w) => /^labels?$/.test(w));
    if (f.some(([k, x]) => (labelTool || /label/i.test(k)) && namesLabel(x, rules.ownerLabels))) return BLOCK.acceptLabel;
  }
  const cwdF = f.find(([k]) => CWD_FIELD.test(k));
  const cwd = cwdF ? path.resolve(here, cwdF[1]) : main || here;
  // a local git server's tool is the git command it names (git_commit {repo_path} = `git commit` there)
  const gitVerb = GIT_SERVER.test(server) && words.find((w) => /^(commit|add|checkout|reset|stash|push|merge|rebase|pull|fetch|clean)$/.test(w));
  if (gitVerb) {
    const branch = f.find(([k]) => /^(branch|branch_?name|target)$/i.test(k));
    const on = (v) => v === true || v === "true";
    const flags = Object.entries(ti).flatMap(([k, v]) => (/^force_?with_?lease$/i.test(k) && on(v) ? ["--force-with-lease"] : /^force$/i.test(k) && on(v) ? ["--force"] : /^(options|flags|extra_?args)$/i.test(k) && Array.isArray(v) ? v.filter((x) => typeof x === "string") : []));
    const force = flags.length ? ` ${flags.join(" ")}` : "";
    const reason = check({ command: `git ${gitVerb}${force}${gitVerb === "push" || gitVerb === "checkout" ? ` ${gitVerb === "push" ? "origin " : ""}${branch ? branch[1] : ""}` : ""}`, cwd, main, rules, worker, resolve });
    if (reason) return reason;
  }
  // typed text is a command only on a shell-like server's terminal/process tool (not a chat message or a browser field)
  const typed = LOCAL_SERVER.test(server) && words.some((w) => /^(terminal|process|keys|interact|send|write|input|run|exec|execute)$/.test(w));
  for (const [k, x] of f) {
    if (!(CMD_FIELD.test(k) || (typed && TYPED_FIELD.test(k))) || !x.trim()) continue;
    const reason = check({ command: x, cwd, main, rules, worker, resolve });
    if (reason) return reason;
  }
  if (f.some(([k]) => REMOTE_FIELD.test(k))) return null; // paths of a remote (a repo, a bucket, a page), not of this disk
  for (const [k, x] of f) {
    if (!PATH_FIELD.test(k) || !x) continue;
    const home = x === "~" || x.startsWith("~/");
    if (!home && !path.isAbsolute(x) && !cwdF && !LOCAL_SERVER.test(server)) continue;
    const filePath = home ? path.join(process.env.HOME || "/", x.slice(1)) : path.resolve(cwd, x);
    const reason = checkFile({ tool: writes ? "Write" : "Read", filePath, cwd, main, rules, worker, resolve });
    if (reason) return reason;
  }
  return null;
}

// TOUCHED REPO. The rules come from the repo a call touches, not from the session's folder: each
// command is judged by the repo of the directory it runs in (after cd, pushd, env -C), a git
// command by the repository it acts on (-C, --git-dir, --work-tree, GIT_DIR), a write by its
// target's repo, a file or search tool by its path's — that repo's main checkout (<MAIN>) and its
// COMMITTED contract. A repo with no contract gets the engine floor; one whose contract is broken
// refuses every call that touches it. The session's own <MAIN> stays closed to writes whatever a
// path resolves to. A place outside every repo, or one that cannot be told (a variable), keeps the
// session's own contract (the floor when the session has none): a protected database or a denied
// gate of the session's repo is not reached by first leaving the repo.
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/**
 * The scope a place belongs to, per TOUCHED REPO: `resolve(p)` → {main, rules, error} for the repo
 * holding `p` (its nearest existing directory), or null for a place that cannot be told (UNKNOWN).
 * `main`/`rules` are the session's own (the repo of `cwd`). Cached per directory and per repo.
 */
export function scopeResolver({ cwd = null, main = null, rules = ENGINE_ONLY, worker = true }) {
  const tier = (r) => (worker ? r : { ...r, worker: false });
  const own = { main, rules: tier(rules), error: null };
  const outsideAny = { main: null, rules: own.rules, error: null };
  const ownKey = main ? realpathOrSelf(main) : null;
  const mains = new Map(cwd ? [[path.resolve(cwd), main]] : []);
  const scopes = new Map();
  return (p) => {
    if (typeof p !== "string" || !p) return null;
    let d = path.resolve(p);
    while (!mains.has(d) && !isDir(d) && path.dirname(d) !== d) d = path.dirname(d);
    if (!mains.has(d)) mains.set(d, findMain(d));
    const m = mains.get(d);
    if (!m) return outsideAny;
    const key = realpathOrSelf(m);
    if (key === ownKey) return own;
    if (!scopes.has(key)) {
      const c = loadContract(m);
      scopes.set(key, { main: m, rules: tier(c.contract ? compileRules(c.contract) : ENGINE_ONLY), error: c.error && !c.missing ? c.error : null });
    }
    return scopes.get(key);
  };
}

/**
 * The hook's decision for one PreToolUse input: the reason to block, or null. The orchestrator
 * (no agent_id) is policed only where it dispatches agents from; every subagent is.
 */
const DISPATCH_TOOLS = new Set(["Agent", "Task", "Workflow"]);

// HOME CHECKOUT. An agent starts in the main session's cwd AT THE MOMENT IT IS SPAWNED (a
// Workflow's agents too, long after the Workflow call), and its project memory
// (.claude/agent-memory) and project settings come from that checkout. A main-session `cd` that
// stays inside the project directory carries over to later commands. Measured in a sweep: after an
// orchestrator Bash call `cd <MAIN>/.claude/worktrees/<x> && …` left the cwd in a PR worktree, the
// reviewers spawned next started with none of the repo's reviewer memory and wrote their notes into
// that worktree, to be lost with it. So, in a repo with a sapu contract and a main session whose
// project directory is <MAIN>: (1) the main session never moves its cwd into a linked worktree
// inside <MAIN> — unless CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR resets it after every command,
// which closes this at the source (/sapu:init writes it into .claude/settings.local.json); (2) it
// never dispatches from one; (3) no subagent but a sapu worker (which may not write into <MAIN>)
// writes agent memory into one (init also links .claude/agent-memory into new worktrees through
// worktree.symlinkDirectories, when that directory is untracked, and excludes the link in
// .git/info/exclude). A session
// whose project directory is a worktree (a desktop worktree session) is left alone. Subagents never
// carry a cd over, and dispatch only from their own place, so (1) and (2) are the main session's alone.
// From the hooks and tools references, not probed live: agent_id marks a subagent and agent_type
// alone a `--agent` main session; a main-session cd carries over inside the project directory, a
// subagent's never. Still to probe live: CLAUDE_PROJECT_DIR in a `claude --worktree` session and
// after EnterWorktree (homeIsMain also trusts a transcript filed under a worktree slug); whether a
// run_in_background command's cd carries over (rule (1) skips those); whether a Workflow's
// `agent({isolation: 'worktree'})` worktree honours worktree.symlinkDirectories (rule (3) keeps
// memory writes in <MAIN> either way).

/** The project slug Claude Code files a session under: every non-alphanumeric char → "-". */
const slug = (p) => p.replace(/[^A-Za-z0-9]/g, "-");
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** The session's project directory is <MAIN> or inside it: the checkout of CLAUDE_PROJECT_DIR (hooks get it), else the transcript's project slug. */
function homeIsMain(input, main) {
  const all = [...(typeof input.transcript_path === "string" ? input.transcript_path : "").matchAll(/[\\/]projects[\\/]([^\\/]+)[\\/]/g)];
  const filed = all.length ? all[all.length - 1][1] : null;
  // A session filed under one of <MAIN>'s worktrees started there, whatever else says so.
  if (filed && [main, realLoose(main)].some((m) => filed.startsWith(slug(path.join(m, ".claude", "worktrees")) + "-"))) return false;
  const dir = process.env.CLAUDE_PROJECT_DIR;
  if (dir) {
    const d = realLoose(dir), m = realLoose(main);
    if (under(d, m) && !under(d, path.join(m, ".claude", "worktrees"))) return true; // no git needed
    const top = checkoutRoot(dir);
    return Boolean(top) && realLoose(top) === realLoose(main);
  }
  return Boolean(filed) && (filed === slug(main) || filed === slug(realLoose(main)));
}

/** The real path of `p` (case canonicalised), or of its nearest existing ancestor plus the rest (a planned path). */
const realLoose = (p) => realPathOf(path.resolve(p));

const under = (r, dir) => r === dir || r.startsWith(dir + path.sep);

/** The linked worktree holding `p` (an existing or a planned path, symlinks resolved), or null: any path under <MAIN>/.claude/worktrees/, or a non-main entry of `git worktree list`. */
function linkedWorktreeOf(p, main) {
  const r = realLoose(p);
  const conventional = path.join(realLoose(main), ".claude", "worktrees");
  if (under(r, conventional) && r !== conventional) return path.join(conventional, path.relative(conventional, r).split(path.sep)[0]);
  let list = "";
  try { list = execFileSync("git", ["-C", main, "worktree", "list", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
  const roots = list.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => realLoose(l.slice(9))).slice(1);
  return roots.find((w) => under(r, w)) || null;
}

const COMPOUND_OPEN = new Set(["if", "while", "until", "for", "case", "select"]);
const COMPOUND_CLOSE = new Set(["fi", "done", "esac"]);
const PREFIX_WORDS = new Set(["{", "builtin", "command", "if", "then", "else", "elif", "do", "while", "until", "!"]);

/** `command` without any heredoc body: even one fed to a shell runs in a child, which never moves this shell. */
function dropHeredocBodies(command) {
  const out = [];
  let end = null;
  for (const line of command.split("\n")) {
    if (end !== null) {
      if (line.trim() === end) end = null;
      continue;
    }
    out.push(line);
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (m) end = m[2];
  }
  return out.join("\n");
}

/**
 * The directories the shell's cwd is moved to at top level by `command` run from `dir` (cd, pushd,
 * popd, `cd -` outside subshells, pipelines and background jobs), in order, each with whether it
 * runs unconditionally (after `;` or a newline, not `&&`/`||`); UNKNOWN for one that cannot be told.
 */
export function topLevelStops(command, dir) {
  let cur = dir;
  let prev = dir; // OLDPWD = the cwd when a command starts (checkText)
  const saved = [];
  const stack = [];
  const stops = [];
  let compound = 0; // inside if/while/until/for/case/select: nothing there runs for sure
  for (const c of tokenize(dropHeredocBodies(command)).cmds) {
    if (c.pre === "(") saved.push(cur);
    const before = cur;
    const at = programIndex(c.toks);
    for (const t of c.toks.slice(0, at)) if (COMPOUND_OPEN.has(t.v) && !t.dyn) compound++; // `then if …` skipped as keywords
    let a = c.toks.slice(at);
    const closes = a.length > 0 && COMPOUND_CLOSE.has(a[0].v);
    while (a.length && PREFIX_WORDS.has(a[0].v)) {
      if (COMPOUND_OPEN.has(a[0].v)) compound++;
      a = a.slice(1);
    }
    if (a.length && COMPOUND_OPEN.has(a[0].v)) compound++; // for/case/select
    const prog = a.length ? bare(a[0].v) : "";
    const moves = prog === "cd" || prog === "pushd" || prog === "popd";
    if (prog === "cd" || prog === "pushd") {
      let k = 1;
      while (k < a.length && /^-[LPeq@]+$/.test(a[k].v)) k++;
      if (a[k] && a[k].v === "--") k++;
      const target = a[k];
      let next;
      if (!target) next = prog === "cd" && c.post !== "(" ? process.env.HOME || cur : UNKNOWN; // `cd $(…)`: the target is the substitution
      else if (target.v === "-") next = prev ?? UNKNOWN;
      else if (cur === UNKNOWN || expandHome(target, cur, prev ?? UNKNOWN) === null || /^[+-]\d+$/.test(target.v)) next = UNKNOWN;
      else next = path.resolve(cur, expandHome(target, cur, prev ?? UNKNOWN));
      if (prog === "pushd") stack.push(cur);
      prev = cur;
      cur = next;
    } else if (prog === "popd") {
      prev = cur;
      cur = stack.length ? stack.pop() : UNKNOWN;
    }
    const transient = c.pre === "|" || c.post === "|" || c.post === "&";
    if (moves && !transient && !saved.length) stops.push({ dir: cur, always: c.pre === ";" && !c.cond && !compound });
    // zsh runs a pipeline's last element in this shell: a cd there may stay.
    if (moves && c.pre === "|" && c.post !== "|" && !saved.length) stops.push({ dir: cur, always: false });
    if (closes) compound = Math.max(0, compound - 1);
    if (transient) cur = moves && c.pre === "|" && c.post !== "|" ? UNKNOWN : before;
    if (c.post === ")" && saved.length) cur = saved.pop();
  }
  return stops;
}

/** PowerShell: every top-level Set-Location/Push-Location (or alias) target, resolved; UNKNOWN for a variable. */
function topLevelStopsPowerShell(command, dir) {
  const re = /(?:^|[;\n{]|&&|\|\|)\s*(?:Set-Location|Push-Location|sl|cd|chdir|pushd)\s+(?:-(?:Path|LiteralPath)(?::|\s+))?(?:'([^']*)'|"([^"]*)"|([^\s;|&}]+))/gi;
  return [...command.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[3]).map((t) => ({ dir: /^\$|\$\(/.test(t) ? UNKNOWN : path.resolve(dir, t.replace(/^~(?=[\\/]|$)/, process.env.HOME || "~")), always: false }));
}

const resetsCwd = () => /^(1|true|yes|on)$/i.test(process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR || "");

/** Rules (1) and (2) for the main session, (3) for a subagent's file write; null when none applies. */
function checkHome(input, main) {
  if (!main || !homeIsMain(input, main) || loadContract(main).missing) return null;
  const here = input.cwd || process.cwd();
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  const sub = Boolean(input.agent_id);
  if (!sub && DISPATCH_TOOLS.has(tool)) {
    const wt = linkedWorktreeOf(here, main);
    return wt ? `${/^[AEIOU]/.test(tool) ? "an" : "a"} ${tool} call starts its agents in your cwd, here the linked worktree ${wt}: their project memory and settings would come from it and be lost with it. cd "${main}" first — or ExitWorktree, if you entered it with EnterWorktree — (keep worktree work in git -C or a ( cd … ) subshell), then dispatch again.` : null;
  }
  if (!sub && (tool === "Bash" || tool === "PowerShell") && typeof ti.command === "string" && !ti.run_in_background && !resetsCwd()) {
    const stops = tool === "Bash" ? topLevelStops(ti.command, here) : topLevelStopsPowerShell(ti.command, here);
    const inMainTree = (d) => d !== UNKNOWN && under(realLoose(d), realLoose(main));
    // A worktree stop counts unless a later cd that always runs (after `;` or a newline) leaves for
    // a known place outside every worktree: `cd <wt> && npm test && cd <MAIN>` stays when the test fails.
    let wt = null;
    for (const st of stops) {
      const inWt = inMainTree(st.dir) && linkedWorktreeOf(st.dir, main);
      if (inWt) wt = inWt;
      else if (st.always && st.dir !== UNKNOWN && fs.existsSync(st.dir)) wt = null; // a cd back that cannot fail
    }
    if (!wt) return null;
    const already = linkedWorktreeOf(here, main);
    return `${already ? `the session's cwd is already the linked worktree ${already} — start with cd "${main}" && … — and this command` : "this command"} moves the session's cwd into the linked worktree ${wt}; every agent spawned while it stays there (a running Workflow's too) takes its project memory and settings from it. Run worktree work as git -C "${wt}" … or inside a ( cd "${wt}" && … ) subshell (or a cd back that always runs). The user can also set CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1 (/sapu:init writes it into .claude/settings.local.json), which resets the cwd after every command; never change settings yourself to get past this.`;
  }
  if (sub && !SAPU_AGENT.test(input.agent_type || "") && WRITE_TOOLS.has(tool)) {
    const f = ti.file_path ?? ti.notebook_path;
    if (typeof f !== "string") return null;
    const abs = realLoose(path.resolve(here, f));
    const wt = linkedWorktreeOf(abs, main);
    const rel = wt && path.relative(wt, abs);
    if (rel && /^\.claude[\\/]agent-memory(-local)?[\\/]/.test(rel)) return `agent memory written inside the linked worktree ${wt} is lost with it. Write this note to ${path.join(main, rel)} instead (the repo's memory, read by the next agent).`;
  }
  return null;
}

/** Cheap pre-filter, so ordinary calls never pay for `git worktree list`. */
function mayLeaveHome(input) {
  const ti = input.tool_input || {};
  const sub = Boolean(input.agent_id);
  if (DISPATCH_TOOLS.has(input.tool_name)) return !sub;
  if (!sub && (input.tool_name === "Bash" || input.tool_name === "PowerShell")) return typeof ti.command === "string" && /\b(cd|pushd|chdir|sl|Set-Location|Push-Location)\b/i.test(ti.command);
  return sub && WRITE_TOOLS.has(input.tool_name) && /agent-memory/.test(String(ti.file_path ?? ti.notebook_path ?? ""));
}

/** The home rules place memory; they never block a call because they failed to evaluate it. */
function checkHomeSafe(input) {
  try {
    return checkHome(input, findMain(input.cwd || process.cwd()));
  } catch {
    return null;
  }
}

export function decide(input) {
  if (!input) return null;
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  // The explorer first: it dispatches nothing, so Agent/Task/Workflow are refused here too.
  if (EXPLORER_AGENT.test(input.agent_type || "")) {
    if (tool === "StructuredOutput") return null;
    const m = tool === "Read" ? findMain(input.cwd || process.cwd()) : null;
    const why =
      tool === "Bash"
        ? checkExplorerBash(ti.command)
        : tool === "Read"
          ? checkExplorerRead({ input: ti, worktree: m ? liveWorktree(m) : null, cwd: input.cwd || process.cwd() })
          : BLOCK.explorerTool;
    if (why) return why;
  }
  const home = mayLeaveHome(input) ? checkHomeSafe(input) : null;
  if (home || DISPATCH_TOOLS.has(tool)) return home;
  // A subagent's hook input carries agent_id ("present only when the hook fires inside a subagent
  // call", hooks reference); a main session started with --agent carries agent_type alone and is the
  // orchestrator. A ladder worker or the explorer is never a main session: their type alone keeps the
  // floor, so a host that dropped agent_id would not unguard them (and the worker canary still fires).
  if (!(input.agent_id || SAPU_AGENT.test(input.agent_type || "") || EXPLORER_AGENT.test(input.agent_type || ""))) return null;
  const ctx = ctxCalls(tool, ti);
  const other = !ctx && (tool === "Monitor" || tool === "PowerShell" || /^mcp__/.test(tool || ""));
  if (tool !== "Bash" && !FILE_TOOLS.has(tool) && !SEARCH_TOOLS.has(tool) && !ctx && !other) return null;
  const here = input.cwd || process.cwd();
  // The agent's own location decides the checkout and its rules; a ctx call's own cwd only moves where it is judged.
  const main = findMain(here);
  // Measured (context-mode 1.0.169): its hook gives shell ctx_execute and ctx_batch_execute the agent's
  // cwd; another language's ctx_execute and ctx_execute_file run in the project root, the main checkout.
  const ctxHere = /__ctx_batch_execute$/.test(tool) || (/__ctx_execute$/.test(tool) && /^(shell|bash|sh|zsh)$/i.test(ti.language || ""));
  const cwd = !ctx ? here : typeof ti.cwd === "string" && ti.cwd && /execute$/.test(tool) ? path.resolve(here, ti.cwd) : ctxHere ? here : main || here;
  const { contract, error, missing } = loadContract(main);
  const rules = contract ? compileRules(contract) : ENGINE_ONLY;
  // Two tiers: a sapu worker keeps the whole floor; any other subagent (reviewers, specialists,
  // argus/momus/nemesis) may also file issues and write its state into <MAIN>.
  const worker = SAPU_AGENT.test(input.agent_type || "");
  const resolve = scopeResolver({ cwd: here, main, rules, worker });
  if (ctx) {
    for (const c of ctx) {
      const reason = c.filePath ? checkFile({ tool: "Read", filePath: c.filePath, cwd, main, rules, worker, resolve }) : typeof c.command === "string" && c.command.trim() ? check({ command: c.command, cwd, main, rules, worker, resolve }) : null;
      if (reason) return `${reason} (inside ${tool.replace(/^.*__/, "")}, checked like Bash/Read)`;
    }
  } else if (other) {
    const reason = checkOther({ tool, ti, here, main, rules, worker, resolve });
    if (reason) return `${reason} (${tool}, judged by its name and fields like Bash/Read/Write)`;
  } else if (tool === "Bash") {
    const reason = check({ command: ti.command, cwd, main, rules, worker, resolve });
    // A ladder worker's canary also proves the step budget counts it (agent_id present, counter writable).
    if (reason === BLOCK.canary && worker) return `${reason} Step budget: report step_budget: "${stepProbe({ main, agentId: input.agent_id })}".`;
    if (reason || typeof ti.command !== "string" || !ti.command.trim()) return reason;
  } else {
    const reason = SEARCH_TOOLS.has(tool) ? checkSearch({ tool, input: ti, cwd, rules, resolve }) : checkFile({ tool, filePath: ti.file_path ?? ti.notebook_path, cwd, main, rules, worker, resolve });
    if (reason) return reason;
  }
  // A contract that exists but is broken stops every subagent. No contract at all stops a sapu
  // worker (it never works without one); other subagents keep the engine floor until /sapu:init lands.
  if (error && (!missing || SAPU_AGENT.test(input.agent_type || ""))) return `the repo's sapu contract is unreadable, so nothing is allowed: ${error}`;
  return worker ? stepBudget({ main, agentId: input.agent_id, tool, command: ti.command, steps: rules.steps }) : null;
}

/** True when this file is the process's entry point, however it was reached (symlink, relative path). */
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      process.exit(0);
    }
    let reason;
    try {
      reason = decide(input);
    } catch (e) {
      // An input the checks cannot handle is refused, never waved through.
      reason = `the guard failed while checking this call (${e && e.message}), so it is refused. Simplify the command, and report it if it looks legitimate.`;
    }
    if (reason) {
      process.stderr.write(`sapu-guard: BLOCKED — ${reason}\n`);
      process.exit(2);
    }
    process.exit(0);
  });
}
