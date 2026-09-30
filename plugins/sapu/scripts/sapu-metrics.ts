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
//   - Merged PRs = merges run by Bash tool_use blocks (`gh pr merge` or scripts/sapu-merge.sh,
//     not its --dry-run), deduplicated by tool_use id; a `for n in 1 2 3; do …merge…` loop
//     counts once per listed PR. An attempt that failed still counts: the transcript records
//     the call, not its outcome.
//
// Pass the orchestrator's own `<session>.jsonl`. With --with-subagents the script also reads
// every `agent-*.jsonl` under the `<session>/` directory beside it (Agent-tool subagents in
// `subagents/`, Workflow agents wherever the harness puts them), labelled by the `agentType`
// of the `.meta.json` next to each file ("workflow" when there is none). Only aggregates are
// printed; the orchestrator never opens those transcripts itself.
//
// USAGE
//   node scripts/sapu-metrics.ts <transcript.jsonl> [--with-subagents] [--baseline <file>] [--json]
// Exit: 0 = ok, 1 = worse than baseline by more than 50%, 2 = usage error.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WORSE_FACTOR = 1.5;

export interface SweepMetrics {
  steps: number;
  avgContext: number;
  maxContext: number;
  /** Context of the last step: the orchestrator's size NOW (sapu §Sessions and waves budget). */
  lastContext?: number;
  totalTokens: number;
  mergedPrs: number;
  /** null when no PR was merged (the ratio is undefined, not zero). */
  tokensPerPr: number | null;
}

interface Usage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
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
  message?: { id?: string; usage?: Usage; content?: unknown };
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
  const seenSteps = new Set<string>();
  const seenTools = new Set<string>();
  let steps = 0;
  let sumContext = 0;
  let maxContext = 0;
  let lastContext = 0;
  let totalTokens = 0;
  let mergedPrs = 0;

  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw) as TranscriptLine;
    } catch {
      continue; // a truncated last line of a live transcript
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
    if (!key || seenSteps.has(key)) continue;
    seenSteps.add(key);
    const context =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
    steps++;
    sumContext += context;
    maxContext = Math.max(maxContext, context);
    lastContext = context;
    totalTokens += context + (usage.output_tokens ?? 0);
  }

  return {
    steps,
    avgContext: steps > 0 ? Math.round(sumContext / steps) : 0,
    maxContext,
    lastContext,
    totalTokens,
    mergedPrs,
    tokensPerPr: mergedPrs > 0 ? Math.round(totalTokens / mergedPrs) : null,
  };
}

export interface AgentTypeUsage {
  agentType: string;
  agents: number;
  steps: number;
  /** Mean context of each agent's FIRST step: the floor every later step pays again. */
  avgFirstContext: number;
  totalTokens: number;
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
  const by = new Map<string, { agents: number; steps: number; first: number; total: number }>();
  for (const t of transcripts) {
    const m = computeMetrics(t.jsonl);
    if (m.steps === 0) continue;
    const a = by.get(t.agentType) ?? { agents: 0, steps: 0, first: 0, total: 0 };
    a.agents++;
    a.steps += m.steps;
    a.first += firstContext(t.jsonl);
    a.total += m.totalTokens;
    by.set(t.agentType, a);
  }
  return [...by.entries()]
    .map(([agentType, a]) => ({
      agentType,
      agents: a.agents,
      steps: a.steps,
      avgFirstContext: Math.round(a.first / a.agents),
      totalTokens: a.total,
    }))
    .sort((x, y) => y.totalTokens - x.totalTokens);
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
}

/**
 * Messages for every metric more than WORSE_FACTOR times its baseline. Empty = fine.
 * `sweepTokensPerPr` (orchestrator + subagents) is compared only when both sides have it.
 */
export function compareToBaseline(
  m: SweepMetrics,
  b: MetricsBaseline,
  sweepTokensPerPr: number | null = null,
): string[] {
  const out: string[] = [];
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
  const bi = argv.indexOf("--baseline");
  const baselinePath = bi >= 0 ? argv[bi + 1] : undefined;
  const path = argv.find((a, i) => !a.startsWith("--") && !(bi >= 0 && i === bi + 1));
  if (!path) {
    console.error("usage: sapu-metrics.ts <transcript.jsonl> [--with-subagents] [--baseline <file>] [--json]");
    return 2;
  }
  if (/[\\/]subagents[\\/]/.test(path)) {
    console.error("sapu-metrics: pass the orchestrator transcript, not a subagent transcript");
    return 2;
  }
  const m = computeMetrics(readFileSync(path, "utf8"));
  const withSubagents = argv.includes("--with-subagents");
  const agents = withSubagents ? computeSubagentUsage(readSubagentTranscripts(path)) : [];
  const sweepTotal = m.totalTokens + agents.reduce((s, a) => s + a.totalTokens, 0);
  const sweepTokensPerPr = withSubagents && m.mergedPrs > 0 ? Math.round(sweepTotal / m.mergedPrs) : null;
  if (argv.includes("--json")) {
    console.info(JSON.stringify(withSubagents ? { ...m, agents, sweepTotal, sweepTokensPerPr } : m));
  } else {
    console.info(`steps:              ${m.steps}`);
    console.info(`avg context/step:   ${fmt(m.avgContext)}`);
    console.info(`max context/step:   ${fmt(m.maxContext)}`);
    console.info(`last step context:  ${fmt(m.lastContext ?? 0)}`);
    console.info(`total tokens:       ${fmt(m.totalTokens)}`);
    console.info(`merged PRs:         ${m.mergedPrs}`);
    console.info(
      `tokens per PR:      ${m.tokensPerPr === null ? "n/a (no merge)" : fmt(m.tokensPerPr)}`,
    );
    if (withSubagents) {
      console.info("subagents (type | agents | steps | avg first-step context | total):");
      for (const a of agents) {
        console.info(`  ${a.agentType} | ${a.agents} | ${a.steps} | ${fmt(a.avgFirstContext)} | ${fmt(a.totalTokens)}`);
      }
      console.info(`sweep total:        ${fmt(sweepTotal)} (orchestrator ${Math.round((100 * m.totalTokens) / Math.max(sweepTotal, 1))}%)`);
      console.info(`sweep tokens/PR:    ${sweepTokensPerPr === null ? "n/a (no merge)" : fmt(sweepTokensPerPr)}`);
    }
  }
  if (bi < 0) return 0;
  if (!baselinePath || baselinePath.startsWith("--")) {
    console.error("sapu-metrics: --baseline needs the repo's baseline file");
    return 2;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as MetricsBaseline;
  const worse = compareToBaseline(m, baseline, sweepTokensPerPr);
  for (const w of worse) console.error(`sapu-metrics: WORSE THAN BASELINE: ${w}`);
  if (worse.length === 0) console.error("sapu-metrics: within baseline");
  return worse.length > 0 ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
