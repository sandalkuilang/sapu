// argus-live-classes.mjs — a journey finding's class, labels and starting severity (spec §10 "Classes and
// severity"; decision 23): read from the oracle and the facts the orchestrator passes, never an opinion.
// argus's own adjustments (mitigating factors, the Reachable-by rule) stay the orchestrator's. A leaf module.

/** Every journey issue's last labels (spec §10). */
const ALWAYS = ["argus", "found-by:user"];

/** Class A: a `bug` whose starting severity follows from the facts given. */
const bug = (severity, because) => ({ kind: "bug", severity, because });
/** A heuristic oracle: B(a) under a written rule, else heuristic and needs-owner; at most S3 either way. */
const heuristic = (name) => ({ kind: "heuristic", name });

/**
 * Spec §10's table by oracle (keys in ORACLES' order). A `bug` row's `severity` and `because` read the
 * facts `{money, stock, movedTwice, actedOn}`; a `heuristic` row reads `rule` (a written rule exists).
 */
export const CLASSES = {
  handoff: heuristic("handoff signal"),
  "status-coherence": bug(
    (f) => (f.actedOn ? "S2" : "S3"),
    (f) => (f.actedOn ? "status coherence on a fact a role acts on" : "status coherence on a fact no role acts on"),
  ),
  "dead-end": bug(
    (f) => (f.money ? "S1" : "S2"),
    (f) => (f.money ? "dead end on a money journey" : "dead end, not on a money journey"),
  ),
  reversal: bug(
    () => "S1",
    () => "reversal: a resource not released exactly once",
  ),
  "orphaned-work": bug(
    () => "S3",
    () => "orphaned work",
  ),
  "claim-race": bug(
    (f) => (f.movedTwice ? "S1" : "S2"),
    (f) => (f.movedTwice ? "claim race that moved money or stock twice" : "claim race, nothing moved twice"),
  ),
  "stale-view": bug(
    (f) => (f.money || f.stock ? "S1" : "S2"),
    (f) => (f.money || f.stock ? "stale view on money or stock" : "stale view"),
  ),
  "unreachable-step": heuristic("unreachable step"),
  "re-entry": heuristic("re-entry"),
  discoverability: heuristic("discoverability"),
  "interrupted-flow": bug(
    () => "by outcome",
    () => "interrupted flow: rated by its outcome, as argus rates",
  ),
  "viewport-locale": bug(
    () => "by outcome",
    () => "viewport or locale: rated by its outcome, as argus rates",
  ),
};

/**
 * A journey finding's class → `{cls, labels, severity, because}`: `cls` `A`, `B(a)` or `heuristic`; its
 * labels ending `argus`, `found-by:user`; the starting severity `S1`-`S3`, `at most S3` or `by outcome`;
 * `because` the row's words. `needsOwner` is the contract's `labels.needsOwner`. Refused: an oracle the
 * table does not hold.
 */
export function classify({ oracle, money = false, stock = false, movedTwice = false, actedOn = false, rule = false, needsOwner = "argus:needs-owner" }) {
  if (typeof oracle !== "string" || !Object.hasOwn(CLASSES, oracle)) throw new Error(`refused: classify: ${typeof oracle === "string" && /^[a-z-]{1,40}$/.test(oracle) ? oracle : "that"} is not an oracle`);
  const row = CLASSES[oracle];
  if (row.kind === "heuristic") {
    return rule
      ? { cls: "B(a)", labels: ["class:business", "workflow", ...ALWAYS], severity: "at most S3", because: `${row.name} with a written rule` }
      : { cls: "heuristic", labels: ["ux", "workflow", needsOwner, ...ALWAYS], severity: "at most S3", because: `${row.name} with no written rule` };
  }
  const facts = { money, stock, movedTwice, actedOn };
  return { cls: "A", labels: ["bug", ...ALWAYS], severity: row.severity(facts), because: row.because(facts) };
}
