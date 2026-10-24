// argus-live-session.mjs — one account's CLI session as the wrapper drives it (spec §9 "The wrapper",
// "Login"): opened on first use, hooked (the in-daemon listeners every document and popup is watched by)
// and signed in, opened again when its browser is gone, observed after each command, and signed in again
// when logged_in is lost from the page and from a probe tab. `pw`'s explorer
// calls and the repro runner's steps share it, so neither keeps a copy of the session handling.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AIUX_SOURCE } from "./argus-live-aiux.mjs";
import { openSession, PAGE_INIT, SIGNAL_SCRIPT, TASTE_WORLD, writeInitPayload } from "./argus-live-browser.mjs";
import { closeSessions, runCli, sessionAlive, sessionName } from "./argus-live-cli.mjs";
import { loadLive } from "./argus-live-config.mjs";
import { EASE_SOURCE } from "./argus-live-ease.mjs";
import { appendLedger, appendSeen, ledgerEntries, seenIds } from "./argus-live-ledger.mjs";
import { liveDir } from "./argus-live-lock.mjs";
import { readJourneys } from "./argus-live-map.mjs";
import { activeSink, measure, PERF_SCRIPT } from "./argus-live-perf.mjs";
import { commandLogin, loginCode, loginPlan, loginRetry, loginStageSource, runCode } from "./argus-live-login.mjs";
import { run, runAsync } from "./argus-live-proc.mjs";
import { browserHome, logsDir, readRun, recordedSecrets } from "./argus-live-run.mjs";
import { writeVerdict } from "./argus-live-scrub.mjs";
import { CREATED, readSlotState, stillLive } from "./argus-live-slots.mjs";
import { censusOf } from "./argus-live-taste.mjs";
import { loadBar, loadTaste, MEDIA_READ, SCREEN_KEY, shotName, TASTE_BUDGET_MS, TASTE_DRAIN, tasteEventFault, tasteOff } from "./argus-live-tastecfg.mjs";
import { WORLD_EVAL } from "./argus-live-world.mjs";

/** The CLI's answer when the session's browser is gone (0.1.22: "The browser '<name>' is not open, please run open first"). */
const NOT_OPEN = /is not open, please run open first/;

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** The bytes of distinct header values one context records before its hook stops and flags overflow. */
export const CAP_BYTES = 4 * 2 ** 20;

/**
 * Keeps a drain of session `session` (the observe stage's `secrets`): its secret-like values in the run's
 * ledger, `incomplete` (`<session> passed <capBytes> bytes`) when its hook overflowed, and its ids in
 * `seen.jsonl`. The repro runner keeps its step templates' drains through it too.
 */
export function keepDrain(main, runId, session, drained, capBytes) {
  const s = drained && typeof drained === "object" ? drained : {};
  appendLedger(main, runId, [...ledgerEntries(s), ...(s.overflow ? [{ c: "incomplete", v: `${session} passed ${capBytes} bytes` }] : [])]);
  appendSeen(main, runId, seenIds(s));
}

/**
 * Drains run `runId`'s sessions `records` (run.json `sessions`) before they are closed (`up --fresh`,
 * `down`): each whose daemon runs, the observe stage in its own cwd and HOME, its values kept (keepDrain;
 * `<session> could not be drained` marks the ledger incomplete when that fails); each whose daemon is
 * gone while its account's state (its slot's state.json) says `drained: false`, `<session> lost before
 * its drain`; one gone between commands lost nothing. `js` is run.json's CLI unless given. `drained(name)`
 * is told each session whose values are kept, or that lost none: the teardown marks every other undrained
 * when this throws part-way.
 */
export async function drainSessions(main, runId, records, { js = null, runner = run, cliRunner = runAsync, capBytes = CAP_BYTES, drained = () => {} } = {}) {
  let cli = js;
  if (!cli) {
    try {
      cli = (readRun(main) ?? {}).browser?.js ?? null;
    } catch {
      cli = null;
    }
  }
  const marks = [];
  for (const s of Array.isArray(records) ? records : []) {
    if (!s || typeof s.name !== "string" || !s.daemon) continue;
    if (!sessionAlive({ daemon: s.daemon }, runner)) {
      let state = null;
      try {
        state = (readSlotState(s.cwd).sessions ?? {})[s.account] ?? null;
      } catch {
        state = null;
      }
      if (state && state.drained === false) marks.push({ c: "incomplete", v: `${s.name} lost before its drain` });
      else drained(s.name);
      continue;
    }
    try {
      if (typeof cli !== "string" || !fs.existsSync(cli)) throw new Error("no CLI");
      const o = await runCode({ js: cli, session: s.name, cwd: s.cwd, home: s.home, code: loginCode("observe", { loggedIn: null }), timeoutMs: 60_000, runner: cliRunner });
      keepDrain(main, runId, s.name, o && o.secrets, capBytes);
      drained(s.name);
    } catch {
      marks.push({ c: "incomplete", v: `${s.name} could not be drained` });
    }
  }
  if (marks.length) appendLedger(main, runId, marks);
}

/** Every value the output must never show: the env_file's (now and as `up` read them), every role password and TOTP secret, and the passwords of accounts the journey created. */
export function maskSecrets(main, config, live, state) {
  const out = { ...recordedSecrets(main, config), ...loadLive(main).secrets };
  for (const [role, r] of Object.entries((live && live.roles) || {})) {
    (r && Array.isArray(r.users) ? r.users : []).forEach((u, i) => {
      if (u && typeof u.password === "string") out[`role:${role}.${i}.password`] = u.password;
      if (u && typeof u.totp_secret === "string") out[`role:${role}.${i}.totp`] = u.totp_secret;
    });
  }
  for (const [a, c] of Object.entries(state.created ?? {})) if (c && typeof c.password === "string") out[`created:${a}`] = c.password;
  return out;
}

/** True when `u` is a user of some role of the expanded config `live`, compared trimmed and without case. */
export function configuredUser(live, u) {
  const norm = (x) => String(x).trim().toLowerCase();
  return Object.values((live && live.roles) || {}).some((r) => (r && Array.isArray(r.users) ? r.users : []).some((x) => x && typeof x.user === "string" && norm(x.user) === norm(u)));
}

/**
 * Appends one re-login probe to the run's `logs/probes.jsonl` (0600): `{slot, account, url, start, end}`
 * (epoch ms), so the probe tab's request to the role's base_url is told apart from the page's own.
 */
function logProbe(main, runId, entry) {
  try {
    const logs = logsDir(main, runId);
    fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(logs, "probes.jsonl"), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // the `probed:` line still tells it
  }
}

// ---------------------------------------------------------------------------------------------------
// The taste pass's recording (spec §20.4, decision 17): every screen an explorer reaches, measured by the
// observation's own run-code after it observed, kept under `<run>/taste/` and never shown to the explorer.

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** `<run>/taste/`: run `runId`'s taste files (each slot's screens, the shots, the judge's rows, the time spent). */
export const tasteDir = (main, runId) => path.join(liveDir(main), runId, "taste");
const privateDir = (d) => {
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.chmodSync(d, 0o700);
};
const appendPrivate = (file, obj) => fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, { mode: 0o600 });

/** The milliseconds run `runId`'s taste pass spent so far (recording, judging, confirmation replays): `<run>/taste/spent.jsonl`'s sum. */
export function tasteSpent(main, runId) {
  let text = "";
  try {
    text = fs.readFileSync(path.join(tasteDir(main, runId), "spent.jsonl"), "utf8");
  } catch {
    return 0;
  }
  let ms = 0;
  for (const l of text.split("\n")) {
    try {
      const e = JSON.parse(l);
      if (isObj(e) && Number.isFinite(e.ms) && e.ms > 0) ms += e.ms;
    } catch {
      // a torn line counts nothing
    }
  }
  return ms;
}

/** Adds `ms` of `what` (`record`, `judge`, `confirm`) to run `runId`'s taste time (TASTE_BUDGET_MS a cycle); never throws. */
export function spendTaste(main, runId, what, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  try {
    privateDir(tasteDir(main, runId));
    appendPrivate(path.join(tasteDir(main, runId), "spent.jsonl"), { what, ms: Math.round(ms) });
  } catch {
    // the budget is a bound, not a record
  }
}

/** `ms` in words: `42 s`, `3 min 10 s`. */
const span = (ms) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}` : `${s} s`;
};

/** What a taste confirm that took `ms` says of the pass's budget: `(took 42 s, 3 min 10 s left)`; `no time left` once TASTE_BUDGET_MS is spent. */
export function budgetNote(main, runId, ms) {
  const left = TASTE_BUDGET_MS - tasteSpent(main, runId);
  return `(took ${span(ms)}, ${left >= 500 ? `${span(left)} left` : "no time left"})`;
}

const failedFile = (main, runId) => path.join(tasteDir(main, runId), "replay-failed.jsonl");

/** Remembers that the replay of `sha` (a path's pathSha) of `journey` ended before `screen`, saying `said`: the cycle's later rows of that screen are answered from it. Never throws. */
export function noteReplayFailed(main, runId, journey, screen, sha, said) {
  try {
    privateDir(tasteDir(main, runId));
    appendPrivate(failedFile(main, runId), { journey, screen, sha, said });
  } catch {
    // a cache: the next row replays
  }
}

/** The `said` of the cycle's failed replay of `journey`'s `screen` by the path `sha`, or null. */
export function replayFailed(main, runId, journey, screen, sha) {
  let text = "";
  try {
    text = fs.readFileSync(failedFile(main, runId), "utf8");
  } catch {
    return null;
  }
  for (const l of text.split("\n")) {
    try {
      const e = JSON.parse(l);
      if (isObj(e) && e.journey === journey && e.screen === screen && e.sha === sha && typeof e.said === "string") return e.said;
    } catch {
      // a torn line says nothing
    }
  }
  return null;
}

/**
 * The route template of `pathname` (decision 17's screen key): the map's route it matches (a `:name`, `*`, `{name}`
 * or `[name]` segment matches any one segment; the most literal match wins), else the path with each id-like
 * segment (digits, a UUID, 16+ hex digits, a run of 3+ digits, a digit beside a `-`, `_`, `.`, `:` or `~` as in
 * `ORD-1`, or 20+ characters mixing letters and digits) written
 * `:id`; whitespace and `|` become `_`, at most 200 characters. Self-contained: the recorder runs its source in the daemon.
 */
export function routeTemplate(pathname, routes) {
  const segs = String(pathname || "/").split("/").filter(Boolean);
  let best = null;
  let most = -1;
  for (const r of Array.isArray(routes) ? routes : []) {
    if (typeof r !== "string" || !r.startsWith("/")) continue;
    const ts = r.split(/[?#]/)[0].split("/").filter(Boolean);
    if (ts.length !== segs.length) continue;
    let literal = 0;
    let ok = true;
    for (let i = 0; i < ts.length && ok; i++) {
      if (/^(:.+|\*|\{.+\}|\[.+\])$/.test(ts[i])) continue;
      if (ts[i] === segs[i]) literal += 1;
      else ok = false;
    }
    if (ok && literal > most) {
      best = `/${ts.join("/")}`;
      most = literal;
    }
  }
  const idLike = (s) => /^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || /^[0-9a-f]{16,}$/i.test(s) || /\d{3,}/.test(s) || /[-_.:~]\d|\d[-_.:~]/.test(s) || (s.length >= 20 && /[A-Za-z]/.test(s) && /\d/.test(s));
  return (best ?? `/${segs.map((s) => (idLike(s) ? ":id" : s)).join("/")}`).replace(/[\s|]/g, "_").slice(0, 200);
}

/** A page expression → the most data rows a table or grid in `main` holds (decision 16: 10 or more make a screen `data`). */
export const MAIN_ROWS = `(() => {
  const root = document.querySelector("main, [role=main]") || document.body;
  let most = 0;
  for (const t of root ? root.querySelectorAll("table, [role=grid], [role=table], [role=treegrid]") : []) {
    let n = 0;
    for (const r of t.querySelectorAll("tr, [role=row]")) if (r.querySelector("td, [role=gridcell], [role=cell]")) n += 1;
    most = Math.max(most, n);
  }
  return most;
})()`;

/**
 * The recorder, run in the daemon after the observation `o` (the source of `async (page, o, T) => answer`): the same
 * state as the last observation (`T.prev`, the sha256 of its URL and ARIA snapshot, as the loop rule hashes it) →
 * `{changed: false}`, the buffer left as it is, so the next screen of the document gets its events (an action and
 * its change can fall in two observations). Else the ease probe's `screen` kind first (`T.ease` with `T.easeArg`:
 * the bar's vague terms and the owner's labels; no palette probe, which would type on the explorer's page), the AI
 * probe's `screen` kind (`T.ai`, when the payload names it: what the document's AI-surface recorder counted, read,
 * never acted), then the taste events drained (TASTE_DRAIN). Then the screen: its route template, width and theme
 * (MEDIA_READ); one viewport screenshot per screen key not yet shot this run (its name the
 * first 32 hex digits of the key's sha256, written under `T.shots`, its verdict's text read by `T.read` (SHOT_READ, a
 * stage body of `page`), a text past `T.maxText` unread), taken before anything else touches the page; the census
 * (`T.census`, the source of argus-live-taste.mjs censusOf, with `other: false`: the page's own scheme only, its
 * media never switched on the explorer's page, so `themed` is always false: the other scheme and reduced motion are
 * the confirmation replay's to measure, on a fresh instance); the rows of `main`'s largest table (`T.rows`). Every read
 * runs in the recorders' own world (`T.world`, argus-live-world.mjs WORLD_EVAL, which also hands the probes the
 * requests the driver timed), the page's own only without it. A probe that throws is a `faults` entry, never a failure.
 */
export const RECORDER = `async (page, o, T) => {
  const t0 = Date.now();
  // Reads go to the recorders' own world (T.world, argus-live-world.mjs WORLD_EVAL); to the page's only for a payload without one.
  const W = T.world ? new Function("return " + T.world)() : null;
  const ev = (expr) => (W ? W(page, expr) : page.evaluate(expr));
  const hex = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  if ((await hex((o.url ?? "") + "\\n" + (o.aria ?? ""))) === T.prev) return { changed: false };
  const u = new URL(page.url());
  if (u.protocol !== "http:" && u.protocol !== "https:") return { changed: true, skipped: true };
  const faults = [];
  let ease = null;
  try {
    ease = await ev("(" + T.ease + ")(" + JSON.stringify(T.easeArg) + ")");
  } catch (e) {
    faults.push("ease");
  }
  let ai = null;
  if (T.ai) {
    try {
      ai = await ev("(" + T.ai + ")(" + JSON.stringify(T.aiArg) + ")");
    } catch (e) {
      faults.push("ai");
    }
  }
  const drained = await ev(T.drain);
  const route = (${routeTemplate.toString()})(u.pathname, T.routes);
  const media = await ev(T.media);
  const vp = page.viewportSize();
  const width = vp && vp.width ? vp.width : await ev("innerWidth");
  const read = new Function("page", "return (async () => {\\n" + T.read + "})();");
  const taken = new Set(T.taken);
  const shoot = async (theme) => {
    const name = (await hex(route + "|" + width + "|" + theme)).slice(0, 32);
    if (taken.has(name)) return null;
    taken.add(name);
    try {
      await page.screenshot({ path: T.shots + "/" + name + ".png", type: "png" });
    } catch (e) {
      faults.push("shot");
      return null;
    }
    let verdict = null;
    try {
      verdict = await read(page);
      if (String(verdict.text).length > T.maxText) verdict = { ...verdict, text: "", unread: true };
    } catch (e) {
      verdict = null;
    }
    return { theme, name, verdict };
  };
  const shots = [await shoot(media.colorScheme)];
  let taste = null;
  try {
    taste = await new Function("return " + T.census)()(page, { other: false, evaluate: ev });
  } catch (e) {
    faults.push("census");
  }
  let rows = 0;
  try {
    rows = await ev(T.rows);
  } catch (e) {
    faults.push("rows");
  }
  return { changed: true, route, width, theme: media.colorScheme, taste, ease, ai, rows, themed: false, events: drained.events, dropped: drained.dropped, shots: shots.filter(Boolean), faults, ms: Date.now() - t0 };
}`;

/**
 * The observation's run-code for `payload` (loginCode's `observe` stage, byte for byte when `T` is null); with `T`
 * (the recorder's payload), the stage first, then RECORDER bounded by `T.limitMs` and its answer by `T.maxBytes`,
 * caught whole: the observation's answer gains `taste` (the recorder's, or `{failed: "timeout"|"error"|"too
 * large"}`) and is otherwise the stage's, so recording can never fail an observation or lose its drain.
 */
export function observeCode(payload, T = null) {
  const observe = loginCode("observe", payload);
  if (!T) return observe;
  return `async page => {
  const observed = await (${observe.trimEnd()})(page);
  const T = ${JSON.stringify(T)};
  const record = ${RECORDER};
  let taste;
  try {
    taste = await Promise.race([record(page, observed, T), new Promise((ok) => setTimeout(() => ok({ failed: "timeout" }), T.limitMs))]);
  } catch (e) {
    taste = { failed: "error" };
  }
  try {
    if (JSON.stringify(taste).length > T.maxBytes) taste = { failed: "too large" };
  } catch (e) {
    taste = { failed: "error" };
  }
  return { ...observed, taste };
}
`;
}

/** Scrub's `shot` stage (the text a screenshot's verdict reads), run by the recorder on the page it just shot. */
export const SHOT_READ = loginStageSource("shot");

/**
 * The scripts a session hooks into every page's own world: the lane's init payload (the signal script), with the
 * perf observers in a perf pass. The taste recorders go in a world of their own (the hook's `world`), never in a perf
 * pass, so their observers never weigh on what it times (INP, long tasks).
 */
export const hookSignals = (perf) => (perf ? `${SIGNAL_SCRIPT};\n${PERF_SCRIPT}` : PAGE_INIT);

/** The scrub verdict reasons that keep a shot from the Curator, and where such a shot goes: beside the run's taste/, never in it. */
const HELD = ["secret", "password-field", "one-time-code-field"];
const heldDir = (main, runId) => path.join(liveDir(main), runId, "held-shots");

/** The recorder's answers that are a harness event of the taste pass (in `<run>/taste/<slot>/harness.jsonl`, never the explorer's output). */
const RECORD_FAULTS = ["timeout", "error", "too large", "no answer", "bad screen", "write failed"];

/**
 * Keeps recording `answer` of account `at.account` in slot `at.slot` (journey `at.journey`) of run `runId`, after the
 * observation's drain was kept: a new screen is one line of `<run>/taste/<slot>/screens.jsonl` (0600) `{v: 1, t,
 * journey, slot, account, key, route, width, theme, rows, themed, taste, ease, ai, events, dropped, shots: [{theme, name,
 * key}], faults}` (`taste` censusOf's `{media, light, dark, reduce, themes}`, as the probe's rulesFor reads it) (events of a shape tasteEventFault refuses dropped and counted), each new shot made
 * 0600 with its scrub verdict beside it, and its time added to the budget. A failed or missing answer is a line of
 * `harness.jsonl` `{t, account, why}`. Never throws.
 */
export function keepScreen(main, runId, at, answer) {
  const base = tasteDir(main, runId);
  const dir = path.join(base, String(at.slot));
  const harness = (why) => {
    try {
      privateDir(dir);
      appendPrivate(path.join(dir, "harness.jsonl"), { t: Date.now(), account: at.account, why: RECORD_FAULTS.includes(why) ? why : "error" });
    } catch {
      // nowhere left to say it
    }
  };
  if (!isObj(answer)) return harness("no answer");
  if (answer.failed !== undefined) return harness(answer.failed);
  if (answer.changed !== true || answer.skipped === true) return;
  try {
    const key = `${answer.route}|${answer.width}|${answer.theme}`;
    if (typeof answer.route !== "string" || !SCREEN_KEY.test(key)) return harness("bad screen");
    const events = [];
    let dropped = Number.isInteger(answer.dropped) && answer.dropped >= 0 ? answer.dropped : 0;
    for (const e of Array.isArray(answer.events) ? answer.events : []) {
      if (tasteEventFault(e) === null) events.push(e);
      else dropped += 1;
    }
    const shots = [];
    for (const s of Array.isArray(answer.shots) ? answer.shots : []) {
      // Only the shot named as its screen key locks it (shotName): any other name is no shot of this screen.
      if (!isObj(s) || !["light", "dark"].includes(s.theme) || s.name !== shotName(`${answer.route}|${answer.width}|${s.theme}`)) continue;
      const png = path.join(base, "shots", `${s.name}.png`);
      if (!fs.lstatSync(png, { throwIfNoEntry: false })?.isFile()) continue;
      fs.chmodSync(png, 0o600);
      const v = writeVerdict(main, runId, png, isObj(s.verdict) ? s.verdict : null, { drained: true });
      // A shot scrub holds (a secret, a password or one-time-code field) leaves taste/: the Curator never reads it.
      if (v.reasons.some((r) => HELD.includes(r))) {
        const held = heldDir(main, runId);
        privateDir(held);
        for (const f of [png, png.replace(/\.png$/, ".verdict.json")]) fs.renameSync(f, path.join(held, path.basename(f)));
        continue;
      }
      shots.push({ theme: s.theme, name: s.name, key: `${answer.route}|${answer.width}|${s.theme}` });
    }
    const pick = (k) => (answer[k] === undefined ? null : answer[k]);
    privateDir(dir);
    appendPrivate(path.join(dir, "screens.jsonl"), {
      v: 1,
      t: Date.now(),
      journey: at.journey,
      slot: at.slot,
      account: at.account,
      key,
      route: answer.route,
      width: answer.width,
      theme: answer.theme,
      rows: Number.isInteger(answer.rows) && answer.rows >= 0 ? answer.rows : 0,
      themed: answer.themed === true,
      taste: pick("taste"),
      ease: pick("ease"),
      ai: pick("ai"),
      events,
      dropped,
      shots,
      faults: (Array.isArray(answer.faults) ? answer.faults : []).filter((f) => ["census", "ease", "ai", "rows", "shot"].includes(f)),
    });
    spendTaste(main, runId, "record", answer.ms);
  } catch {
    harness("write failed");
  }
}

let confirmSinkNow = null;
/** The taste confirmation's sink a slot `r` driver made now runs its steps through, or null. */
export const activeConfirm = () => confirmSinkNow;
/**
 * Runs `fn` (a confirmation replay: runOnce) with `sink` the taste pass's active one → its result; the one before it
 * is restored. While it is active, a driver of slot `r` (outside a perf pass) arms `sink.arm` (a code text, or null)
 * right after its hook, and runs every step's code as `sink.wrap(code)`, its answer through `sink.take(answer)`
 * (argus-live-tastejudge.mjs confirmSink).
 */
export async function confirming(sink, fn) {
  const before = confirmSinkNow;
  confirmSinkNow = sink;
  try {
    return await fn();
  } finally {
    confirmSinkNow = before;
  }
}

/** How long the recorder may take after an observation, and how much it may answer (a shot's text past maxText is unread). */
const RECORD_LIMITS = { maxBytes: 400_000, maxText: 150_000 };

/**
 * The driver's views of the taste pass: recording runs for an explorer's slot (a positive integer) of a journey,
 * outside a perf pass and a confirmation replay, while the run's taste time is under TASTE_BUDGET_MS → the
 * recorder's payload with `prev` (the last observation's state hash), or null (the plain observation).
 */
export function recorderPayload({ main, runId, slot, slotRec, prev, settleMs }) {
  if (!Number.isInteger(slot) || slot < 1 || !isObj(slotRec) || typeof slotRec.journey !== "string" || slotRec.mode === "map") return null;
  try {
    if (tasteSpent(main, runId) >= TASTE_BUDGET_MS) return null;
    const taste = loadTaste(main).taste;
    if (tasteOff(taste)) return null;
    const shots = path.join(tasteDir(main, runId), "shots");
    privateDir(shots);
    let routes = [];
    try {
      routes = [...new Set((readJourneys(main)?.journeys ?? []).flatMap((j) => j.steps.map((s) => s.route)).filter((r) => typeof r === "string"))].slice(0, 500);
    } catch {
      routes = [];
    }
    const held = heldDir(main, runId);
    const taken = [...fs.readdirSync(shots), ...(fs.existsSync(held) ? fs.readdirSync(held) : [])].filter((f) => /^[0-9a-f]{32}\.png$/.test(f)).map((f) => f.slice(0, 32));
    const limitMs = Math.min(30_000, Math.max(5_000, 2 * settleMs));
    // The ease probe's screen kind as T2 measures a screen: the bar's vague terms per language, the owner's own labels.
    const terms = (loadBar().rules.find((r) => r.id === "copy.vague") ?? {}).terms ?? {};
    const vague = (taste ?? { copy: { vague: [] } }).copy.vague;
    return { prev: prev ?? null, routes, world: WORLD_EVAL, census: String(censusOf), ease: EASE_SOURCE, easeArg: { kind: "screen", terms, vague }, ai: AIUX_SOURCE, aiArg: { kind: "screen" }, media: MEDIA_READ, drain: TASTE_DRAIN, rows: MAIN_ROWS, read: SHOT_READ, shots, taken, limitMs, ...RECORD_LIMITS };
  } catch {
    return null;
  }
}

/**
 * The driver of account `account`'s session in slot `slot` of run `runId` (`rec` its run.json as the
 * caller read it, `live` the expanded config, `envSecrets` the env_file's values, `slotRec` the slot's
 * run.json record, `dir` the slot's directory, `js` the installed CLI) → `{name, plan, role, state,
 * credentials, fresh, byCommand, wantsSignIn, cli, stage, code, ensure, signIn, gone, reopen, observe, relogin}`:
 * - `state`: the account's `{signedIn, lastState, consoleSeen}` from the slot's state.json, replaced by
 *   `{signedIn}` when the session opens again; the caller saves it.
 * - `credentials()`: those of an account the journey created and signed in with `login` (the slot's
 *   state.json `created`), else its allocated user's (`created: false`), else null; `credentials` (a
 *   parameter) replaces it.
 * - `fresh`: the account is one the journey creates (allocated CREATED, `<role>.<k>=+`): it has no configured
 *   user, its session starts signed out even in a login-command role (`byCommand` is false for it), and it is
 *   signed in only by its `login` (`wantsSignIn()` is true once that left credentials, for a re-login).
 * - `cli(args, timeoutMs)`: one CLI call in the slot's directory, under the run's browser HOME;
 *   `stage(which, payload)` a login stage (loginCode) and `code(text, timeoutMs)` a template the caller
 *   built, each through runCode. A driver made while a perf pass measures (argus-live-perf's activeSink)
 *   hooks the perf script beside the signal script, and its `code` is measured (perf's `measure`): a snapshot
 *   after load, the step, a snapshot of what it left; a stage never is. A slot `r` driver made while a taste
 *   confirmation replays (confirming) arms the sink's fault after its hook and runs its `code` through the sink.
 * - `observe()` in an explorer's slot also records the screen for the taste pass (recorderPayload, keepScreen).
 * - `ensure()` → `{record, opened, events}`: the recorded session with a daemon, else one opened now
 *   (stillLive; a login-command role's with the storage state commandLogin wrote, which signs it in;
 *   openSession) and hooked: the `hook` stage with the run's origins, the signal script and `capBytes`
 *   (the bytes of distinct header values its context records); a hook that failed is `harness: hook
 *   failed` among `events`, and the session is used all the same — its headers unrecorded, so the
 *   ledger is marked incomplete, `<session> unhooked` (unless `markUnhooked` is false: a caller that
 *   never uses an unhooked session).
 * - `signIn(c)` → login's answer (`failures`, when given, records a created account's failures);
 *   `state.signedIn` set on success.
 * - `gone(res, record)`: the command failed and the CLI said the browser is not open, or the recorded
 *   daemon no longer runs.
 * - `reopen(record)` → events: the session closed and opened again (and hooked), signed in unless anon or
 *   a login-command role (`session-reopened: <role.k>`, and `harness: login failed` when that failed); a
 *   session lost while undrained (`state.drained` false: a command ran since its last drain) marks the
 *   ledger incomplete (`<session> lost before its drain`).
 * - `observe()` → `{o, events}`: the observe stage (signals, logged_in, URL, aria, the drain); the drain
 *   kept (keepDrain: the ledger, `seen.jsonl`) and `state.drained` set; `state.lastState` the hash the
 *   loop rule reads; a failure → `harness: observation failed`, the account left undrained.
 * - `relogin(o)` → events: when `o` lacks logged_in while the account is signed in, a probe tab at the
 *   role's base_url (`probed: <role.k>`, logged to `logs/probes.jsonl`), and when it lacks it too, one
 *   sign-in (`re-logged-in: <role.k>` or `harness: login failed`; a login-command role's session is
 *   closed and opened again).
 */
export function sessionDriver({ main, runId, slot, account, rec, live, envSecrets, slotRec, dir, js, credentials = null, failures = null, capBytes = CAP_BYTES, markUnhooked = true, runner = run, cliRunner = runAsync }) {
  const role = account.split(".")[0];
  const r = live.roles && live.roles[role];
  const plan = loginPlan(live, role);
  const fresh = isObj(slotRec.accounts) && slotRec.accounts[account] === CREATED;
  const byCommand = Boolean(r && r.login) && !fresh;
  const name = sessionName(runId, slot, account);
  const home = () => browserHome(rec);
  const perf = activeSink();
  const confirm = slot === "r" && !perf ? confirmSinkNow : null;
  let record = null;
  const d = {
    name,
    plan,
    role,
    fresh,
    byCommand,
    state: { ...((readSlotState(dir).sessions ?? {})[account] ?? {}) },
    credentials:
      credentials ??
      (() => {
        const c = (readSlotState(dir).created ?? {})[account];
        if (c && typeof c.user === "string" && typeof c.password === "string") return { user: c.user, password: c.password, totpSecret: null, created: true };
        if (fresh) return null;
        const u = ((r && r.users) || []).find((x) => x && x.user === slotRec.accounts[account]);
        return u ? { user: u.user, password: u.password, totpSecret: u.totp_secret ?? null, created: false } : null;
      }),
    cli: (args, timeoutMs = plan.settleMs + 60_000) => runCli({ js, session: name, args, cwd: dir, home: home(), timeoutMs, runner: cliRunner }),
    stage: (which, payload) => raw(loginCode(which, payload)),
  };
  const raw = (text, timeoutMs = 4 * plan.settleMs + 60_000) => runCode({ js, session: name, cwd: dir, home: home(), code: text, timeoutMs, runner: cliRunner });
  d.code = perf ? measure(perf, { account, raw, waitMs: plan.settleMs }) : confirm ? async (text, timeoutMs) => confirm.take(await raw(confirm.wrap(text), timeoutMs)) : raw;
  /** Opens the session (a login-command role's with a fresh storage state, which signs it in) and hooks it → the hook's events. */
  const open = async () => {
    stillLive(main, runId); // an up --fresh or a down may have begun while this call waited
    // The page's init payload as this session needs it (a perf pass measures the app alone: no taste recorder).
    writeInitPayload(dir, perf ? SIGNAL_SCRIPT : PAGE_INIT);
    let storageState = null;
    if (byCommand) storageState = await commandLogin({ role, live, env: rec.env, worktree: rec.worktree, secrets: envSecrets, origins: rec.origins ?? [], dir, runner: cliRunner });
    record = await openSession({ main, runId, slot, account, js, home: home(), storageState, runner, cliRunner });
    d.state = { signedIn: Boolean(storageState) };
    const runOrigins = [...new Set([...(rec.origins ?? []), ...(rec.allowOrigins ?? [])].map((o) => new URL(o).origin))];
    try {
      await d.stage("hook", { runOrigins, signals: hookSignals(perf), world: perf ? null : TASTE_WORLD, capBytes });
      // A confirmation replay's routed fault is armed before the session's first navigation (Task 0.1).
      if (confirm && confirm.arm) await raw(confirm.arm);
      return [];
    } catch {
      if (markUnhooked) appendLedger(main, runId, [{ c: "incomplete", v: `${name} unhooked` }]);
      return ["harness: hook failed"];
    }
  };
  d.ensure = async () => {
    const found = (rec.sessions ?? []).find((x) => x && x.name === name && x.daemon);
    if (found) {
      record = found;
      return { record, opened: false, events: [] };
    }
    const events = await open();
    return { record, opened: true, events };
  };
  /** True when the wrapper signs this session in by itself: not anon's, not a login command's, and a created account only once its `login` left credentials. */
  d.wantsSignIn = () => role !== "anon" && !byCommand && (!fresh || d.credentials() !== null);
  /** Signs the open session in with the account's credentials (loginRetry: one retry of a retryable reason, none of a failed account) → its answer. */
  d.signIn = async (c = d.credentials()) => {
    const res = c ? await loginRetry({ main, runId, session: name, account, user: c.user, password: c.password, totpSecret: c.totpSecret, plan, js, home: home(), cwd: dir, runner: cliRunner, ...(c.created && failures ? { failures } : {}) }, { spacingMs: live.login_spacing_ms }) : { ok: false, reason: "rejected" };
    if (res.ok) d.state.signedIn = true;
    return res;
  };
  d.gone = (res, session) => res.code !== 0 && (NOT_OPEN.test(`${res.stdout}\n${res.stderr}`) || !sessionAlive(session, runner));
  d.reopen = async (session) => {
    if (d.state.drained === false) appendLedger(main, runId, [{ c: "incomplete", v: `${name} lost before its drain` }]);
    await closeSessions([session], { js, runner, cliRunner, graceMs: 3000 });
    const hooked = await open();
    const events = [`session-reopened: ${account}`, ...hooked];
    if (!d.state.signedIn && d.wantsSignIn() && !(await d.signIn()).ok) events.push("harness: login failed");
    return events;
  };
  d.observe = async () => {
    let o = null;
    const events = [];
    const payload = { loggedIn: role === "anon" ? null : plan.loggedIn };
    const T = perf ? null : recorderPayload({ main, runId, slot, slotRec, prev: d.state.lastState, settleMs: plan.settleMs });
    try {
      o = await raw(observeCode(payload, T));
    } catch {
      events.push("harness: observation failed");
    }
    let screen;
    if (o && typeof o === "object" && T) {
      screen = o.taste;
      delete o.taste;
    }
    if (o && typeof o === "object") {
      d.state.lastState = sha256(`${o.url ?? ""}\n${o.aria ?? ""}`);
      keepDrain(main, runId, name, o.secrets, capBytes);
      d.state.drained = true;
      // Recorded once the drain is kept: a shot's verdict reads the ledger that drain fed.
      if (T) keepScreen(main, runId, { slot, account, journey: slotRec.journey }, screen);
    }
    return { o, events };
  };
  d.relogin = async (o) => {
    const events = [];
    if (!(o && o.loggedIn === false && role !== "anon" && d.state.signedIn)) return events;
    // The probe tab's request is the wrapper's: told outside the fence and logged with its times.
    const start = Date.now();
    let probe = null;
    try {
      probe = await d.stage("probe", { url: plan.base, loggedIn: plan.loggedIn, settleMs: plan.settleMs });
    } catch {
      probe = null;
    }
    events.push(`probed: ${account}`);
    logProbe(main, runId, { slot, account, url: plan.base, start, end: Date.now() });
    if (!probe) events.push("harness: probe failed");
    if (probe && !probe.in) {
      d.state.signedIn = false;
      let ok = false;
      try {
        if (byCommand) {
          await closeSessions([record], { js, runner, cliRunner, graceMs: 3000 });
          events.push(...(await open()));
          ok = d.state.signedIn;
        } else ok = (await d.signIn()).ok;
      } catch {
        ok = false;
      }
      events.push(ok ? `re-logged-in: ${account}` : "harness: login failed");
    }
    return events;
  };
  return d;
}
