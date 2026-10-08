// argus-live-hooks.mjs — the explorer's role-free commands that reach the app's own tooling or code (spec
// §9 "Values into commands", decision 12): `trigger`, `facts` and `mail` run an argv from
// `.argus/live.json` with no shell, each explorer value replacing one placeholder after its regex allowed
// it (never a leading `-`), in the worktree, under the instance environment, in a process group of its
// own killed afterwards; `code grep|files` reads HEAD's tree of the worktree through a fixed git argv with
// literal pathspecs. Whatever they print is page data: the caller fences it.
import path from "node:path";
import { PAGE_CAP } from "./argus-live-fence.mjs";
import { run, runAsync } from "./argus-live-proc.mjs";

/** A value's default shape (spec §9): a letter or digit, then letters, digits and `._@:-`, at most 128. */
export const VALUE = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/;

/** How a refusal shows a name: as given when it is a short plain word, else not at all. */
const shownName = (s) => (typeof s === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(s) ? s : "that");

/**
 * `argv` with every `{i}` (1-based) replaced by `values[i-1]` inside its element → a new argv. The
 * number of values must equal the highest placeholder; each value must match `args[i-1]` (as
 * `^(?:…)$`) when given, else VALUE, and never start with `-` (even when its regex allows it); else
 * `refused: value <i> of <name> does not match <regex>` or `refused: <name> takes <n> value(s)`.
 */
export function fillArgv(argv, args = [], values, name = "the command") {
  const highest = Math.max(0, ...argv.flatMap((el) => [...String(el).matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1]))));
  if (!Array.isArray(values) || values.length !== highest) throw new Error(`refused: ${shownName(name)} takes ${highest} value${highest === 1 ? "" : "s"}`);
  values.forEach((v, i) => {
    const source = Array.isArray(args) && typeof args[i] === "string" ? args[i] : VALUE.source;
    const re = Array.isArray(args) && typeof args[i] === "string" ? new RegExp(`^(?:${args[i]})$`) : VALUE;
    if (typeof v !== "string" || v.startsWith("-") || !re.test(v)) throw new Error(`refused: value ${i + 1} of ${shownName(name)} does not match ${source}${typeof v === "string" && v.startsWith("-") ? " without a leading -" : ""}`);
  });
  return argv.map((el) => String(el).replace(/\{(\d+)\}/g, (_m, k) => values[Number(k) - 1]));
}

/** At most PAGE_CAP characters of `text` (the fence caps again; this bounds what is parsed). */
const capped = (text) => String(text ?? "").slice(0, PAGE_CAP * 4);

/**
 * Runs a hook of `.argus/live.json` (the expanded config `live`) → `{code, stdout, events}`: `kind`
 * `trigger` (`live.triggers[name]`; an unknown name is refused), `facts` (`live.facts`, one value: the
 * marker) or `mail` (`live.mail`, no value). Its argv (fillArgv) runs with no shell in run.json's
 * worktree under run.json's `env`, in its own process group, killed with that group when it exits or
 * after settle_ms + 30 s. `mail` must print a JSON array of `{to, subject, text}` and `facts` a JSON
 * object, else the event `harness: <kind> printed no JSON`; a hook that timed out is `harness: <kind>
 * timed out`. `stdout` is page data (the caller fences it); `events` are the wrapper's own words.
 */
export async function runHook(kind, name, values, { rec, live, runner = runAsync }) {
  let hook;
  if (kind === "trigger") {
    hook = live.triggers && Object.hasOwn(live.triggers, name) ? live.triggers[name] : null;
    if (!hook) throw new Error(`refused: ${shownName(name)} is not a trigger of .argus/live.json`);
  } else {
    hook = live[kind] ?? null;
    if (!hook) throw new Error(`refused: .argus/live.json has no ${kind} command`);
  }
  const argv = fillArgv(hook.argv, hook.args, values, kind === "trigger" ? name : kind);
  const limit = (live.settle_ms ?? 10_000) + 30_000;
  const r = await runner(argv, { cwd: rec.worktree, env: { ...(rec.env ?? {}) }, timeoutMs: limit, stdio: ["ignore", "pipe", "pipe"], capture: true, killAfter: true });
  const events = [];
  if (r.error) throw new Error(`failed: the ${kind} command could not run: ${r.error.code ?? "error"}`);
  if (r.timedOut) events.push(`harness: ${kind} timed out`);
  const stdout = capped(r.stdout);
  if (!r.timedOut && (kind === "facts" || kind === "mail")) {
    let v;
    try {
      v = JSON.parse(stdout);
    } catch {
      v = undefined;
    }
    const ok = kind === "facts" ? v !== null && typeof v === "object" && !Array.isArray(v) : Array.isArray(v) && v.every((m) => m && typeof m === "object" && ["to", "subject", "text"].every((k) => typeof m[k] === "string"));
    if (!ok && r.status === 0) events.push(`harness: ${kind} printed no JSON`);
  }
  return { code: r.timedOut ? null : (r.status ?? null), stdout, events };
}

/** A pathspec as the explorer gives it → repo-relative, or a refusal: an absolute path must lie inside the worktree; no `..`, no leading `-` or `:`. */
function pathspecOf(spec, worktree) {
  const refuse = () => new Error(`refused: ${typeof spec === "string" && /^[\x20-\x7e]{1,200}$/.test(spec) ? spec : "that pathspec"} is not a path inside the worktree`);
  if (typeof spec !== "string" || spec === "" || spec.length > 1000 || /[\u0000-\u001f\u007f]/.test(spec)) throw refuse();
  let rel = spec;
  if (path.isAbsolute(spec)) {
    rel = path.relative(worktree, spec);
    if (rel === "") return ".";
    if (path.isAbsolute(rel)) throw refuse();
  }
  if (rel.split("/").some((seg) => seg === "..") || /^[-:]/.test(rel)) throw refuse();
  return rel;
}

/** True for a path under `.argus/`, compared without case (the run's own state is not the explorer's to read). */
const argusPath = (p) => {
  const l = p.toLowerCase();
  return l === ".argus" || l.startsWith(".argus/");
};

/**
 * `code grep <pattern> [<pathspec>]` and `code files [<pathspec>]` (spec §9, decision 12) on HEAD's tree of
 * `worktree` → `{code, text}`: `git --literal-pathspecs -C <wt> grep -z -n -I --no-color -e <pattern> HEAD
 * -- [<pathspec>]` (the `HEAD:` prefix stripped; exit 1, no match, is an empty text) or `git
 * --literal-pathspecs -C <wt> ls-tree -z -r --name-only HEAD -- [<pathspec>]`. Tracked files only (HEAD,
 * as the explorer's Read); any path under `.argus/` (any case) dropped; each path printed absolute inside
 * the worktree. The pattern is never an option (`-e`), the pathspec never a magic one.
 */
export function codeCommand(sub, args, { worktree, runner = run }) {
  if (sub !== "grep" && sub !== "files") throw new Error("refused: code takes grep <pattern> [<pathspec>] or files [<pathspec>]");
  const [pattern, spec] = sub === "grep" ? args : [null, args[0]];
  if (sub === "grep" && (args.length < 1 || args.length > 2)) throw new Error("refused: code grep takes <pattern> [<pathspec>]");
  if (sub === "files" && args.length > 1) throw new Error("refused: code files takes [<pathspec>]");
  if (sub === "grep" && (typeof pattern !== "string" || pattern === "" || pattern.length > 1000 || /[\u0000\n\r]/.test(pattern))) throw new Error("refused: code grep takes one pattern of at most 1000 characters on one line");
  const tail = spec === undefined ? [] : ["--", pathspecOf(spec, worktree)];
  const argv = sub === "grep" ? ["git", "--literal-pathspecs", "-C", worktree, "grep", "-z", "-n", "-I", "--no-color", "-e", pattern, "HEAD", ...tail] : ["git", "--literal-pathspecs", "-C", worktree, "ls-tree", "-z", "-r", "--name-only", "HEAD", ...tail];
  const r = runner(argv, { cwd: worktree });
  if (r.error) throw new Error(`failed: git could not run: ${r.error.code ?? "error"}`);
  if (sub === "grep" && r.status === 1) return { code: 0, text: "" };
  if (r.status !== 0) return { code: r.status, text: String(r.stderr ?? "").trim() };
  const out = String(r.stdout ?? "");
  const lines = [];
  if (sub === "files") {
    for (const p of out.split("\0")) if (p && !argusPath(p)) lines.push(path.join(worktree, p));
  } else {
    // -z: `HEAD:<path>\0<line>\0<text>\n` per match.
    for (const rec of out.split("\n")) {
      const [file, line, ...text] = rec.split("\0");
      if (!file || line === undefined) continue;
      const p = file.replace(/^HEAD:/, "");
      if (!argusPath(p)) lines.push(`${path.join(worktree, p)}:${line}:${text.join("\0")}`);
    }
  }
  return { code: 0, text: lines.join("\n") };
}
