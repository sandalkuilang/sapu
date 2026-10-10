// argus-live-seed.mjs — journeys seeded from a trusted issue or a tracked doc (spec §19.12): `seed` writes the
// text a seed map slot's explorer reads through `pw <token> source`, and the merge links each journey that
// slot returned to its source. Below the slots and the wrapper, which read the seed.
//
// The text is untrusted data (an issue body, a doc anyone with commit access wrote). Nothing here acts on it:
// it is stored (0600) and digested, printed only inside a fresh fence with every fence-marker shape escaped,
// and never reaches an argv, a shell, a label or a file name. What it can change is what the map explorer
// returns, and that still passes validateMap, map-check's anchors and the owner's review like any map
// [owasp-llm01] [owasp-pi-cheat]. The fence is hygiene; those gates are the boundary.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { slotDir } from "./argus-live-browser.mjs";
import { clean, fence } from "./argus-live-fence.mjs";
import { liveDir, readLock, runIdOk } from "./argus-live-lock.mjs";
import { run, tempBeside } from "./argus-live-proc.mjs";
import { readRun } from "./argus-live-run.mjs";
import { loadContract } from "./sapu-contract.mjs";

const CONTRACT_CLI = fileURLToPath(new URL("./sapu-contract.mjs", import.meta.url));
/** `<repo-relative file>:<a>-<b>`, 1 ≤ a ≤ b. */
const RANGE = /^(.+):([1-9][0-9]{0,8})-([1-9][0-9]{0,8})$/;
const DOC_USAGE = "refused: seed: --doc takes <repo-relative file>:<a>-<b>, 1 ≤ a ≤ b";
/** The most characters a seed's text may hold; `source` prints at most PAGE_CAP of them. */
export const SEED_MAX = 100_000;
const SEED_FILE = "seed.json";
/** A seed map slot's binding, in its slot directory: kept by `down` beside the slot's returns. */
const BOUND_FILE = "seeded.json";
const KINDS = ["issue", "doc"];

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const writePrivate = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.renameSync(tempBeside(file, `${JSON.stringify(value)}\n`, 0o600), file);
};
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
/** A seed's ref as it is linked and printed: an issue number, or `<file>:<a>-<b>` with no control character. */
const refOk = (kind, ref) => (kind === "issue" ? Number.isInteger(ref) && ref > 0 : typeof ref === "string" && RANGE.test(ref) && !/[\u0000-\u001f\u007f-\u009f]/.test(ref));

/** The running cycle that has a worktree → its run.json record; refused otherwise. */
function seedCycle(main) {
  const lock = readLock(main);
  if (!lock) throw new Error("refused: seed: no journey cycle is running (up --map or up first)");
  if (lock.deadline * 1000 <= Date.now()) throw new Error(`refused: seed: the deadline of cycle ${lock.runId} passed; run down`);
  const rec = readRun(main);
  if (!rec || rec.runId !== lock.runId || rec.closing) throw new Error(`refused: seed: cycle ${lock.runId} is being torn down`);
  if (typeof rec.worktree !== "string") throw new Error(`refused: seed: cycle ${lock.runId} has no worktree yet`);
  return rec;
}

/**
 * Issue `n` → `{kind, ref, url, text}`, only when `sapu-contract.mjs issue-trust <n> --text` passes (its
 * verdict judged the very title and body it returns; GitHub unreadable is a refusal). A pull request is refused.
 */
function issueSeed(main, n, runner) {
  const r = runner([process.execPath, CONTRACT_CLI, "issue-trust", String(n), "--text"], { cwd: main });
  let v = null;
  try {
    v = JSON.parse(r.stdout);
  } catch {
    v = null;
  }
  if (r.status !== 0 || !v || v.trusted !== true || typeof v.title !== "string" || typeof v.body !== "string") {
    throw new Error(`refused: seed: issue ${n} fails issue-trust (sapu-contract.mjs issue-trust ${n} says why)`);
  }
  if (v.kind !== "issue") throw new Error(`refused: seed: ${n} is a pull request, not an issue`);
  const c = loadContract(main);
  if (!c.contract || typeof c.contract.repo !== "string") throw new Error(`refused: seed: ${c.error ?? "the contract names no repo"}`);
  return { kind: "issue", ref: n, url: `https://github.com/${c.contract.repo}/issues/${n}`, text: `${v.title}\n\n${v.body}` };
}

/**
 * `<file>:<a>-<b>` → `{kind, ref, file, lines, commit, text}`: lines a to b of a regular file tracked at the
 * run worktree's HEAD (what the map explorer reads and the merged map is stamped with), read from git's
 * object, never from a working tree or through a symlink.
 */
function docSeed(rec, doc, runner) {
  const m = typeof doc === "string" ? RANGE.exec(doc) : null;
  const file = m ? m[1] : "";
  const shaped = m && Number(m[2]) <= Number(m[3]) && !path.isAbsolute(file) && !file.startsWith("-") && !file.split(/[\\/]/).includes("..") && !/[\u0000-\u001f\u007f-\u009f]/.test(file);
  if (!shaped) throw new Error(DOC_USAGE);
  const [a, b] = [Number(m[2]), Number(m[3])];
  const wt = rec.worktree;
  const ls = runner(["git", "--literal-pathspecs", "-C", wt, "ls-tree", "-z", "HEAD", "--", file]);
  if (ls.error || ls.status !== 0) throw new Error(`failed: seed: git cannot list ${file} at HEAD`);
  const entry = String(ls.stdout).split("\0").map((e) => /^([0-7]{6}) (\w+) ([0-9a-f]{40,64})\t(.*)$/s.exec(e)).find((e) => e && e[4] === file);
  if (!entry) throw new Error(`refused: seed: ${file} is not tracked at HEAD`);
  if (!["100644", "100755"].includes(entry[1]) || entry[2] !== "blob") throw new Error(`refused: seed: ${file} is not a regular file at HEAD (a symlink or a directory)`);
  const blob = runner(["git", "-C", wt, "cat-file", "blob", entry[3]]);
  if (blob.error || blob.status !== 0) throw new Error(`failed: seed: git cannot read ${file} at HEAD`);
  const all = String(blob.stdout).replace(/\n$/, "").split("\n");
  if (b > all.length) throw new Error(`refused: seed: ${file} has ${all.length} lines; the range ends past them`);
  const head = runner(["git", "-C", wt, "rev-parse", "HEAD"]);
  return { kind: "doc", ref: doc, file, lines: [a, b], commit: String(head.stdout).trim(), text: all.slice(a - 1, b).join("\n") };
}

/**
 * `seed (--issue <n> | --doc <file>:<a>-<b>)` → `{code, lines}`: exactly one of `issue` (a number) and `doc` (as
 * typed) is set; `masked`: the line holds no secret, so the CLI prints it as it is. In a running cycle with a worktree (`up --map` or a full `up`), it writes `<run>/seed.json`
 * (0600: kind, ref, the URL or the file, lines and commit, the text and its sha256) and prints `seed: <kind>
 * <ref> <sha12> <k> characters`; the text itself is never printed here. A later `seed` replaces it: a seed
 * slot minted before then refuses `source`. Refused: no such cycle, an issue issue-trust refuses, a pull
 * request, a doc range that is not one, a file not tracked at HEAD or not a regular file, a range past the
 * file's end, an empty text, a text over SEED_MAX characters.
 */
export function seed(main, { issue, doc }, { runner = run } = {}) {
  if (issue !== null && issue !== undefined && !(Number.isInteger(issue) && issue > 0)) throw new Error("refused: seed: --issue takes an issue number");
  const rec = seedCycle(main);
  const s = issue !== null && issue !== undefined ? issueSeed(main, issue, runner) : docSeed(rec, doc, runner);
  if (s.text.trim() === "") throw new Error("refused: seed: the text is empty");
  if (s.text.length > SEED_MAX) throw new Error(`refused: seed: the text is ${s.text.length} characters, at most ${SEED_MAX}`);
  const digest = sha256(s.text);
  writePrivate(path.join(liveDir(main), rec.runId, SEED_FILE), { ...s, digest });
  // Words the wrapper made and the owner's own ref, no secret: masking would only cut the digest.
  return { code: 0, lines: [`seed: ${s.kind} ${s.ref} ${digest.slice(0, 12)} ${s.text.length} characters`], masked: true };
}

/** Run `runId`'s seed → `{kind, ref, text, digest, …}`, or null when it has none or it does not hold together. */
export function readSeed(main, runId) {
  runIdOk(runId);
  const s = readJson(path.join(liveDir(main), runId, SEED_FILE));
  const ok = s && KINDS.includes(s.kind) && refOk(s.kind, s.ref) && typeof s.text === "string" && s.digest === sha256(s.text);
  return ok ? s : null;
}

/** Binds a seed map slot (its directory `dir`) to seed `s`: `<dir>/seeded.json` (0600) `{kind, ref, digest}`. */
export function bindSeed(dir, s) {
  writePrivate(path.join(dir, BOUND_FILE), { kind: s.kind, ref: s.ref, digest: s.digest });
}

/** The seed a slot directory `dir` is bound to → `{kind, ref, digest}`, or null for any other slot. */
export function boundSeed(dir) {
  const b = readJson(path.join(dir, BOUND_FILE));
  return b && KINDS.includes(b.kind) && refOk(b.kind, b.ref) && typeof b.digest === "string" && /^[0-9a-f]{64}$/.test(b.digest) ? b : null;
}

/** U+2011, the non-breaking hyphen, as the fence module writes it. */
const NB_HYPHEN = "‑";
/** The source fence's own marker shapes: an opening `<<<SOURCE-`, or `SOURCE-` before a 32-hex nonce. */
const SOURCE_MARKER = /(<<<SOURCE)-|SOURCE-(?=[0-9a-f]{32}(?![0-9a-f]))/g;

/**
 * `pw <token> source` for seed map slot `slot` of run `runId` (its directory `dir`) → `{lines, truncated}`:
 * `source: <kind> <ref>`, then the seed's text cleaned (clean: secret values masked, controls replaced, the
 * page and return marker shapes escaped), its `SOURCE` marker shapes escaped too, in a fresh `<<<SOURCE-<nonce>`
 * fence of at most PAGE_CAP characters. Refused: a slot that is not a seed slot, a seed replaced since the
 * slot was minted.
 */
export function sourceLines(main, runId, slot, dir, { secrets = {} } = {}) {
  const bound = boundSeed(dir);
  if (!bound) throw new Error("refused: source takes a seed map slot's token (slot <n> --map --seed)");
  const s = readSeed(main, runId);
  if (!s || s.digest !== bound.digest) throw new Error(`refused: source: the run's seed changed since slot ${slot} was minted`);
  const text = clean(s.text, { secrets }).replace(SOURCE_MARKER, (_m, open) => `${open || "SOURCE"}${NB_HYPHEN}`);
  const { body, truncated } = fence(text, { label: "SOURCE" });
  return { lines: [`source: ${s.kind} ${s.ref}`, body], truncated };
}

/**
 * The seeds `map-check --merge <slot>` links to each journey slot `slot` of run `runId` returned →
 * `[{kind, ref}]`, empty when the slot was not a seed map slot. Read from the slot's binding, which `down` keeps.
 */
export function seedsOf(main, runId, slot) {
  const b = boundSeed(slotDir(main, runId, slot));
  return b ? [{ kind: b.kind, ref: b.ref }] : [];
}
