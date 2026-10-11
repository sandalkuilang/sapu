// argus-live-drift.mjs — doc drift (spec §5, decision 24): a doc sentence that contradicts coherent behaviour
// is decided by line-level history, the newest author time of the doc's lines against the newest of the
// code lines that implement the behaviour (a rebase or cherry-pick rewrites the committer time, never when a
// line was written). It reads git's blame and nothing else.
import path from "node:path";
import { run } from "./argus-live-proc.mjs";

/** `<repo-relative file>:<a>-<b>`, 1 ≤ a ≤ b. */
const RANGE = /^(.+):([1-9][0-9]{0,8})-([1-9][0-9]{0,8})$/;
const UNCOMMITTED = /^0{40}(0{24})?$/;

/** A range as the CLI takes it → {file, a, b}; refused when it is not one, or its file leaves the repo. */
function parseRange(range) {
  const m = typeof range === "string" ? RANGE.exec(range) : null;
  const ok = m && Number(m[2]) <= Number(m[3]) && !path.isAbsolute(m[1]) && !m[1].split(/[\\/]/).includes("..") && !/[\u0000-\u001f]/.test(m[1]);
  if (!ok) throw new Error(`refused: drift: ${range} is not <repo-relative file>:<a>-<b>`);
  return { file: m[1], a: Number(m[2]), b: Number(m[3]) };
}

/**
 * The newest author time (epoch seconds) of a range's lines → a number, or `{why}`: `uncommitted lines` (a
 * line no commit holds), `no history` (git's blame failed: no such file at HEAD, a range past its end).
 */
function newest(main, { file, a, b }, runner) {
  const r = runner(["git", "-C", main, "blame", "--porcelain", "-L", `${a},${b}`, "--", file]);
  if (r.error || r.status !== 0) return { why: "no history" };
  const times = new Map();
  const shas = new Set();
  let sha = null;
  for (const line of String(r.stdout).split("\n")) {
    const head = /^([0-9a-f]{40,64}) \d+ \d+/.exec(line);
    if (head) {
      sha = head[1];
      shas.add(sha);
    } else if (sha && line.startsWith("author-time ")) times.set(sha, Number(line.slice(12)));
  }
  if (!shas.size) return { why: "no history" };
  if ([...shas].some((s) => UNCOMMITTED.test(s))) return { why: "uncommitted lines" };
  const ts = [...shas].map((s) => times.get(s));
  if (ts.some((t) => !Number.isFinite(t))) return { why: "no history" };
  return Math.max(...ts);
}

/**
 * Doc drift (spec §5, decision 24): `git blame --porcelain -L <a>,<b> -- <file>` for `doc` and each of `code`
 * (ranges `<repo-relative file>:<a>-<b>`) → `{verdict: "code-newer" | "doc-newer" | "undecidable", why?}` by
 * the newest author time on each side; a range git cannot place in its history (`why` uncommitted lines or
 * no history) or equal times (`same time`) is undecidable. Refused: a range that is not one.
 */
export function drift(main, { doc, code }, { runner = run } = {}) {
  const d = parseRange(doc);
  if (!Array.isArray(code) || !code.length) throw new Error("refused: drift: at least one code range");
  const cs = code.map(parseRange);
  const docTime = newest(main, d, runner);
  if (typeof docTime !== "number") return { verdict: "undecidable", why: docTime.why };
  let codeTime = -Infinity;
  for (const c of cs) {
    const t = newest(main, c, runner);
    if (typeof t !== "number") return { verdict: "undecidable", why: t.why };
    codeTime = Math.max(codeTime, t);
  }
  if (codeTime === docTime) return { verdict: "undecidable", why: "same time" };
  return { verdict: codeTime > docTime ? "code-newer" : "doc-newer" };
}
