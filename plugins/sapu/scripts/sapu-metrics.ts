// scripts/sapu-metrics.ts
// Token cost of one sapu sweep, read from the ORCHESTRATOR's Claude Code transcript.
//
// WHY THIS EXISTS. A sweep's cost is how much context every step re-sends, and it drifts
// upward silently as skills and CLAUDE.md grow. This turns one transcript into four numbers
// and, with --baseline <file>, fails when a sweep got more than 50% worse than that repo's
// baseline (the repo profile names the file: .claude/sapu/sapu.md §Context economy).
//
// The orchestrator is NOT the whole bill: in a sweep most context tokens are spent by its
// subagents, so an orchestrator-only number hides most of the cost. --with-subagents adds them: per agent type
// the agent count, steps, the average first-step context (the fixed floor every step of that
// agent pays again) and the total, plus the sweep's tokens per merged PR.
//
// WHAT IS COUNTED
//   - A step is one API response: a `type: "assistant"` line with `message.usage`.
//     Deduplicated by `message.id`, falling back to the line's `uuid`. One response with
//     several content blocks (text + tool_use + ...) is written as several lines. Each line
//     has its own uuid but repeats the SAME usage, so deduplicating by uuid alone counts one
//     response 2-3 times (roughly twice as many uuids as message ids in a real transcript). A resumed
//     session replays lines with the same uuid, and the fallback absorbs those.
//   - Context per step = input_tokens + cache_read_input_tokens + cache_creation_input_tokens.
//   - Total tokens = sum over steps of context + output_tokens.
//   - Merged PRs = with --merges-log <MAIN>/.git/sapu-merges.log, the distinct PRs sapu-merge.sh
//     recorded as merged between the transcript's first and last timestamp (the reliable count).
//     Without it, a guess from Bash tool_use blocks (`gh pr merge` or scripts/sapu-merge.sh, not
//     its --dry-run), deduplicated by tool_use id, a `for n in 1 2 3; do …merge…` loop once per
//     listed PR. That guess counts failed attempts and retries too (the transcript records the
//     call, not its outcome) and misses merges run from a script file.
//   - Cost = USD at API list prices per model (PRICES): cache reads cost a small fraction of fresh
//     input, so raw token totals overstate what a long session costs and point at the wrong
//     driver. On a subscription it is a weight for quota use, not a bill.
//   - Output tokens of a step = the largest output_tokens among its lines: a response split over
//     several lines can carry a partial count on the first one.
//
// Pass the orchestrator's own `<session>.jsonl`. With --with-subagents the script also reads
// every `agent-*.jsonl` under the `<session>/` directory beside it (Agent-tool subagents in
// `subagents/`, Workflow agents wherever the harness puts them), labelled by the `agentType`
// of the `.meta.json` next to each file ("workflow" when there is none). Only aggregates are
// printed; the orchestrator never opens those transcripts itself.
//
//   - Wall-clock = first to last transcript timestamp; waiting = the gaps over WAIT_GAP_MIN minutes
//     between consecutive lines (the orchestrator idle on agents, a gate or a person).
//   - Gate runs = with --gates-log <MAIN>/.git/sapu-gates.log, every sapu-merge.sh gate run in the
//     window: red ones, those sapu-merge.sh judged known-flake, setup failures, minutes gated.
//
// USAGE
//   node scripts/sapu-metrics.ts <transcript.jsonl> [--with-subagents] [--merges-log <file>] [--gates-log <file>] [--baseline <file>] [--json]
//   node scripts/sapu-metrics.ts --marker <run-marker> [--main <MAIN>] …   finds the transcript itself
//     (findTranscript: under $CLAUDE_CONFIG_DIR, else ~/.claude, the newest one holding the marker)
// Exit: 0 = ok, 1 = worse than baseline by more than 50%, 2 = usage error.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where Claude Code keeps the session transcripts of checkout `main`: `<config>/projects/<slug>/`,
 * `<config>` = $CLAUDE_CONFIG_DIR, else ~/.claude; `<slug>` = the absolute path with every
 * non-alphanumeric character replaced by `-` (`/srv/src/app` → `-srv-src-app`).
 */
export function projectDir(main: string, env: Record<string, string | undefined> = process.env): string {
  const config = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  return join(config, "projects", main.replace(/[^A-Za-z0-9]/g, "-"));
}

/**
 * This session's transcript: of the 20 newest in projectDir, the newest that holds `marker` (the
 * sweep's run marker, echoed at its Step 0); the newest file alone may be a parallel session's.
 * null when none holds it.
 */
export function findTranscript(main: string, marker: string, env: Record<string, string | undefined> = process.env): string | null {
  const dir = projectDir(main, env);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return null;
  }
  const newest = names
    .map((n) => join(dir, n))
    .map((p) => ({ p, t: statSync(p).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(0, 20);
  return newest.find(({ p }) => readFileSync(p, "utf8").includes(marker))?.p ?? null;
}

export const WORSE_FACTOR = 1.5;

/**
 * USD per million tokens: input, cache write 5 min / 1 h, cache read, output (Anthropic list prices,
 * 2026-09). Matched by model family; ponytail: a model outside these families is priced as Opus,
 * the dearest one, so an unknown model never makes a sweep look cheaper. Update with new families.
 */
export const PRICES: Record<string, { in: number; w5: number; w1: number; read: number; out: number }> = {
  fable: { in: 10, w5: 12.5, w1: 20, read: 0.25, out: 50 },
  opus: { in: 4, w5: 5, w1: 8, read: 0.2, out: 20 },
  sonnet: { in: 2, w5: 2.5, w1: 4, read: 0.1, out: 10 }, // Sonnet 5.5 cache reads: $0.10/MTok
  haiku: { in: 1, w5: 1.25, w1: 2, read: 0.1, out: 5 },
};

export function priceOf(model: unknown) {
  const family = typeof model === "string" ? /fable|mythos|opus|sonnet|haiku/.exec(model)?.[0] : undefined;
  return PRICES[family === "mythos" ? "fable" : (family ?? "opus")];
}

export interface SweepMetrics {
  steps: number;
  avgContext: number;
  maxContext: number;
  /** Context of the last step: the orchestrator's size NOW (sapu §Sessions and waves budget). */
  lastContext?: number;
  totalTokens: number;
  /** USD at list prices (PRICES). */
  cost: number;
  mergedPrs: number;
  /** null when no PR was merged (the ratio is undefined, not zero). */
  tokensPerPr: number | null;
  costPerPr: number | null;
  /** ISO timestamps of the first and last transcript line that has one. */
  startedAt?: string;
  endedAt?: string;
  /** Minutes from startedAt to endedAt, and the part of it spent in gaps over WAIT_GAP_MIN between lines. */
  wallMinutes?: number;
  waitMinutes?: number;
}

/** A gap between two orchestrator transcript lines longer than this is waiting (on agents, a gate, a person). */
export const WAIT_GAP_MIN = 5;

interface Usage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  output_tokens?: number;
}
interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: { command?: unknown };
}
interface TranscriptLine {
  type?: string;
  uuid?: string;
  timestamp?: string;
  message?: { id?: string; model?: string; usage?: Usage; content?: unknown };
}

/** USD of one step's context (input + cache writes + cache reads), output excluded. */
function contextCost(u: Usage, model: unknown): number {
  const p = priceOf(model);
  const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5 = (u.cache_creation_input_tokens ?? 0) - w1; // a write without the split is a 5 min write
  return ((u.input_tokens ?? 0) * p.in + w5 * p.w5 + w1 * p.w1 + (u.cache_read_input_tokens ?? 0) * p.read) / 1e6;
}

// A command position: start of the command, or right after a separator. Prefixes that
// only wrap the real program are peeled off: `VAR=x`, `env`, `nice [-n N]`, `time`,
// `cd <dir>`, `bash <script>` (but never `bash -n`, which only parses), and the shell
// keywords that open a loop/branch body (`do`, `then`, `else`, `{`) — sapu B4 merges a wave
// with `for n in …; do scripts/sapu-merge.sh $n …; done`.
const SEPARATOR = /&&|\|\||;|\||\n/;
const WRAPPER = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*|env|nice|-n\s+-?\d+|-n-?\d+|time|bash|sh|do|then|else|\{)\s+/;

function mergesAt(segment: string): boolean {
  let rest = segment.trim().replace(/^\(+\s*/, "");
  for (let prev = ""; prev !== rest;) {
    prev = rest;
    if (/^(?:bash|sh)\s+-/.test(rest)) return false; // bash -n / -x: a check, not a run
    rest = rest.replace(WRAPPER, "");
  }
  if (/^gh\s+pr\s+merge\b/.test(rest)) return !/\s(?:--help|-h)\b/.test(rest);
  if (/^(?:\S*\/)?sapu-merge\.sh(?:\s|$)/.test(rest)) {
    return !/\s(?:--dry-run|--help|-h)\b/.test(rest);
  }
  return false;
}

/**
 * A Bash command that actually runs a merge: `gh pr merge` or scripts/sapu-merge.sh in a
 * command position. A mention is not a run: `git diff scripts/sapu-merge.sh`,
 * `grep "gh pr merge"`, `bash -n scripts/sapu-merge.sh`, and a sapu-merge.sh dry run.
 */
export function isMergeCommand(command: unknown): boolean {
  return countMerges(command) > 0;
}

/**
 * How many PRs one Bash call merges: one per merging command position, except that a merge
 * inside `for <var> in <PR numbers>; do …` merges once per listed number (sapu B4 merges a
 * whole wave in one such loop, and counting it once would inflate tokens per PR N times).
 */
export function countMerges(command: unknown): number {
  if (typeof command !== "string") return 0;
  const merging = command.split(SEPARATOR).filter(mergesAt).length;
  if (merging === 0) return 0;
  const loop = /\bfor\s+[A-Za-z_][A-Za-z0-9_]*\s+in\s+([\d\s]+?)\s*;\s*do\b/.exec(command);
  return loop ? loop[1].trim().split(/\s+/).length * merging : merging;
}

export function computeMetrics(jsonl: string): SweepMetrics {
  /** Output tokens counted so far per step, so a later line with a larger count adds the rest. */
  const seenSteps = new Map<string, number>();
  const seenTools = new Set<string>();
  let steps = 0;
  let sumContext = 0;
  let maxContext = 0;
  let lastContext = 0;
  let totalTokens = 0;
  let cost = 0;
  let mergedPrs = 0;
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  let waitMs = 0;

  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw) as TranscriptLine;
    } catch {
      continue; // a truncated last line of a live transcript
    }
    // Timestamps can step back (replayed or interleaved lines): the window is min..max, and a gap
    // counts only past the latest time seen so far, so waiting never exceeds wall-clock.
    if (typeof line.timestamp === "string") {
      const gap = endedAt ? Date.parse(line.timestamp) - Date.parse(endedAt) : 0;
      if (gap > WAIT_GAP_MIN * 60_000) waitMs += gap;
      if (!startedAt || line.timestamp < startedAt) startedAt = line.timestamp;
      if (!endedAt || line.timestamp > endedAt) endedAt = line.timestamp;
    }
    if (line.type !== "assistant" || !line.message) continue;

    const content = Array.isArray(line.message.content)
      ? (line.message.content as ContentBlock[])
      : [];
    for (const block of content) {
      if (block.type !== "tool_use" || block.name !== "Bash") continue;
      const key = block.id ?? `${line.uuid}:${content.indexOf(block)}`;
      if (seenTools.has(key)) continue;
      seenTools.add(key);
      mergedPrs += countMerges(block.input?.command);
    }

    const usage = line.message.usage;
    if (!usage) continue;
    const key = line.message.id ?? line.uuid;
    if (!key) continue;
    const output = usage.output_tokens ?? 0;
    const counted = seenSteps.get(key);
    if (counted !== undefined) {
      if (output > counted) {
        totalTokens += output - counted;
        cost += ((output - counted) * priceOf(line.message.model).out) / 1e6;
        seenSteps.set(key, output);
      }
      continue;
    }
    seenSteps.set(key, output);
    const context =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
    steps++;
    sumContext += context;
    maxContext = Math.max(maxContext, context);
    lastContext = context;
    totalTokens += context + output;
    cost += contextCost(usage, line.message.model) + (output * priceOf(line.message.model).out) / 1e6;
  }

  return {
    steps,
    avgContext: steps > 0 ? Math.round(sumContext / steps) : 0,
    maxContext,
    lastContext,
    totalTokens,
    cost,
    mergedPrs,
    tokensPerPr: mergedPrs > 0 ? Math.round(totalTokens / mergedPrs) : null,
    costPerPr: mergedPrs > 0 ? cost / mergedPrs : null,
    startedAt,
    endedAt,
    wallMinutes: startedAt && endedAt ? Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 60_000) : 0,
    waitMinutes: Math.round(waitMs / 60_000),
  };
}

/**
 * Distinct PRs in a sapu-merge.sh merges log (`<ISO time> <PR> <SHA>` per line) merged within
 * [from, to]. Timestamps are UTC ISO strings, so they compare as strings.
 */
export function mergesInWindow(log: string, from: string | undefined, to: string | undefined): number {
  const prs = new Set<string>();
  for (const l of log.split("\n")) {
    const m = /^(\S+) (\d+) /.exec(l);
    if (m && (!from || m[1] >= from) && (!to || m[1] <= to)) prs.add(m[2]);
  }
  return prs.size;
}

export interface GateRuns {
  runs: number;
  red: number;
  /** Red runs whose every failing test had also failed another PR's gate (sapu-merge.sh's verdict). */
  knownFlake: number;
  setupFailed: number;
  /** Minutes spent in gates, one decimal. */
  minutes: number;
}

/**
 * Gate runs in a sapu-merge.sh gates log (`<ISO time> <PR> <SHA> <green|red|setup-failed> gate=<s>s
 * failed=<files|-> tree=<t> [verdict=<v>] [steps=<steps>]` per line) within [from, to].
 */
export function gatesInWindow(log: string, from: string | undefined, to: string | undefined): GateRuns {
  const g: GateRuns = { runs: 0, red: 0, knownFlake: 0, setupFailed: 0, minutes: 0 };
  let secs = 0;
  for (const l of log.split("\n")) {
    const m = /^(\S+) \d+ \S+ (green|red|setup-failed) gate=(\d+)s(?: .*?verdict=(\S+))?/.exec(l);
    if (!m || (from && m[1] < from) || (to && m[1] > to)) continue;
    g.runs++;
    secs += Number(m[3]);
    if (m[2] === "red") g.red++;
    if (m[2] === "setup-failed") g.setupFailed++;
    if (m[4] === "known-flake") g.knownFlake++;
  }
  g.minutes = Math.round(secs / 6) / 10;
  return g;
}

/** Re-bases a metrics object on a merged-PR count from elsewhere (the merges log). */
export function withMerges(m: SweepMetrics, mergedPrs: number): SweepMetrics {
  return {
    ...m,
    mergedPrs,
    tokensPerPr: mergedPrs > 0 ? Math.round(m.totalTokens / mergedPrs) : null,
    costPerPr: mergedPrs > 0 ? m.cost / mergedPrs : null,
  };
}

export interface AgentTypeUsage {
  agentType: string;
  agents: number;
  steps: number;
  /** Mean context of each agent's FIRST step: the floor every later step pays again. */
  avgFirstContext: number;
  totalTokens: number;
  cost: number;
}

function firstContext(jsonl: string): number {
  for (const raw of jsonl.split("\n")) {
    if (!raw.includes('"usage"')) continue;
    try {
      const u = (JSON.parse(raw) as TranscriptLine).message?.usage;
      if (u) return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    } catch {
      continue;
    }
  }
  return 0;
}

/** Aggregates subagent transcripts by agent type, most expensive type first. */
export function computeSubagentUsage(
  transcripts: readonly { agentType: string; jsonl: string }[],
): AgentTypeUsage[] {
  const by = new Map<string, { agents: number; steps: number; first: number; total: number; cost: number }>();
  for (const t of transcripts) {
    const m = computeMetrics(t.jsonl);
    if (m.steps === 0) continue;
    const a = by.get(t.agentType) ?? { agents: 0, steps: 0, first: 0, total: 0, cost: 0 };
    a.agents++;
    a.steps += m.steps;
    a.first += firstContext(t.jsonl);
    a.total += m.totalTokens;
    a.cost += m.cost;
    by.set(t.agentType, a);
  }
  return [...by.entries()]
    .map(([agentType, a]) => ({
      agentType,
      agents: a.agents,
      steps: a.steps,
      avgFirstContext: Math.round(a.first / a.agents),
      totalTokens: a.total,
      cost: a.cost,
    }))
    .sort((x, y) => y.cost - x.cost);
}

function readSubagentTranscripts(sessionFile: string): { agentType: string; jsonl: string }[] {
  const dir = join(dirname(sessionFile), basename(sessionFile, ".jsonl"));
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => /(^|[\\/])agent-[^\\/]*\.jsonl$/.test(f))
    .map((f) => {
      const meta = join(dir, f.replace(/\.jsonl$/, ".meta.json"));
      let agentType = "workflow";
      try {
        agentType = (JSON.parse(readFileSync(meta, "utf8")) as { agentType?: string }).agentType ?? agentType;
      } catch {
        // no meta file: a Workflow agent
      }
      return { agentType, jsonl: readFileSync(join(dir, f), "utf8") };
    });
}

export interface MetricsBaseline {
  avgContext: number;
  tokensPerPr: number;
  /** Orchestrator + subagents per merged PR (--with-subagents). */
  sweepTokensPerPr?: number;
  /** USD, orchestrator + subagents per merged PR (--with-subagents): the figure to watch. */
  sweepCostPerPr?: number;
}

/**
 * Messages for every metric more than WORSE_FACTOR times its baseline. Empty = fine.
 * `sweepTokensPerPr` (orchestrator + subagents) is compared only when both sides have it.
 */
export function compareToBaseline(
  m: SweepMetrics,
  b: MetricsBaseline,
  sweepTokensPerPr: number | null = null,
  sweepCostPerPr: number | null = null,
): string[] {
  const out: string[] = [];
  if (sweepCostPerPr !== null && b.sweepCostPerPr && sweepCostPerPr > b.sweepCostPerPr * WORSE_FACTOR) {
    out.push(
      `sweep cost per merged PR (with subagents) $${sweepCostPerPr.toFixed(2)} is more than ` +
        `${WORSE_FACTOR}x the baseline $${b.sweepCostPerPr.toFixed(2)}`,
    );
  }
  if (sweepTokensPerPr !== null && b.sweepTokensPerPr && sweepTokensPerPr > b.sweepTokensPerPr * WORSE_FACTOR) {
    out.push(
      `sweep tokens per merged PR (with subagents) ${fmt(sweepTokensPerPr)} is more than ` +
        `${WORSE_FACTOR}x the baseline ${fmt(b.sweepTokensPerPr)}`,
    );
  }
  if (m.avgContext > b.avgContext * WORSE_FACTOR) {
    out.push(
      `average context per step ${fmt(m.avgContext)} is more than ${WORSE_FACTOR}x the ` +
        `baseline ${fmt(b.avgContext)}`,
    );
  }
  if (m.tokensPerPr !== null && m.tokensPerPr > b.tokensPerPr * WORSE_FACTOR) {
    out.push(
      `tokens per merged PR ${fmt(m.tokensPerPr)} is more than ${WORSE_FACTOR}x the ` +
        `baseline ${fmt(b.tokensPerPr)}`,
    );
  }
  return out;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function main(argv: readonly string[]): number {
  const valueOf = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const flagValues = new Set(["--baseline", "--merges-log", "--gates-log", "--marker", "--main"].map((f) => argv.indexOf(f) + 1).filter((i) => i > 0));
  let path = argv.find((a, i) => !a.startsWith("--") && !flagValues.has(i));
  const marker = valueOf("--marker");
  if (!path && marker) {
    const main = valueOf("--main") || process.cwd();
    path = findTranscript(main, marker) ?? undefined;
    if (!path) {
      console.error(`sapu-metrics: no transcript under ${projectDir(main)} holds ${marker} (CLAUDE_CONFIG_DIR, else ~/.claude, is where Claude Code keeps them)`);
      return 2;
    }
  }
  if (!path) {
    console.error("usage: sapu-metrics.ts <transcript.jsonl> | --marker <run-marker> [--main <MAIN>]  [--with-subagents] [--merges-log <file>] [--gates-log <file>] [--baseline <file>] [--json]");
    return 2;
  }
  if (/[\\/]subagents[\\/]/.test(path)) {
    console.error("sapu-metrics: pass the orchestrator transcript, not a subagent transcript");
    return 2;
  }
  for (const flag of ["--baseline", "--merges-log", "--gates-log"]) {
    const v = valueOf(flag);
    if (argv.includes(flag) && (!v || v.startsWith("--"))) {
      console.error(`sapu-metrics: ${flag} needs a file`);
      return 2;
    }
  }
  let m = computeMetrics(readFileSync(path, "utf8"));
  const mergesLog = valueOf("--merges-log");
  // A missing log = no merge recorded yet (sapu-merge.sh creates it on the first merge).
  if (mergesLog) m = withMerges(m, mergesInWindow(existsSync(mergesLog) ? readFileSync(mergesLog, "utf8") : "", m.startedAt, m.endedAt));
  const gatesLog = valueOf("--gates-log");
  const gates = gatesLog ? gatesInWindow(existsSync(gatesLog) ? readFileSync(gatesLog, "utf8") : "", m.startedAt, m.endedAt) : null;
  const withSubagents = argv.includes("--with-subagents");
  const agents = withSubagents ? computeSubagentUsage(readSubagentTranscripts(path)) : [];
  const sweepTotal = m.totalTokens + agents.reduce((s, a) => s + a.totalTokens, 0);
  const sweepCost = m.cost + agents.reduce((s, a) => s + a.cost, 0);
  const sweepTokensPerPr = withSubagents && m.mergedPrs > 0 ? Math.round(sweepTotal / m.mergedPrs) : null;
  const sweepCostPerPr = withSubagents && m.mergedPrs > 0 ? sweepCost / m.mergedPrs : null;
  if (argv.includes("--json")) {
    console.info(JSON.stringify({ ...m, ...(gates ? { gates } : {}), ...(withSubagents ? { agents, sweepTotal, sweepTokensPerPr, sweepCost, sweepCostPerPr } : {}) }));
  } else {
    const perPr = (v: number | null, f: (n: number) => string) => (v === null ? "n/a (no merge)" : f(v));
    console.info(`steps:              ${m.steps}`);
    console.info(`avg context/step:   ${fmt(m.avgContext)}`);
    console.info(`max context/step:   ${fmt(m.maxContext)}`);
    console.info(`last step context:  ${fmt(m.lastContext ?? 0)}`);
    console.info(`total tokens:       ${fmt(m.totalTokens)}`);
    console.info(`cost:               ${usd(m.cost)}`);
    console.info(`merged PRs:         ${m.mergedPrs}${mergesLog ? "" : " (guessed from merge commands: pass --merges-log for the real count)"}`);
    console.info(`tokens per PR:      ${perPr(m.tokensPerPr, fmt)}`);
    console.info(`cost per PR:        ${perPr(m.costPerPr, usd)}`);
    console.info(`wall-clock:         ${m.wallMinutes} min (waiting in gaps over ${WAIT_GAP_MIN} min: ${m.waitMinutes} min), ${perPr(m.mergedPrs > 0 ? (m.wallMinutes ?? 0) / m.mergedPrs : null, (n) => `${Math.round(n)} min`)} per PR`);
    if (gates) console.info(`gate runs:          ${gates.runs} (${gates.red} red, ${gates.knownFlake} of them known-flake; ${gates.setupFailed} setup-failed), ${gates.minutes} min in gates`);
    if (withSubagents) {
      console.info("subagents (type | agents | steps | avg first-step context | total | cost):");
      for (const a of agents) {
        console.info(`  ${a.agentType} | ${a.agents} | ${a.steps} | ${fmt(a.avgFirstContext)} | ${fmt(a.totalTokens)} | ${usd(a.cost)}`);
      }
      console.info(`sweep total:        ${fmt(sweepTotal)}, ${usd(sweepCost)} (orchestrator ${Math.round((100 * m.cost) / Math.max(sweepCost, 1e-9))}% of cost)`);
      console.info(`sweep tokens/PR:    ${perPr(sweepTokensPerPr, fmt)}`);
      console.info(`sweep cost/PR:      ${perPr(sweepCostPerPr, usd)}`);
    }
  }
  const baselinePath = valueOf("--baseline");
  if (!baselinePath) return 0;
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as MetricsBaseline;
  const worse = compareToBaseline(m, baseline, sweepTokensPerPr, sweepCostPerPr);
  for (const w of worse) console.error(`sapu-metrics: WORSE THAN BASELINE: ${w}`);
  if (worse.length === 0) console.error("sapu-metrics: within baseline");
  return worse.length > 0 ? 1 : 0;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
