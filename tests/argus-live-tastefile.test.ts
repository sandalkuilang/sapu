// tests/argus-live-tastefile.test.ts — lane F of phase 7 (spec §20.5, plan decisions 19 and 20): filing the taste
// pass's confirmed rows (argus-live-tastefile.mjs `taste file`, `taste accept`) and the report's scorecard
// (argus-live-report.mjs). No browser: judge.json, curator.json and taste-state.json are fixtures of lane 0's locked
// shapes, gh is a function standing in for it, and every secret is built at run time.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ARGUS_LIVE, cleanTemps, committed, example, liveRun, longSecret } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { appendLedger, ledgerFile } from "../plugins/sapu/scripts/argus-live-ledger.mjs";
// @ts-expect-error — plain ESM script without types
import { down, writeRunFiles } from "../plugins/sapu/scripts/argus-live-run.mjs";
// @ts-expect-error — plain ESM script without types
import { filedFile } from "../plugins/sapu/scripts/argus-live-scrub.mjs";
// @ts-expect-error — plain ESM script without types
import { readTasteState, shotName, writeTasteState } from "../plugins/sapu/scripts/argus-live-tastecfg.mjs";
// @ts-expect-error — plain ESM script without types
import { NO_MAJORITY } from "../plugins/sapu/scripts/argus-live-ease.mjs";
// @ts-expect-error — plain ESM script without types
import { readJudge, tasteAccept, tasteFile } from "../plugins/sapu/scripts/argus-live-tastefile.mjs";

type Obj = Record<string, any>;

const runs: { main: string; runId: string }[] = [];
afterEach(async () => {
  for (const r of runs.splice(0)) await down(r.main, { runId: r.runId, graceMs: 1000 }).catch(() => {});
  cleanTemps();
}, 30_000);

const cli = (main: string, ...args: string[]) => spawnSync(process.execPath, [ARGUS_LIVE, ...args], { cwd: main, encoding: "utf8" });
/** An environment with nothing secret-like: scrub reads only the run's own secrets. */
const ENV = { PATH: process.env.PATH ?? "" };
const ACCOUNTS = { "customer.1": "buyer1@example.test", "sales.1": "sales1@example.test" };
const ORDER = "/orders/:id|1440|light";
const LIST = "/orders|1440|light";

/** A run as scrub reads it (the lock, run.json, the live config with its role password, its env file, a ledger cookie). */
const cycle = () => {
  const t = liveRun();
  const s = { cookie: longSecret(24, "taste-cookie"), envFile: longSecret(18, "taste-env"), role: longSecret(14, "taste-role") };
  const live = example();
  live.roles.customer.users[0].password = s.role;
  writeFileSync(join(t.main, ".argus/live.json"), `${JSON.stringify(live, null, 2)}\n`);
  writeFileSync(join(t.main, ".argus/live.env"), `PW=pw-1\nSALES_TOTP=${"GEZD".repeat(4)}\nDB_PW=${s.envFile}\n`);
  writeRunFiles(t.main, { runId: t.runId, worktree: t.wt, home: t.home, origins: ["http://localhost:41002"], allowOrigins: [], groups: [], env: t.env, ports: { api: 41001, web: 41002, pg: 41003, redis: 41004, smtp: 41005 }, slots: { "1": { journey: "order-to-cash", accounts: ACCOUNTS } } });
  runs.push({ main: t.main, runId: t.runId });
  appendLedger(t.main, t.runId, [{ c: "cookie", v: s.cookie }]);
  const runDir = join(t.main, ".argus/live", t.runId);
  const put = (rel: string, value: unknown) => {
    mkdirSync(join(runDir, rel, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(join(runDir, rel), typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
  };
  return { ...t, s, runDir, put };
};
type Cycle = ReturnType<typeof cycle>;

/** One judge row of lane 0's shape: a confirmed derived count row on the order page unless `over` says otherwise. */
const row = (k: number, over: Obj = {}) => ({
  row: `t${k}`,
  journey: "order-to-cash",
  rule: "scale.spacing",
  class: "derived",
  screen: ORDER,
  key: "main",
  measured: 11,
  expected: 7,
  witnesses: [{ kind: "peer", value: 5, from: LIST }],
  cost: null,
  confirmed: true,
  ...over,
});
const EFFICIENCY = { actions: 14, best: 9, klm_s: 31.5, typed: 42, fitts_bits: 18.25, modals: 1, wait_ms: 2300, recovery: 0 };
const judged = (t: Cycle, rows: Obj[], journeys: Obj = { "order-to-cash": { screens: 3, efficiency: EFFICIENCY } }) => t.put("taste/judge.json", { version: 1, run: t.runId, bar: 1, rows, journeys });

/** gh as a function: `issue list` answers `issues`, `issue create` files the next number (added to `issues`); `attaches` answers gh 2.99 and a private repository (scrub attaches then). */
const fakeGh = (issues: Obj[] = [], beyond: Obj[] = [], { attaches = false } = {}) => {
  const calls: Obj[] = [];
  let n = 100;
  const runner = (argv: string[]) => {
    const a = argv.slice(1);
    const at = (f: string) => a[a.indexOf(f) + 1];
    const labels = a.flatMap((x, i) => (x === "--label" ? [a[i + 1]] : []));
    calls.push({ argv: a, title: a.includes("--title") ? at("--title") : null, labels, body: a.includes("--body-file") ? readFileSync(at("--body-file"), "utf8") : null });
    if (a[0] === "issue" && a[1] === "list") return { status: 0, stdout: JSON.stringify(issues) };
    if (attaches && a[0] === "--version") return { status: 0, stdout: "gh version 2.99.0 (stable)\n" };
    if (attaches && a[0] === "repo" && a[1] === "view") return { status: 0, stdout: "PRIVATE\n" };
    if (a[0] === "issue" && a[1] === "view") {
      const i = [...issues, ...beyond].find((x) => x.url === a[2]);
      return i ? { status: 0, stdout: JSON.stringify(i) } : { status: 1, stdout: "" };
    }
    if (a[0] === "issue" && a[1] === "create") {
      n += 1;
      const url = `https://github.com/o/r/issues/${n}`;
      issues.push({ number: n, title: at("--title"), url, state: "OPEN", stateReason: null });
      return { status: 0, stdout: `${url}\n` };
    }
    return { status: 4, stdout: "" };
  };
  const created = () => calls.filter((c) => c.argv[0] === "issue" && c.argv[1] === "create");
  return { calls, runner, issues, created };
};
const file = (t: Cycle, gh: ReturnType<typeof fakeGh>, cap: number | null = null) => tasteFile(t.main, { run: t.runId, cap }, { env: ENV, runner: gh.runner });
const rowsOf = (t: Cycle, journey = "order-to-cash") => readTasteState(t.main).journeys[journey]?.rows ?? {};
const tk = (rule: string, screen: string) => `taste:${rule}:${screen}`;

describe("argus-live taste file — what files, and how (decision 19)", () => {
  it("files an implicit or derived row with bug, a bar row without it, each with its severity, through scrub --create", async () => {
    const t = cycle();
    judged(t, [
      row(1, { rule: "copy.broken", class: "implicit", key: "p.status", measured: "undefined", expected: 0, witnesses: [] }),
      row(2, { rule: "efficiency.klm", class: "derived", screen: LIST, key: "path", measured: 41.5, expected: 31.5, witnesses: [], cost: 10 }),
      row(3, { rule: "hierarchy.primary-actions", class: "bar", key: "main", measured: 3, expected: 1, witnesses: [{ kind: "band", value: 1, from: "p90" }, { kind: "peer", value: 1, from: LIST }], cost: 12.5 }),
    ]);
    const gh = fakeGh();
    const r = await file(t, gh);
    expect(r.code).toBe(0);
    const made = gh.created();
    expect(made.map((c) => c.title)).toEqual([`${tk("hierarchy.primary-actions", ORDER)} — primary_actions 3 → 1`, `${tk("efficiency.klm", LIST)} — klm_s 41.5 → 31.5`, `${tk("copy.broken", ORDER)} — broken_tokens`]);
    // Ranked by severity, then cost (12.5 before 10 before none); every one S3.
    const labels = Object.fromEntries(made.map((c) => [c.title.split(" ")[0], c.labels]));
    expect(labels[tk("copy.broken", ORDER)]).toEqual(["bug", "ux", "argus", "found-by:user", "severity:s3", "sapu:agent-filed"]);
    expect(labels[tk("efficiency.klm", LIST)]).toEqual(["bug", "ux", "argus", "found-by:user", "severity:s3", "sapu:agent-filed"]);
    expect(labels[tk("hierarchy.primary-actions", ORDER)]).toEqual(["ux", "argus", "found-by:user", "severity:s3", "sapu:agent-filed"]);
    // The body: Viewport, Measured (value → expected, the witnesses, the bar version), the citation, the rows fenced as data.
    const body = made[0].body as string;
    for (const want of ["Viewport: 1440 × light", "Measured: 3 → 1; witnesses: band 1, peer 1; taste-bar 1", "Class: bar", "Severity: S3", "Cost: 12.5 s of klm_s a run", "Journey: `order-to-cash`"]) expect(body, want).toContain(want);
    expect(body).toMatch(/Source: m3-expressive `https:\/\/design\.google\/[^`]+`, lux-hick `https:\/\/lawsofux\.com\/hicks-law\/`/);
    expect(body).toContain('```json\n{"row":"t3","journey":"order-to-cash","key":"main","measured":3,"expected":1,');
    // Text measured off the page never reaches the prose: it stays in the fenced record.
    expect(made[2].body).toContain("Measured: (text, in the record below) → 0; witnesses: none (its own measurement); taste-bar 1");
    // Every one went through scrub: recorded in the run's filed.jsonl, gh given a body file.
    const filed = readFileSync(filedFile(t.main, t.runId), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(filed.map((f) => f.url)).toEqual(["https://github.com/o/r/issues/101", "https://github.com/o/r/issues/102", "https://github.com/o/r/issues/103"]);
    expect(filed.every((f) => f.ref === null && f.kind === "issue")).toBe(true);
    expect(gh.calls[0].argv.slice(0, 5)).toEqual(["issue", "list", "--state", "all", "--limit"]);
    expect(gh.calls.some((c) => c.argv.includes("--search"))).toBe(false);
    // The state: each confirmed row under its title key, open with its issue.
    expect(rowsOf(t)[tk("copy.broken", ORDER)]).toEqual({ rule: "copy.broken", screen: ORDER, class: "implicit", severity: "S3", state: "open", issue: "https://github.com/o/r/issues/103", first: t.runId, last: t.runId });
    expect(r.lines.at(-1)).toBe("taste file: filed 3, polish 0 item(s), queued 0, open 0, closed 0, accepted 0, held 0");
  });

  it("attaches the screen's shot (taste/shots/<shotName>.png) through scrub's verdict; a screen with no shot attaches nothing", async () => {
    const t = cycle();
    judged(t, [row(1, { rule: "copy.broken", class: "implicit", key: "p.status", measured: "undefined", expected: 0, witnesses: [] }), row(2, { rule: "copy.broken", class: "implicit", screen: LIST, key: "p.total", measured: "NaN", expected: 0, witnesses: [] })]);
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001", "hex");
    const shot = `taste/shots/${shotName(ORDER)}.png`;
    t.put(shot, png.toString("latin1"));
    writeFileSync(join(t.runDir, shot), png);
    t.put(shot.replace(/\.png$/, ".verdict.json"), { t: 1, sha256: createHash("sha256").update(png).digest("hex"), passed: true, reasons: [] });
    const gh = fakeGh([], [], { attaches: true });
    expect((await file(t, gh)).code).toBe(0);
    const made = gh.created();
    const order = made.find((c) => c.title.startsWith(tk("copy.broken", ORDER)))!;
    expect(order.argv.slice(-2)).toEqual(["--attach", realpathSync(join(t.runDir, shot))]);
    expect(made.find((c) => c.title.startsWith(tk("copy.broken", LIST)))!.argv).not.toContain("--attach");
  }, 30_000);

  it("one issue per taste:<rule>:<screen key>: a screen's rows of one rule share it, an open issue is never filed twice", async () => {
    const t = cycle();
    judged(t, [
      row(1, { rule: "states.recovery", class: "implicit", key: "form > input[name=qty]", measured: 1, expected: 0, witnesses: [] }),
      row(2, { rule: "states.recovery", class: "implicit", key: "form > input[name=note]", measured: 1, expected: 0, witnesses: [] }),
      row(3, { rule: "copy.broken", class: "implicit", screen: LIST, measured: 2, expected: 0, witnesses: [] }),
      row(4, { rule: "copy.broken", class: "implicit", journey: "refund", screen: LIST, measured: 2, expected: 0, witnesses: [] }),
    ]);
    const open = { number: 7, title: `${tk("copy.broken", LIST)} — broken_tokens 2 → 0`, url: "https://github.com/o/r/issues/7", state: "OPEN", stateReason: null };
    const gh = fakeGh([open]);
    const r = await file(t, gh);
    expect(gh.created().map((c) => c.title)).toEqual([`${tk("states.recovery", ORDER)} — fields_lost on 2 elements`]);
    const body = gh.created()[0].body as string;
    expect(body).toContain("Measured: 2 elements, each in the record below (value → expected); taste-bar 1");
    expect(body.match(/^\{"row":"t[12]"/gm)).toHaveLength(2);
    expect(r.lines).toContain(`open: ${tk("copy.broken", LIST)} https://github.com/o/r/issues/7`);
    // Both journeys that reached the screen point at the open issue.
    for (const j of ["order-to-cash", "refund"]) expect(rowsOf(t, j)[tk("copy.broken", LIST)]).toMatchObject({ state: "open", issue: open.url });
    // A second run of the verb files nothing more.
    const again = fakeGh(gh.issues);
    await file(t, again);
    expect(again.created()).toEqual([]);
  });

  it("the cap holds across calls of one run; the rest stay queued and rank first next time", async () => {
    const t = cycle();
    const rules = ["copy.broken", "states.recovery", "states.success", "states.error"];
    judged(t, rules.map((rule, i) => row(i + 1, { rule, class: "implicit", measured: 1, expected: 0, witnesses: [], cost: i })));
    const gh = fakeGh();
    const r = await file(t, gh, 2);
    // Ranked by cost (3, 2, 1, 0): the two costliest file.
    expect(gh.created().map((c) => c.title.split(" ")[0])).toEqual([tk("states.error", ORDER), tk("states.success", ORDER)]);
    expect(r.lines).toContain(`queued: ${tk("states.recovery", ORDER)} (S3, over the cap of 2)`);
    expect(rowsOf(t)[tk("copy.broken", ORDER)]).toMatchObject({ state: "queued", issue: null, severity: "S3" });
    // Called again for the same run: its two issues count against the cap.
    const again = fakeGh(gh.issues);
    await file(t, again, 2);
    expect(again.created()).toEqual([]);
    // taste.json's cap when the caller passes none.
    const u = cycle();
    mkdirSync(join(u.main, ".argus"), { recursive: true });
    writeFileSync(join(u.main, ".argus/taste.json"), JSON.stringify({ cap: 1 }));
    judged(u, rules.map((rule, i) => row(i + 1, { rule, class: "implicit", measured: 1, expected: 0, witnesses: [] })));
    const one = fakeGh();
    await file(u, one);
    expect(one.created()).toHaveLength(1);
  });

  it("an accepted row never files, by taste.json's accept or the state's", async () => {
    const t = cycle();
    mkdirSync(join(t.main, ".argus"), { recursive: true });
    writeFileSync(join(t.main, ".argus/taste.json"), JSON.stringify({ accept: [{ rule: "copy.broken", key: ORDER, why: "the owner's ruling" }] }));
    writeTasteState(t.main, { version: 1, journeys: { "order-to-cash": { judged: t.runId, best: null, rows: { [tk("states.recovery", ORDER)]: { rule: "states.recovery", screen: ORDER, class: "implicit", severity: "S3", state: "accepted", issue: null, first: t.runId, last: t.runId } } } } });
    judged(t, [row(1, { rule: "copy.broken", class: "implicit", measured: 1, expected: 0, witnesses: [] }), row(2, { rule: "states.recovery", class: "implicit", measured: 1, expected: 0, witnesses: [] })]);
    const gh = fakeGh();
    const r = await file(t, gh);
    expect(r.lines).toEqual(expect.arrayContaining([`accepted: ${tk("copy.broken", ORDER)}`, `accepted: ${tk("states.recovery", ORDER)}`, "taste file: nothing to file"]));
    // Nothing to file: gh is never asked.
    expect(gh.calls).toEqual([]);
    expect(rowsOf(t)[tk("copy.broken", ORDER)]).toMatchObject({ state: "accepted" });
  });

  it("needs-owner only for a consistency split with no majority or a row the Curator's verdict decided", async () => {
    // One mark, the ease probe's: filing reads the constant, never a literal of its own.
    expect(NO_MAJORITY).toBe("no majority");
    expect(readFileSync(join(__dirname, "../plugins/sapu/scripts/argus-live-tastefile.mjs"), "utf8")).not.toMatch(/["'`]no majority|needs-owner["'`]\)/i);
    const t = cycle();
    judged(t, [
      row(1, { rule: "consistent.footer-order", class: "derived", key: "dialog footer", measured: 2, expected: NO_MAJORITY, witnesses: [] }),
      row(2, { rule: "consistent.action", class: "derived", screen: LIST, key: "POST /api/orders", measured: 2, expected: 1, witnesses: [] }),
      row(3, { rule: "copy.broken", class: "implicit", measured: 1, expected: 0, witnesses: [] }),
      row(4, { rule: "states.recovery", class: "implicit", measured: 1, expected: 0, witnesses: [] }),
      row(5, { rule: "states.success", class: "implicit", measured: 1500, expected: 1000, witnesses: [] }),
      row(6, { rule: "scale.radii", class: "derived", measured: 9, expected: 4 }),
      row(7, { rule: "hierarchy.alignment", class: "derived", measured: 2, expected: 0 }),
    ]);
    t.put("taste/curator.json", {
      verdicts: [
        { row: "t3", verdict: "reject", reason: "the token is the product's own word" },
        { row: "t4", verdict: "polish", reason: "minor" },
        { row: "t5", verdict: "confirm", reason: "plain" },
        { row: "t6", verdict: "reject", reason: "intended" },
        { row: "t99", verdict: "reject", reason: "names no row" },
      ],
      leads: [],
    });
    const gh = fakeGh();
    const r = await file(t, gh, 10);
    const by = Object.fromEntries(gh.created().map((c) => [c.title.split(" ")[0], c]));
    const owner = (k: string) => by[k]?.labels.includes("argus:needs-owner");
    expect(owner(tk("consistent.footer-order", ORDER))).toBe(true);
    expect(owner(tk("copy.broken", ORDER))).toBe(true);
    expect(owner(tk("states.recovery", ORDER))).toBe(true);
    expect(owner(tk("states.success", ORDER))).toBe(false);
    expect(by[tk("consistent.footer-order", ORDER)].body).toContain("Needs the owner: a consistency split with no majority: two ways, neither the app's own rule");
    expect(by[tk("copy.broken", ORDER)].body).toContain("Needs the owner: the Curator rejected the measured row");
    expect(by[tk("copy.broken", ORDER)].body).toContain('"curator":{"verdict":"reject","reason":"the token is the product\'s own word"}');
    // A split with a majority is the polish roll-up's (S4), as is an S4 row; one the Curator rejected is held.
    expect(by[tk("consistent.action", LIST)]).toBeUndefined();
    expect(r.lines).toContain(`held: ${tk("scale.radii", ORDER)} (the Curator rejected an S4 coherence item)`);
    const polish = gh.created().find((c) => c.title.startsWith("[polish]"))!;
    expect(polish.labels).not.toContain("argus:needs-owner");
    expect(polish.body).toContain(`"title":"${tk("consistent.action", LIST)}"`);
    expect(polish.body).not.toContain("scale.radii");
  });

  it("the polish roll-up takes measured S4 items only: one issue, severity s4, priority p3, never a bug", async () => {
    const t = cycle();
    judged(t, [
      row(1),
      row(2, { rule: "hierarchy.alignment", class: "derived", key: "nav > a", measured: 2, expected: 0, witnesses: [] }),
      row(3, { rule: "motion.duration", class: "bar", key: "dialog", measured: 900, expected: 500, witnesses: [{ kind: "frame", value: 400, from: "carbon" }] }),
      row(4, { rule: "copy.broken", class: "implicit", measured: 1, expected: 0, witnesses: [] }),
      row(5, { rule: "hierarchy.nested-radius", class: "implicit", confirmed: false, measured: 1, expected: 0, witnesses: [] }),
      row(6, { rule: "scale.weights", class: "derived", confirmed: null }),
      row(7, { rule: "contrast.headroom", class: "bar", measured: 5.1, expected: 7, witnesses: [{ kind: "peer", value: 8, from: LIST }] }),
    ]);
    const gh = fakeGh();
    const r = await file(t, gh);
    const polish = gh.created().filter((c) => c.title.startsWith("[polish]"));
    expect(polish).toHaveLength(1);
    expect(polish[0].title).toBe(`[polish] cycle ${t.runId} — 3 coherence items`);
    expect(polish[0].labels).toEqual(["ux", "argus", "found-by:user", "severity:s4", "priority:p3", "sapu:agent-filed"]);
    const lines = (polish[0].body as string).split("\n").filter((l) => l.startsWith('{"title"'));
    expect(lines.map((l) => JSON.parse(l).title)).toEqual([tk("scale.spacing", ORDER), tk("motion.duration", ORDER), tk("hierarchy.alignment", ORDER)]);
    // Unconfirmed rows (false, null) and information rules are nowhere; the S3 row files alone.
    for (const x of ["nested-radius", "scale.weights", "contrast.headroom"]) expect(gh.calls.map((c) => `${c.title} ${c.body}`).join("\n")).not.toContain(x);
    expect(gh.created().filter((c) => c.title.startsWith("taste:")).map((c) => c.title.split(" ")[0])).toEqual([tk("copy.broken", ORDER)]);
    expect(rowsOf(t)[tk("scale.spacing", ORDER)]).toMatchObject({ severity: "S4", state: "open", issue: "https://github.com/o/r/issues/102" });
    expect(r.lines).toContain("polish: https://github.com/o/r/issues/102 3 item(s)");
    // One roll-up a run: a second call files none, and its items stay open in the first.
    const again = fakeGh(gh.issues);
    await file(t, again);
    expect(again.created()).toEqual([]);
  });

  it("a bar row is filed only with an internal witness", async () => {
    const t = cycle();
    judged(t, [
      row(1, { rule: "hierarchy.primary-actions", class: "bar", measured: 3, expected: 1, witnesses: [{ kind: "band", value: 1, from: "p90" }], cost: 20 }),
      row(2, { rule: "copy.vague", class: "bar", key: "button OK", measured: 1, expected: 0, witnesses: [], cost: 20 }),
    ]);
    const gh = fakeGh();
    const r = await file(t, gh);
    expect(r.lines).toEqual(expect.arrayContaining([`held: ${tk("hierarchy.primary-actions", ORDER)} (a bar row without an internal witness)`, `held: ${tk("copy.vague", ORDER)} (a bar row without an internal witness)`, "taste file: nothing to file"]));
    expect(gh.calls).toEqual([]);
    expect(rowsOf(t)).toEqual({});
  });

  it("an issue the state names but the list does not hold (an old one) is viewed by its URL, never filed twice", async () => {
    const t = cycle();
    const old = "https://github.com/o/r/issues/3";
    writeTasteState(t.main, { version: 1, journeys: { "order-to-cash": { judged: t.runId, best: null, rows: { [tk("copy.broken", ORDER)]: { rule: "copy.broken", screen: ORDER, class: "implicit", severity: "S3", state: "open", issue: old, first: t.runId, last: t.runId } } } } });
    judged(t, [row(1, { rule: "copy.broken", class: "implicit", measured: 1, expected: 0, witnesses: [] })]);
    const gh = fakeGh([], [{ number: 3, title: "renamed by the owner", url: old, state: "OPEN", stateReason: null }]);
    const r = await file(t, gh);
    expect(r.lines).toContain(`open: ${tk("copy.broken", ORDER)} ${old}`);
    expect(gh.created()).toEqual([]);
    expect(gh.calls.map((c) => c.argv.slice(0, 3))).toEqual([["issue", "list", "--state"], ["issue", "view", old]]);
  });

  it("an issue the owner closed as not planned is their ruling: never filed again; one closed as completed is filed anew", async () => {
    const t = cycle();
    judged(t, [row(1, { rule: "copy.broken", class: "implicit", measured: 1, expected: 0, witnesses: [] }), row(2, { rule: "states.recovery", class: "implicit", measured: 1, expected: 0, witnesses: [] })]);
    const gh = fakeGh([
      { number: 5, title: `${tk("copy.broken", ORDER)} — broken_tokens 1 → 0`, url: "https://github.com/o/r/issues/5", state: "CLOSED", stateReason: "NOT_PLANNED" },
      { number: 6, title: `${tk("states.recovery", ORDER)} — fields_lost 1 → 0`, url: "https://github.com/o/r/issues/6", state: "CLOSED", stateReason: "COMPLETED" },
    ]);
    const r = await file(t, gh);
    expect(r.lines).toContain(`closed: ${tk("copy.broken", ORDER)} https://github.com/o/r/issues/5 (closed as not planned: the owner's ruling; stage taste accept copy.broken ${ORDER} only on their word)`);
    expect(rowsOf(t)[tk("copy.broken", ORDER)]).toMatchObject({ state: "closed", issue: "https://github.com/o/r/issues/5" });
    expect(gh.created().map((c) => c.title.split(" ")[0])).toEqual([tk("states.recovery", ORDER)]);
    expect(gh.created()[0].body).toContain("Earlier: `https://github.com/o/r/issues/6` was closed as completed; measured again since.");
  });

  it("everything goes through scrub: a secret in a row stops the filing before gh files anything", async () => {
    const t = cycle();
    judged(t, [row(1, { rule: "copy.broken", class: "implicit", key: `td ${t.s.cookie}`, measured: 1, expected: 0, witnesses: [] })]);
    const gh = fakeGh();
    const r = await file(t, gh);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual(expect.arrayContaining(["refused: scrub: 1 secret(s) in the issue; nothing is filed"]));
    expect(r.lines.join("\n")).not.toContain(t.s.cookie.slice(0, 12));
    expect(gh.created()).toEqual([]);
    expect(rowsOf(t)[tk("copy.broken", ORDER)]).toMatchObject({ state: "queued", issue: null });
    // A run scrub refuses (its ledger gone): refused before gh is asked anything.
    const u = cycle();
    judged(u, [row(1, { rule: "copy.broken", class: "implicit", measured: 1, expected: 0, witnesses: [] })]);
    rmSync(ledgerFile(u.main, u.runId));
    const none = fakeGh();
    const refused = await file(u, none);
    expect(refused.code).toBe(1);
    expect(none.calls).toEqual([]);
  }, 30_000);

  it("gh failing: no listing files nothing (exit 2); a create that prints no URL stops the filing (exit 2), the row queued", async () => {
    const t = cycle();
    judged(t, [row(1, { rule: "copy.broken", class: "implicit", measured: 1, expected: 0, witnesses: [] }), row(2, { rule: "states.recovery", class: "implicit", measured: 1, expected: 0, witnesses: [] })]);
    const calls: string[][] = [];
    const listless = (argv: string[]) => (calls.push(argv.slice(1)), { status: 1, stdout: "" });
    const r = await tasteFile(t.main, { run: t.runId, cap: null }, { env: ENV, runner: listless });
    expect(r.code).toBe(2);
    expect(r.lines.at(-1)).toBe("failed: taste file: gh's issue listing exited 1 without a list; nothing is filed (the dedupe compares every issue's title)");
    expect(calls).toHaveLength(1);
    const noUrl = (argv: string[]) => (argv[1] === "issue" && argv[2] === "list" ? { status: 0, stdout: "[]" } : { status: 1, stdout: "" });
    const s = await tasteFile(t.main, { run: t.runId, cap: null }, { env: ENV, runner: noUrl });
    expect(s.code).toBe(2);
    expect(s.lines).toEqual(expect.arrayContaining(["failed: gh issue create exited 1 before printing an issue URL", `queued: ${tk("states.recovery", ORDER)} (S3, not filed: the filing stopped)`]));
    expect(Object.values(rowsOf(t)).map((x: Obj) => x.state)).toEqual(["queued", "queued"]);
  });

  it("refuses a run it cannot read, a judge record of another shape and a cap out of range, before gh", async () => {
    const t = cycle();
    const gh = fakeGh();
    await expect(tasteFile(t.main, { run: "nope", cap: null }, { runner: gh.runner })).rejects.toThrow("refused: taste file: --run takes a run id");
    await expect(tasteFile(t.main, { run: t.runId, cap: 21 }, { runner: gh.runner })).rejects.toThrow("refused: taste file: cap must be an integer from 1 to 20");
    await expect(tasteFile(t.main, { run: t.runId, cap: null }, { runner: gh.runner })).rejects.toThrow(`refused: taste file: run ${t.runId} has no taste/judge.json (run taste judge first)`);
    judged(t, [row(1, { witnesses: "peer" })]);
    await expect(tasteFile(t.main, { run: t.runId, cap: null }, { runner: gh.runner })).rejects.toThrow(/^refused: taste file: taste\/judge\.json row 1: witnesses must be/);
    t.put("taste/judge.json", { version: 1, run: "20000101000000-0123abcd", bar: 1, rows: [], journeys: {} });
    await expect(tasteFile(t.main, { run: t.runId, cap: null }, { runner: gh.runner })).rejects.toThrow("refused: taste file: taste/judge.json is not this run's");
    judged(t, [row(1)]);
    t.put("taste/curator.json", { verdicts: [{ row: "t1", verdict: "maybe" }] });
    await expect(tasteFile(t.main, { run: t.runId, cap: null }, { runner: gh.runner })).rejects.toThrow("refused: taste file: taste/curator.json verdict 1 is not {row, verdict: confirm|reject|polish, reason}");
    expect(gh.calls).toEqual([]);
    expect(readJudge(t.main, "20000101000000-0123abcd")).toEqual({ judge: null, fault: null });
  }, 30_000);

  it("taste file through the CLI: refused with no run here, and the --run id checked", () => {
    const main = committed();
    expect(cli(main, "taste", "file")).toMatchObject({ status: 1, stdout: "", stderr: "refused: taste file: no run here\n" });
    expect(cli(main, "taste", "file", "--run", "20000101000000-0123abcd")).toMatchObject({ status: 1, stdout: "", stderr: "refused: taste file: no run 20000101000000-0123abcd here\n" });
  }, 30_000);
});

describe("argus-live taste accept — the owner's ruling, staged on their word", () => {
  it("adds {rule, key, why} to .argus/taste.json and marks the state's rows accepted; twice is once", async () => {
    const t = cycle();
    const key = tk("copy.broken", ORDER);
    writeTasteState(t.main, { version: 1, journeys: { "order-to-cash": { judged: t.runId, best: null, rows: { [key]: { rule: "copy.broken", screen: ORDER, class: "implicit", severity: "S3", state: "closed", issue: "https://github.com/o/r/issues/5", first: t.runId, last: t.runId } } } } });
    mkdirSync(join(t.main, ".argus"), { recursive: true });
    writeFileSync(join(t.main, ".argus/taste.json"), `${JSON.stringify({ cap: 3 }, null, 2)}\n`);
    expect(await tasteAccept(t.main, "copy.broken", ORDER)).toEqual({ code: 0, lines: [`taste accept: ${key} added to .argus/taste.json (commit it); 1 row(s) of .argus/taste-state.json accepted`] });
    expect(JSON.parse(readFileSync(join(t.main, ".argus/taste.json"), "utf8"))).toEqual({ cap: 3, accept: [{ rule: "copy.broken", key: ORDER, why: "the owner's ruling (taste accept), on https://github.com/o/r/issues/5" }] });
    expect(rowsOf(t)[key].state).toBe("accepted");
    expect(await tasteAccept(t.main, "copy.broken", ORDER)).toEqual({ code: 0, lines: [`taste accept: ${key} is already in .argus/taste.json; 0 row(s) of .argus/taste-state.json accepted`] });
    expect(JSON.parse(readFileSync(join(t.main, ".argus/taste.json"), "utf8")).accept).toHaveLength(1);
  });

  it("refuses a rule the bar lacks, an information rule, a key that is no screen key and a taste.json it cannot read", async () => {
    const main = committed();
    await expect(tasteAccept(main, "scale.nope", ORDER)).rejects.toThrow("refused: taste accept: scale.nope is not a rule of the bar");
    await expect(tasteAccept(main, "contrast.headroom", ORDER)).rejects.toThrow("refused: taste accept: contrast.headroom is information only: it never files");
    await expect(tasteAccept(main, "copy.broken", "/orders")).rejects.toThrow("refused: taste accept: the key is a screen key, <route template>|<viewport width>|<light|dark>");
    mkdirSync(join(main, ".argus"), { recursive: true });
    writeFileSync(join(main, ".argus/taste.json"), "{");
    await expect(tasteAccept(main, "copy.broken", ORDER)).rejects.toThrow("refused: taste accept: .argus/taste.json is not valid JSON");
    writeFileSync(join(main, ".argus/taste.json"), JSON.stringify({ bogus: 1 }));
    await expect(tasteAccept(main, "copy.broken", ORDER)).rejects.toThrow('refused: taste accept: .argus/taste.json: .argus/taste.json: unknown key "bogus"');
  });

  it("taste accept through the CLI writes taste.json with no state yet", () => {
    const main = committed();
    expect(cli(main, "taste", "accept", "scale.spacing", ORDER)).toMatchObject({ status: 0, stdout: `taste accept: ${tk("scale.spacing", ORDER)} added to .argus/taste.json (commit it); 0 row(s) of .argus/taste-state.json accepted\n` });
    expect(existsSync(join(main, ".argus/taste-state.json"))).toBe(false);
    expect(statSync(join(main, ".argus/taste.json")).isFile()).toBe(true);
  }, 30_000);
});

describe("argus-live report — the taste and usability scorecard first (decision 20)", () => {
  // @ts-expect-error — plain ESM script without types
  const load = () => import("../plugins/sapu/scripts/argus-live-report.mjs");
  const lines = (t: Cycle) => readFileSync(join(t.main, ".argus/reports", `${t.runId}.md`), "utf8").split("\n");
  const section = (l: string[], title: string) => {
    const at = l.indexOf(`## ${title}`);
    const end = l.findIndex((x, i) => i > at && x.startsWith("## "));
    return l.slice(at + 2, end < 0 ? undefined : end).filter((x) => x !== "");
  };
  const PASS = { q1: "yes, the handoff signal held", q2: "yes, on the landing page in 1 click", q3: "yes, named Pay", q4: "yes, Paid shown" };

  it("opens with ## Taste and usability: screens, rows by family and state, efficiency, the walkthrough, the Curator, the bar", async () => {
    const { report } = await load();
    const t = cycle();
    const link = ["https:", "", "evil.example", "x"].join("/");
    judged(
      t,
      [
        row(1),
        row(2, { rule: "copy.broken", class: "implicit", key: `td ${t.s.cookie} ${link}`, measured: 1, expected: 0, witnesses: [] }),
        row(3, { rule: "scale.radii", confirmed: false }),
        row(4, { journey: "refund", rule: "states.recovery", class: "implicit", measured: 1, expected: 0, witnesses: [] }),
      ],
      { "order-to-cash": { screens: 3, efficiency: EFFICIENCY }, refund: { screens: [ORDER, LIST], efficiency: null } },
    );
    t.put("taste/curator.json", { verdicts: [{ row: "t1", verdict: "confirm", reason: `see ${link}` }, { row: "t2", verdict: "reject", reason: t.s.cookie }, { row: "t9", verdict: "polish", reason: "x" }], leads: [] });
    writeTasteState(t.main, {
      version: 1,
      journeys: {
        "order-to-cash": {
          judged: t.runId,
          best: null,
          rows: {
            [tk("scale.spacing", LIST)]: { rule: "scale.spacing", screen: LIST, class: "derived", severity: "S4", state: "queued", issue: null, first: t.runId, last: t.runId },
            [tk("copy.broken", LIST)]: { rule: "copy.broken", screen: LIST, class: "implicit", severity: "S3", state: "accepted", issue: null, first: t.runId, last: t.runId },
          },
        },
      },
    });
    t.put("returns/2.1.json", { journey: "order-to-cash", status: "done", steps: [{}], coverage: {}, candidates: [], harness_events: [], cw: [{ step: "pay", ...PASS }, { step: "ship", ...PASS, q2: "fail: reached by a typed URL" }, { step: "close", ...PASS }] });
    expect(report(t.main, { run: t.runId }, { env: ENV }).code).toBe(0);
    const l = lines(t);
    expect(l.filter((x) => x.startsWith("## "))[0]).toBe("## Taste and usability");
    expect(section(l, "Taste and usability")).toEqual([
      "- taste-bar 1; confirmed: measured two of two this run; queued and accepted: the journey's standing rows in .argus/taste-state.json; satisfaction is never measured, discoverability only through the walkthrough",
      "- journey order-to-cash: screens 3; efficiency actions 14 (best 9), klm_s 31.5, typed 42, fitts_bits 18.25, modals 1, wait_ms 2300, recovery 0; walkthrough 2 of 3 step(s) pass all four questions; Curator confirm 1, reject 1, polish 0",
      "  - copy: confirmed 1, queued 0, accepted 1",
      "  - scale: confirmed 1, queued 1, accepted 0",
      "- journey refund: screens 2; efficiency not measured; walkthrough none recorded; Curator confirm 0, reject 0, polish 0",
      "  - states: confirmed 1, queued 0, accepted 0",
    ]);
    // No page text and no Curator reason reaches the report: the planted secret and link are nowhere in it.
    const text = l.join("\n");
    expect(text).not.toContain(t.s.cookie.slice(0, 12));
    expect(text).not.toContain("evil.example");
    // The functional sections follow, as before.
    expect(l.filter((x) => x.startsWith("## ")).slice(1, 3)).toEqual(["## Journeys walked", "## Candidates"]);
  });

  it("a run the taste pass never touched keeps the report as it was; one not judged says so; a record out of shape is named", async () => {
    const { report } = await load();
    const t = cycle();
    report(t.main, { run: t.runId }, { env: ENV });
    expect(lines(t).filter((x) => x.startsWith("## "))[0]).toBe("## Journeys walked");
    t.put("taste/1/screens.jsonl", "");
    report(t.main, { run: t.runId }, { env: ENV });
    expect(section(lines(t), "Taste and usability")).toEqual(["- taste-bar 1 (the plugin's); not judged: the run has no taste/judge.json"]);
    t.put("taste/judge.json", { version: 2 });
    t.put("taste/curator.json", "{");
    report(t.main, { run: t.runId }, { env: ENV });
    expect(section(lines(t), "Taste and usability")).toEqual(["- taste-bar 1 (the plugin's); not judged: taste/judge.json is out of shape (Records not read)"]);
    expect(section(lines(t), "Records not read")).toEqual(expect.arrayContaining(["- taste/judge.json"]));
    judged(t, [row(1)]);
    writeFileSync(join(t.main, ".argus/taste-state.json"), "[]");
    report(t.main, { run: t.runId }, { env: ENV });
    expect(section(lines(t), "Records not read")).toEqual(expect.arrayContaining(["- taste/curator.json", "- .argus/taste-state.json"]));
    expect(section(lines(t), "Taste and usability")[1]).toBe("- journey order-to-cash: screens 3; efficiency actions 14 (best 9), klm_s 31.5, typed 42, fitts_bits 18.25, modals 1, wait_ms 2300, recovery 0; walkthrough none recorded; Curator confirm 0, reject 0, polish 0");
  });
});
