// tests/helpers/argus-live-repro.ts — what the repro runner's Chrome tests share (tests/argus-live-repro.test.ts,
// tests/argus-live-oracles.test.ts): the accounts a repro names, the words a run prints, a repro cycle with its
// candidates submitted, and the oracles' repros with the defects that break them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appCycle, candidate } from "./argus-live";

type Obj = Record<string, any>;

/** Every account a repro here names: clerk.1 is clerk2 (no TOTP), clerk.2 clerk1 (a TOTP code each sign-in). */
const ACCOUNTS = "buyer.1=buyer1@example.test,buyer.2=buyer2@example.test,clerk.1=clerk2@example.test,clerk.2=clerk1@example.test,anon.1";
/** The words a run prints outside its fence (decision 8). */
export const VOCABULARY = /^(fresh: instance [0-9a-f]+|step \d+ (system|[a-z][a-z0-9_-]*\.\d+) [a-z-]+: (ok|held|failed|changed-state)|truncated \d+ characters)$/;
export const REPRODUCED = /^REPRODUCED step=\d+ expected=[a-z-]+(:\d+)? observed=[a-z-]+(:\d+)?$/;

/** A repro cycle (appCycle with `repro`, its fixture processes marked `mark`) up, and its candidates' refs for `repros`, all in slot 1. */
export const reproCycleFor = (mark: string) => async (repros: Obj[][]) => {
  const c = appCycle({ mark, repro: true });
  const { summary } = c.up();
  const refs = await candidate(c.main, { slot: 1, accounts: ACCOUNTS, repros });
  /** `repro <ref> --once` through the CLI → its exit, its lines outside the fence, the fence, its last line. */
  const repro = (ref: string) => {
    const r = c.cli("repro", ref, "--once");
    const all = r.out.trimEnd().split("\n");
    const open = all.findIndex((l) => /^<<<PAGE-[0-9a-f]{32}$/.test(l));
    const close = open < 0 ? -1 : all.findIndex((l, i) => i > open && l === `${all[open].slice(3)}>>>`);
    const fenceText = open < 0 ? null : all.slice(open + 1, close).join("\n");
    const outside = open < 0 ? all : [...all.slice(0, open), ...all.slice(close + 1)];
    return { code: r.code, err: r.err, lines: outside.slice(0, -1), last: outside.at(-1), fence: fenceText };
  };
  const record = (ref: string, i = 1) => JSON.parse(readFileSync(join(c.main, ".argus/live", summary.runId, "repro", ref, `run-${i}.json`), "utf8"));
  return { c, runId: summary.runId as string, refs, repro, record, rDir: join(c.main, ".argus/live", summary.runId, "r") };
};
/** buyer.1 places an order of `quantity` and saves its number as `order`. */
export const PLACE = (quantity = "1"): Obj[] => [
  { as: "buyer.1", do: "goto", path: "/orders/new" },
  { as: "buyer.1", do: "fill", target: { label: "Quantity" }, value: quantity },
  { as: "buyer.1", do: "click", target: { role: "button", name: "Place order" } },
  { as: "buyer.1", do: "read", target: { testId: "order-number" }, save: "order" },
  { as: "buyer.1", expect: "visible", target: { testId: "order-number" } },
];
const CANCEL: Obj[] = [
  { as: "buyer.1", do: "click", target: { role: "button", name: "Cancel order" } },
  { as: "buyer.1", expect: "hidden", target: { role: "button", name: "Cancel order" } },
];
export const WELCOME = { as: "buyer.1", expect: "visible", target: { role: "heading", name: "Welcome" }, final: "discoverability" };

/** Each oracle's repro, written from §10's templates, and the defect that breaks it. */
export const ORACLE_REPROS: [string, Obj[]][] = [
  ["missing-handoff", [...PLACE(), { as: "clerk.1", do: "goto", path: "/inbox" }, { as: "clerk.1", expect: "visible", target: { text: "{{order}}" }, final: "handoff" }]],
  ["dead-end", [...PLACE(), { as: "clerk.1", do: "goto", path: "/orders/{{order}}" }, { as: "clerk.1", do: "click", target: { role: "button", name: "Approve" } }, { as: "clerk.1", expect: "visible", target: { role: "button", name: "Ship" } }, { as: "clerk.1", expect: "enabled", target: { role: "button", name: "Ship" }, final: "dead-end" }]],
  ["double-release", [{ as: "buyer.1", do: "goto", path: "/stock" }, { as: "buyer.1", do: "read", target: { testId: "stock" }, save: "before" }, ...PLACE("2"), ...CANCEL, { as: "buyer.1", expect: "fact-equals", marker: "{{order}}", field: "stock", value: "{{before}}", final: "reversal" }]],
  [
    "claim-race",
    [
      ...PLACE(),
      { as: "clerk.1", do: "goto", path: "/inbox" },
      { as: "clerk.2", do: "goto", path: "/inbox" },
      { parallel: [{ as: "clerk.1", do: "click", target: { role: "button", name: "Claim" } }, { as: "clerk.2", do: "click", target: { role: "button", name: "Claim" } }] },
      { as: "clerk.1", expect: "visible", target: { testId: "claim", nth: 0 } },
      { as: "clerk.2", expect: "visible", target: { testId: "claim", nth: 0 } },
      { as: "clerk.1", do: "reload" },
      { as: "clerk.1", expect: "count", target: { testId: "claim" }, value: 1, final: "claim-race" },
    ],
  ],
  [
    "stale-view",
    [
      ...PLACE(),
      { as: "clerk.1", do: "goto", path: "/orders/{{order}}" },
      { as: "clerk.1", expect: "visible", target: { role: "button", name: "Approve" } },
      ...CANCEL,
      { as: "clerk.1", do: "click", target: { role: "button", name: "Approve" } },
      { as: "clerk.1", expect: "visible", target: { testId: "order-number" } },
      { as: "clerk.1", expect: "fact-equals", marker: "{{order}}", field: "status", value: "cancelled", final: "stale-view" },
    ],
  ],
  ["orphaned", [...PLACE(), ...CANCEL, { as: "clerk.1", do: "goto", path: "/inbox" }, { as: "clerk.1", expect: "hidden", target: { text: "{{order}}" }, final: "orphaned-work" }]],
];
