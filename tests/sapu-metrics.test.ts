// tests/sapu-metrics.test.ts — transcript arithmetic of plugins/sapu/scripts/sapu-metrics.ts.
import { describe, expect, it } from "vitest";
import {
  compareToBaseline,
  computeMetrics,
  computeSubagentUsage,
  countMerges,
  isMergeCommand,
  mergesInWindow,
  withMerges,
} from "../plugins/sapu/scripts/sapu-metrics.ts";

const usage = (input: number, read: number, create: number, output: number) => ({
  input_tokens: input,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: create,
  output_tokens: output,
});

function line(o: unknown): string {
  return JSON.stringify(o);
}

describe("computeMetrics", () => {
  it("counts one step per API response even when it spans several lines", () => {
    // One response (msg_1) written as two lines with different uuids and the same usage,
    // plus a resumed-session replay of the second line (same uuid).
    const replay = line({
      type: "assistant",
      uuid: "u2",
      message: {
        id: "msg_1",
        usage: usage(10, 90_000, 0, 500),
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: { command: "gh pr merge 12 --squash" },
          },
        ],
      },
    });
    const jsonl = [
      line({ type: "user", uuid: "u0", message: { content: "go" } }),
      line({
        type: "assistant",
        uuid: "u1",
        message: {
          id: "msg_1",
          usage: usage(10, 90_000, 0, 500),
          content: [{ type: "text", text: "merging" }],
        },
      }),
      replay,
      replay,
      line({
        type: "assistant",
        uuid: "u3",
        message: { id: "msg_2", usage: usage(0, 100_000, 10_000, 1_000), content: [] },
      }),
      "{truncated",
    ].join("\n");

    const m = computeMetrics(jsonl);
    expect(m.steps).toBe(2);
    expect(m.maxContext).toBe(110_000);
    expect(m.avgContext).toBe(100_005);
    expect(m.totalTokens).toBe(90_010 + 500 + 110_000 + 1_000);
    expect(m.mergedPrs).toBe(1);
    expect(m.tokensPerPr).toBe(m.totalTokens);
  });

  it("prices each step by its model and token kind: cache reads are cheap, writes and output are not", () => {
    const step = (id: string, model: string, u: object) => line({ type: "assistant", uuid: id, message: { id, model, usage: u, content: [] } });
    const m = computeMetrics(
      [
        // Opus: 1M cache read ($0.20) + 1M output ($20)
        step("a", "claude-opus-5-5", usage(0, 1_000_000, 0, 1_000_000)),
        // Sonnet: 1M input ($2) + 1M cache write, 400k of it 1 h ($1.50 + $1.60)
        step("b", "claude-sonnet-5-5", { ...usage(1_000_000, 0, 1_000_000, 0), cache_creation: { ephemeral_5m_input_tokens: 600_000, ephemeral_1h_input_tokens: 400_000 } }),
      ].join("\n"),
    );
    expect(m.cost).toBeCloseTo(0.2 + 20 + 2 + 1.5 + 1.6, 6);
  });

  it("takes a step's final output count when its lines carry a partial one first", () => {
    const part = (out: number, uuid: string) => line({ type: "assistant", uuid, message: { id: "m1", model: "claude-sonnet-5-5", usage: usage(0, 1_000, 0, out), content: [] } });
    const m = computeMetrics([part(10, "u1"), part(900, "u2"), part(900, "u3")].join("\n"));
    expect(m.steps).toBe(1);
    expect(m.totalTokens).toBe(1_000 + 900);
    expect(m.cost).toBeCloseTo((1_000 * 0.2 + 900 * 10) / 1e6, 9);
  });

  it("reports tokens per PR as undefined, not zero, when nothing merged", () => {
    const m = computeMetrics(
      line({ type: "assistant", uuid: "u", message: { id: "m", usage: usage(1, 0, 0, 1) } }),
    );
    expect(m.mergedPrs).toBe(0);
    expect(m.tokensPerPr).toBeNull();
  });
});

describe("merges log", () => {
  const log = ["2026-10-01T01:00:00Z 3081 aaa", "2026-10-01T02:00:00Z 3088 bbb", "2026-10-01T02:30:00Z 3088 ccc", "2026-10-01T09:00:00Z 3099 ddd", "garbage"].join("\n");

  it("counts distinct PRs merged inside the session's window", () => {
    expect(mergesInWindow(log, "2026-10-01T00:30:00Z", "2026-10-01T03:00:00Z")).toBe(2);
    expect(mergesInWindow(log, undefined, undefined)).toBe(3);
    expect(mergesInWindow("", "a", "z")).toBe(0);
  });

  it("re-bases the per-PR figures on that count", () => {
    const m = withMerges({ steps: 1, avgContext: 1, maxContext: 1, totalTokens: 900, cost: 9, mergedPrs: 12, tokensPerPr: 75, costPerPr: 0.75 }, 3);
    expect([m.mergedPrs, m.tokensPerPr, m.costPerPr]).toEqual([3, 300, 3]);
    expect(withMerges(m, 0).costPerPr).toBeNull();
  });
});

describe("isMergeCommand", () => {
  it("counts a real gh pr merge / sapu-merge.sh run in a command position", () => {
    for (const cmd of [
      "gh pr merge 3045 --squash --delete-branch",
      "./scripts/sapu-merge.sh 3045 /tmp/review.md --workers 4",
      "cd /repo && scripts/sapu-merge.sh 3045 r.md",
      "git fetch; gh pr merge 1 --squash",
      "nice -n 15 env TEST_DB_WORKERS=4 ./scripts/sapu-merge.sh 12 r.md",
      "GH_TOKEN=x gh pr merge 7",
      "bash scripts/sapu-merge.sh 9 r.md",
    ]) {
      expect(isMergeCommand(cmd), cmd).toBe(true);
    }
  });

  it("counts a merge inside a loop or branch body (sapu B4 merges a wave in one for-loop)", () => {
    expect(isMergeCommand('for n in 101 102; do scripts/sapu-merge.sh $n "$TMPDIR/r$n.md" --workers 8; echo "EXIT $n $?"; done')).toBe(true);
    expect(isMergeCommand("if true; then gh pr merge 5 --squash; fi")).toBe(true);
    expect(isMergeCommand("for n in 1 2; do scripts/sapu-merge.sh $n f --dry-run; done")).toBe(false);
  });

  it("counts one merge per listed PR in a loop, one per command otherwise", () => {
    expect(countMerges('for n in 101 102 103 104; do scripts/sapu-merge.sh $n "$TMPDIR/r$n.md" --workers 8; echo "EXIT $n $?"; done')).toBe(4);
    expect(countMerges("gh pr merge 1 --squash; gh pr merge 2 --squash")).toBe(2);
    expect(countMerges("scripts/sapu-merge.sh 7 f")).toBe(1);
    expect(countMerges("for n in 1 2; do scripts/sapu-merge.sh $n f --dry-run; done")).toBe(0);
    expect(countMerges(undefined)).toBe(0);
  });

  it("does not count a mention, a syntax check, a dry run, or help", () => {
    for (const cmd of [
      "git diff scripts/sapu-merge.sh",
      'grep -n "gh pr merge" scripts/sapu-merge.sh',
      "bash -n scripts/sapu-merge.sh",
      "./scripts/sapu-merge.sh 3045 /tmp/review.md --dry-run",
      "gh pr merge --help",
      "gh pr view 3045",
      "echo gh pr merge 1",
    ]) {
      expect(isMergeCommand(cmd), cmd).toBe(false);
    }
    expect(isMergeCommand(undefined)).toBe(false);
  });
});

describe("compareToBaseline", () => {
  const b = { avgContext: 270_000, tokensPerPr: 5_500_000 };

  it("passes up to 1.5x the baseline", () => {
    expect(
      compareToBaseline(
        {
          steps: 1,
          avgContext: 405_000,
          maxContext: 0,
          totalTokens: 0,
          mergedPrs: 1,
          tokensPerPr: 8_250_000,
        },
        b,
      ),
    ).toEqual([]);
  });

  it("fails each metric more than 50% worse, and skips tokens/PR with no merge", () => {
    const worse = compareToBaseline(
      {
        steps: 1,
        avgContext: 405_001,
        maxContext: 0,
        totalTokens: 0,
        mergedPrs: 1,
        tokensPerPr: 8_250_001,
      },
      b,
    );
    expect(worse).toHaveLength(2);
    expect(
      compareToBaseline(
        { steps: 1, avgContext: 1, maxContext: 0, totalTokens: 0, mergedPrs: 0, tokensPerPr: null },
        b,
      ),
    ).toEqual([]);
  });

  it("compares sweep cost per PR only when both the run and the baseline have it", () => {
    const m = { steps: 1, avgContext: 1, maxContext: 0, totalTokens: 0, cost: 0, mergedPrs: 1, tokensPerPr: 1, costPerPr: 0 };
    const withCost = { ...b, sweepCostPerPr: 8 };
    expect(compareToBaseline(m, withCost, null, 12)).toEqual([]);
    expect(compareToBaseline(m, withCost, null, 12.01)[0]).toMatch(/sweep cost per merged PR .* \$12\.01 .* \$8\.00/);
    expect(compareToBaseline(m, b, null, 99)).toEqual([]);
  });

  it("compares sweep tokens per PR only when both the run and the baseline have it", () => {
    const m = { steps: 1, avgContext: 1, maxContext: 0, totalTokens: 0, mergedPrs: 1, tokensPerPr: 1 };
    const withSweep = { ...b, sweepTokensPerPr: 20_000_000 };
    expect(compareToBaseline(m, withSweep, 30_000_000)).toEqual([]);
    expect(compareToBaseline(m, withSweep, 30_000_001)).toHaveLength(1);
    expect(compareToBaseline(m, b, 99_000_000)).toEqual([]);
    expect(compareToBaseline(m, withSweep, null)).toEqual([]);
  });
});

describe("computeSubagentUsage", () => {
  const step = (id: string, context: number) =>
    line({ type: "assistant", uuid: id, message: { id, usage: usage(0, context, 0, 10), content: [] } });

  it("groups by agent type, averages the first-step floor, and sorts by total", () => {
    const usageByType = computeSubagentUsage([
      { agentType: "sapu-sonnet-high", jsonl: [step("a1", 100_000), step("a2", 110_000)].join("\n") },
      { agentType: "sapu-sonnet-high", jsonl: [step("b1", 80_000), step("b1", 80_000)].join("\n") },
      { agentType: "workflow", jsonl: step("c1", 500_000) },
      { agentType: "empty", jsonl: "" },
    ]);
    expect(usageByType).toEqual([
      { agentType: "workflow", agents: 1, steps: 1, avgFirstContext: 500_000, totalTokens: 500_010, cost: expect.closeTo(0.1002, 6) },
      { agentType: "sapu-sonnet-high", agents: 2, steps: 3, avgFirstContext: 90_000, totalTokens: 290_030, cost: expect.closeTo(0.0586, 6) },
    ]);
  });
});
