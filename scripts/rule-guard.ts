// scripts/rule-guard.ts — repo tooling, not shipped with the plugin.
// Weakening or deleting an engine rule of the sapu plugin must be a conscious, visible act.
//
// WHY THIS EXISTS. The plugin's skills (plugins/sapu/skills/**), agent definitions
// (plugins/sapu/agents/**), its contract format (plugins/sapu/CONTRACT.md) and the README are the
// rules every sapu agent obeys. They are edited constantly — trimming, rewording, "cleaning up" —
// and a well-meant trim can drop the one sentence that said "never" or "wajib" without anyone
// meaning to. Nobody re-reads a long rulebook diff on every PR, so the gate does it: a diff that
// LOSES or REWRITES a normative clause goes red unless a commit in the range says, in a trailer,
// that the rule change is intended:
//
//     Rule-Change: <reason, at least 20 characters>
//
// This does not forbid changing rules. It makes a change impossible to do by accident and puts
// the reason in the history. Pure ADDITIONS never trip it — tightening is free.
//
// WHAT COUNTS — CLAUSE LEVEL, NOT LINE LEVEL. This is a port of the rule guard of the repo the
// plugin was extracted from. Its first version flagged any removed line that contained a
// normative word; replayed against the 116 real commits that had touched its rule files, 79 went
// red — almost all of them appending to one very long rule line, or fixing a typo elsewhere on a
// line that merely happened to hold a "never". A guard that cries wolf gets a trailer pasted on
// every commit and stops meaning anything. So the unit is the clause, compared file to file:
//   1. for every rule file the diff touches, split the OLD and the NEW text into segments
//      (a blank line, heading, list item, table row or quote starts one; a wrapped paragraph
//      is one segment) and each segment into clauses (sentence ends, `;`, `:`, dashes,
//      parentheses, table bars); whitespace and markdown emphasis are normalised;
//   2. every OLD clause that contains a normative word must have an IDENTICAL clause in the
//      NEW file — set membership, not substring search. Moving it, re-wrapping it, or adding
//      text elsewhere are fine; but "Never merge a red PR." -> "... unless the owner is
//      asleep." is a different clause and goes red, and so does a lone "Never." bullet whose
//      word merely survives elsewhere;
//   3. a clause with no identical twin was lost or changed: red.
// Normative words (whole words, case-insensitive): wajib, harus, required, jangan, do not,
// don't, tak/tidak pernah, tak/tidak boleh, dilarang, larangan, hanya, only, selalu, always,
// must, never, should.
//
// ALSO GUARDED — what enforces or bounds the rules, versus <base>:
//   * an agent definition's frontmatter `tools:` / `model:` / `effort:` changed, or the file
//     deleted (that is a change to what the agent may do);
//   * the files that ENFORCE the rules, changed at all or deleted (ENFORCEMENT_FILES): the hook
//     wiring (plugins/sapu/hooks/hooks.json), the Bash guard (sapu-guard.mjs), the merge path
//     (sapu-merge.sh), the contract loader (sapu-contract.mjs), the wave runner (sapu-wave.js),
//     the engine scan and context budgets (tests/engine.test.ts), and this guard with its own
//     test. A rule an agent obeys is only as strong as the code that enforces it, and a small
//     edit to that code weakens it as surely as deleting a "never" — so no diff of these files
//     is judged "harmless" by the gate; tightening one needs a trailer too;
//   * additionally, a context budget in tests/engine.test.ts (an entry of `BUDGETS`,
//     `SKILL_DEFAULT`, `AGENT_LIMIT`) that went UP or vanished is named on its own line;
//   * package.json's `gate` no longer running `node scripts/rule-guard.ts` as a step of its own
//     (`&&`-separated, nothing appended to it), or containing, ANYWHERE, shell syntax that can
//     make the whole gate exit 0 although the guard failed: `||`, `;`, a lone `&`, a newline,
//     or `exit` (`… && node scripts/rule-guard.ts && vitest run || true` keeps the guard's
//     step intact and still passes on red);
//   * any of those files present at <base> but missing at HEAD is red, never silently skipped.
//
// <base> is `origin/main`, or GATE_DIFF_BASE when set.
//
// Run: node scripts/rule-guard.ts   (Node >= 22.18 strips the types; keep the syntax erasable)
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const RULE_PATHS = [
  "README.md",
  "plugins/sapu/CONTRACT.md",
  "plugins/sapu/skills",
  "plugins/sapu/agents",
] as const;
export const AGENTS_DIR = "plugins/sapu/agents/";
export const HOOKS_FILE = "plugins/sapu/hooks/hooks.json";
export const BUDGET_FILE = "tests/engine.test.ts";
export const GUARD_FILE = "scripts/rule-guard.ts";
export const PACKAGE_FILE = "package.json";
/** The exact `&&`-step of package.json's `gate` that runs this guard. */
export const GUARD_COMMAND = `node ${GUARD_FILE}`;
/** Files that enforce the rules, with why: ANY change to one (or its deletion) needs a trailer. */
export const ENFORCEMENT_FILES: Readonly<Record<string, string>> = {
  [HOOKS_FILE]: "it wires the plugin's guard hook",
  "plugins/sapu/scripts/sapu-guard.mjs": "it is the Bash guard of every sapu agent",
  "plugins/sapu/scripts/sapu-merge.sh": "it is the merge path of every PR",
  "plugins/sapu/scripts/sapu-contract.mjs": "it loads and enforces the repo contract",
  "plugins/sapu/workflows/sapu-wave.js": "it runs every wave: workers, reviews, fix cycles",
  "plugins/sapu/workflows/inspector.js": "it sequences momus, argus and nemesis and picks their models",
  [BUDGET_FILE]: "it holds the engine scan and the context budgets",
  [GUARD_FILE]: "it is the rule guard itself",
  "tests/rule-guard.test.ts": "it proves the rule guard",
};
/** Present at <base> => must still be present at HEAD. */
export const WATCHED_FILES = [...Object.keys(ENFORCEMENT_FILES), PACKAGE_FILE];

/** Shell syntax that can make a whole `gate` exit 0 although one of its steps failed. */
const GATE_NEUTRALISERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\|\|/, "`||`"],
  [/;/, "`;`"],
  [/(?<!&)&(?!&)/, "`&`"],
  [/[\r\n]/, "a newline"],
  [/\bexit\b/, "`exit`"],
];

export const TRAILER_KEY = "Rule-Change";
/** A one-word trailer ("ok", "cleanup") is a rubber stamp, not a reason. */
export const MIN_REASON_LENGTH = 20;

// Whole words only, Unicode-aware: `must` must not fire on "mustahil", nor `only` on "lonely".
const NORMATIVE =
  /(?<![\p{L}\p{N}_-])(?:wajib|harus|required|jangan|do\s+not|don['’]t|(?:tak|tidak)\s+pernah|(?:tak|tidak)\s+boleh|dilarang|larangan|hanya|only|selalu|always|must|never|should)(?![\p{L}\p{N}_-])/iu;

export const isNormative = (text: string): boolean => NORMATIVE.test(text);

// ── clause extraction ───────────────────────────────────────────────────────

/** Collapse whitespace, drop markdown emphasis/code ticks and a leading list/quote marker. */
export function normalizeText(s: string): string {
  return s
    .replace(/[`*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const CLAUSE_BOUNDARY = /(?<=[.!?])\s+|[;:]\s+|\s+[—–-]\s+|\s*[—–]\s*|[()|]/;

/** Normalised clauses of `text`, without empty ones and without leading list markers. */
export function splitClauses(text: string): string[] {
  return normalizeText(text)
    .split(CLAUSE_BOUNDARY)
    .map((c) => c.trim().replace(/^(?:[-+>]|\d+\.|#{1,6})\s+/, "").replace(/[.!?,]+$/, "").trim())
    .filter((c) => c.length > 0);
}

export interface Segment {
  /** 1-based line number where the segment starts. */
  line: number;
  text: string;
}

// A line that opens its own segment: heading, list item, table row or quote. Blank lines end one.
const HEADING_LINE = /^\s*#{1,6}\s/;
const STRUCTURAL_LINE = /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>)/;

/**
 * Text -> segments. Structure (blank line, heading, list item, table row, quote) starts a new
 * segment; any other line continues the current one, so a paragraph wrapped over several lines
 * is ONE thought and re-wrapping it changes nothing.
 */
export function segmentText(text: string): Segment[] {
  const out: Segment[] = [];
  let cur: Segment | null = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === "") {
      cur = null;
    } else if (cur === null || STRUCTURAL_LINE.test(raw)) {
      cur = { line: i + 1, text: raw };
      out.push(cur);
      // A heading is a segment of its own: prose right under it (no blank line) must not fuse
      // with it, or renaming/inserting a heading would rewrite every clause below it.
      if (HEADING_LINE.test(raw)) cur = null;
    } else {
      cur.text += " " + raw;
    }
  }
  return out;
}

/** Every clause of a whole file text, with the line its segment starts on. */
export function clausesOf(text: string): Array<{ clause: string; line: number }> {
  return segmentText(text).flatMap((seg) => splitClauses(seg.text).map((clause) => ({ clause, line: seg.line })));
}

export interface TouchedLine {
  file: string;
  /** 1-based line number in the OLD file where the lost clause started. */
  line: number;
  /** The normative clause that no longer occurs, IDENTICALLY, in the new version of the file. */
  text: string;
}

/**
 * Normative clauses of the old file that have no IDENTICAL clause in the new file (`null` = the
 * file was deleted). Set membership on whole clauses, not substring search: appending an
 * exception to a rule ("Never merge a red PR." -> "... unless the owner is asleep.") changes the
 * clause and must be red, and a short bullet like "Never." must not be considered safe just
 * because the word survives somewhere else. Comparing whole files (not diff hunks) also
 * reconstructs a sentence wrapped over several lines even when only its second line was edited.
 */
export function findLostNormativeClauses(oldText: string, newText: string | null, file: string): TouchedLine[] {
  const kept = new Set(newText === null ? [] : clausesOf(newText).map((c) => c.clause));
  const lost: TouchedLine[] = [];
  const seen = new Set<string>();
  for (const { clause, line } of clausesOf(oldText)) {
    if (!isNormative(clause) || kept.has(clause) || seen.has(clause)) continue;
    seen.add(clause);
    lost.push({ file, line, text: clause });
  }
  return lost;
}

/** `tools:` / `model:` / `effort:` lines of an agent definition's YAML frontmatter. */
export function agentFrontmatter(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const k = line.match(/^(tools|model|effort):\s*(.*?)\s*$/);
    if (k) out.set(k[1], k[2]);
  }
  return out;
}

/** A change to an agent's tools / model / effort is a change to what it may do: always deliberate. */
export function findChangedAgentFrontmatter(file: string, baseText: string, headText: string): string[] {
  const base = agentFrontmatter(baseText);
  const head = agentFrontmatter(headText);
  const out: string[] = [];
  for (const key of new Set([...base.keys(), ...head.keys()])) {
    const was = base.get(key);
    const now = head.get(key);
    if (was !== now) out.push(`${file}: frontmatter ${key} changed: ${was ?? "(absent)"} -> ${now ?? "(absent)"}`);
  }
  return out;
}

// ── the guards' own limits ──────────────────────────────────────────────────

const toNumber = (digits: string): number => Number(digits.replace(/_/g, ""));

/**
 * The context budgets of tests/engine.test.ts, keyed `BUDGETS[<path>]`, `SKILL_DEFAULT` and
 * `AGENT_LIMIT`. Only the entries of the `BUDGETS` object literal count, so another quoted number
 * elsewhere in the test file is never mistaken for a budget.
 */
export function parseBudgetLimits(src: string): Map<string, number> {
  const limits = new Map<string, number>();
  const block = src.match(/\bBUDGETS\b[^=]*=\s*\{([\s\S]*?)\}/);
  if (block) {
    for (const m of block[1].matchAll(/["']([^"']+)["']\s*:\s*([\d_]+)/g)) limits.set(`BUDGETS[${m[1]}]`, toNumber(m[2]));
  }
  for (const name of ["SKILL_DEFAULT", "AGENT_LIMIT"]) {
    const m = src.match(new RegExp(`\\b${name}\\s*=\\s*([\\d_]+)`));
    if (m) limits.set(name, toNumber(m[1]));
  }
  return limits;
}

/** Human-readable lines for every limit that rose or vanished between base and head. */
export function findLoosenedBudgets(baseSrc: string, headSrc: string): string[] {
  const base = parseBudgetLimits(baseSrc);
  const head = parseBudgetLimits(headSrc);
  const out: string[] = [];
  for (const [key, was] of base) {
    const now = head.get(key);
    if (now === undefined) out.push(`${BUDGET_FILE}: budget ${key} was removed (was ${was})`);
    else if (now > was) out.push(`${BUDGET_FILE}: budget ${key} raised ${was} -> ${now}`);
  }
  return out;
}

/** package.json's `gate` script, or null when there is none. */
export function gateScript(packageJson: string): string | null {
  try {
    const gate = JSON.parse(packageJson)?.scripts?.gate;
    return typeof gate === "string" ? gate : null;
  } catch {
    return null;
  }
}

/** The `&&`-separated steps of package.json's `gate` script, or null when there is none. */
export function gateSteps(packageJson: string): string[] | null {
  return gateScript(packageJson)?.split("&&").map((s) => s.trim()) ?? null;
}

/**
 * Red when the gate ran this guard at base and, at HEAD, it does not — or it does, but the gate
 * can exit 0 anyway. The step must stay exactly `node scripts/rule-guard.ts` (an env override in
 * front of it or anything appended to it defeats it while keeping the text), AND the whole gate
 * string must be free of every GATE_NEUTRALISER: `… && vitest run || true` leaves the guard's
 * own step intact and still turns a red guard into a green gate.
 */
export function findUnwiredGuard(basePackageJson: string, headPackageJson: string): string[] {
  if (!gateSteps(basePackageJson)?.includes(GUARD_COMMAND)) return []; // not wired at base: nothing to lose
  const gate = gateScript(headPackageJson);
  if (gate === null) return [`${PACKAGE_FILE}: no readable \`gate\` script at HEAD (it ran \`${GUARD_COMMAND}\`)`];
  const out: string[] = [];
  if (!gateSteps(headPackageJson)?.includes(GUARD_COMMAND)) {
    out.push(`${PACKAGE_FILE}: the \`gate\` script no longer runs \`${GUARD_COMMAND}\` as a step of its own`);
  }
  for (const [pattern, label] of GATE_NEUTRALISERS) {
    if (pattern.test(gate)) {
      out.push(`${PACKAGE_FILE}: the \`gate\` script contains ${label}, which can make it exit 0 although the guard failed`);
    }
  }
  return out;
}

/** Non-empty `Rule-Change:` trailer values of at least MIN_REASON_LENGTH characters. */
export function parseRuleChangeReasons(trailerOutput: string): string[] {
  return trailerOutput
    .split("\0")
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_REASON_LENGTH);
}

export interface RuleGuardResult {
  touched: TouchedLine[];
  loosened: string[];
  reasons: string[];
  /** Red iff something rule-weakening was found and no commit carries a reason. */
  ok: boolean;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

export function resolveBase(env: NodeJS.ProcessEnv = process.env): string {
  const ref = env.GATE_DIFF_BASE?.trim() || "origin/main";
  if (ref.startsWith("-")) throw new Error(`GATE_DIFF_BASE must be a git ref, got "${ref}"`);
  return ref;
}

export function evaluateRuleGuard(cwd: string, base: string, head = "HEAD"): RuleGuardResult {
  if (tryGit(cwd, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]) === null) {
    throw new Error(`rule-guard: diff base "${base}" is not a commit (fetch it, or set GATE_DIFF_BASE)`);
  }
  // What the branch was cut from. Reading old content at the tip of <base> instead would blame
  // this branch for whatever landed on main since it was cut.
  const mergeBase = tryGit(cwd, ["merge-base", base, head])?.trim() || base;
  const baseOf = (file: string) => tryGit(cwd, ["show", `${mergeBase}:${file}`]);
  const headOf = (file: string) => tryGit(cwd, ["show", `${head}:${file}`]);

  const touched: TouchedLine[] = [];
  const loosened: string[] = [];

  const changes = git(cwd, ["diff", "--name-status", "-M", "--no-color", "--no-ext-diff", `${base}...${head}`, "--", ...RULE_PATHS]);
  for (const row of changes.split("\n").filter(Boolean)) {
    const [status, oldPath, renamedTo] = row.split("\t");
    if (status[0] === "A") continue; // a new file cannot lose an old rule
    const newPath = status[0] === "D" ? null : (renamedTo ?? oldPath);
    const oldText = baseOf(oldPath);
    if (oldText === null) continue;
    const newText = newPath === null ? null : headOf(newPath);
    touched.push(...findLostNormativeClauses(oldText, newText, oldPath));
    if (oldPath.startsWith(AGENTS_DIR)) {
      if (newText === null) loosened.push(`${oldPath}: agent definition deleted`);
      else loosened.push(...findChangedAgentFrontmatter(oldPath, oldText, newText));
    }
  }

  // A guarded file that existed at base and is gone at HEAD is red, never silently skipped.
  for (const file of WATCHED_FILES) {
    if (baseOf(file) !== null && headOf(file) === null) loosened.push(`${file}: deleted`);
  }
  const pair = (file: string): [string, string] | null => {
    const b = baseOf(file);
    const h = headOf(file);
    return b !== null && h !== null ? [b, h] : null;
  };
  // These files ARE the enforcement of the rules the agents obey: any edit is deliberate.
  for (const [file, why] of Object.entries(ENFORCEMENT_FILES)) {
    const p = pair(file);
    if (p && p[0] !== p[1]) loosened.push(`${file}: changed (${why})`);
  }
  // Named on top of the "changed" line, so the reviewer sees which budget moved.
  const budget = pair(BUDGET_FILE);
  if (budget) loosened.push(...findLoosenedBudgets(...budget));
  const pkg = pair(PACKAGE_FILE);
  if (pkg) loosened.push(...findUnwiredGuard(...pkg));

  const trailers = git(cwd, [
    "log",
    `--format=%(trailers:key=${TRAILER_KEY},valueonly,unfold)%x00`,
    `${base}..${head}`,
  ]);
  const reasons = parseRuleChangeReasons(trailers);
  return { touched, loosened, reasons, ok: (touched.length === 0 && loosened.length === 0) || reasons.length > 0 };
}

function main(): void {
  const base = resolveBase();
  const r = evaluateRuleGuard(REPO_ROOT, base);
  const flagged = r.touched.length + r.loosened.length;

  if (!r.ok) {
    console.error(`\n✗ rule-guard — ${flagged} rule change(s) vs ${base}, no ${TRAILER_KEY} trailer\n`);
    for (const t of r.touched) console.error(`  ${t.file}:${t.line}: lost/changed rule: ${t.text.slice(0, 200)}`);
    for (const l of r.loosened) console.error(`  ${l}`);
    console.error(
      `\nA normative clause (wajib/jangan/never/must/only/should/…) no longer occurs in its file, or\n` +
        `something that enforces the rules (agent tools/model/effort, hooks.json, the guard/merge/contract/\n` +
        `wave scripts, engine.test.ts and its budgets, this guard, its test or its gate wiring) was changed.\n` +
        `That may be exactly right — but it must be deliberate.\n` +
        `If it is, add a trailer to a commit in this branch:\n\n` +
        `    ${TRAILER_KEY}: <why this rule may change, at least ${MIN_REASON_LENGTH} characters>\n\n` +
        `Otherwise restore it. Pure additions, re-wrapping and moving a clause never trip this check.\n`,
    );
    process.exit(1);
  }
  if (flagged > 0) {
    console.info(`✓ rule-guard — ${flagged} rule change(s) vs ${base}, acknowledged:`);
    for (const reason of r.reasons) console.info(`    ${TRAILER_KEY}: ${reason}`);
    return;
  }
  console.info(`✓ rule-guard — no normative clause lost or changed vs ${base}`);
}

// Only run when invoked as a script — the test file imports this module.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
