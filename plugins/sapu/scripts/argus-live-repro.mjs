// argus-live-repro.mjs — the repro runner (spec §10 "Reproduce"; decisions 2–4, 6, 8, 11–13, 26): one run
// of a candidate's repro on a freshly reset instance, or of a smoke path (spec §19.4) with its PATH verdict. Its steps are data (argus-live-steps.mjs); every
// browser step runs as the wrapper's own `run-code` template in slot `r`'s sessions, through the session
// driver, proxy and per-slot config an explorer's use; its answer is an exit code — 0 not reproduced, 3
// reproduced, 2 a harness failure — and lines in the wrapper's own words, what the page showed fenced.
// `repro` runs it twice and files only at two of two (decision 9); argus-live-minimize.mjs, above it,
// minimizes a reproduced candidate and writes its RED test.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { slotConfig, slotDir, writeSlotConfig } from "./argus-live-browser.mjs";
import { closeSessions, removeSockets } from "./argus-live-cli.mjs";
import { expandConfig, loadLive } from "./argus-live-config.mjs";
import { clean, fence } from "./argus-live-fence.mjs";
import { runHook } from "./argus-live-hooks.mjs";
import { upFresh } from "./argus-live-instance.mjs";
import { appendLedger } from "./argus-live-ledger.mjs";
import { liveDir, readLock } from "./argus-live-lock.mjs";
import { checkUrl } from "./argus-live-origin.mjs";
import { run, runAsync, sleep, tempBeside } from "./argus-live-proc.mjs";
import { readRun, updateRun } from "./argus-live-run.mjs";
import { REF } from "./argus-live-scrub.mjs";
import { CAP_BYTES, configuredUser, keepDrain, maskSecrets, sessionDriver } from "./argus-live-session.mjs";
import { readSlotState, slotLockWaitMs, withSlotLock, writeSlotState } from "./argus-live-slots.mjs";
import { CLICKS, parseRepro, provingExpect, stepCode, substitute, suiteAccounts } from "./argus-live-steps.mjs";
import { targetCode } from "./argus-live-targets.mjs";

/** What a failed expectation may say it observed (decision 8): enums and integers only. */
const OBSERVED = /^(absent|hidden|visible|disabled|differs|errors:\d+|count:\d+)$/;
/** The expectation kinds the browser judges (the others run through runHook, or read the error buffer). */
const HOOK_EXPECTS = ["fact-equals", "mail"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** A harness failure: the run ends with exit 2 and `HARNESS: <message>`. */
class Harness extends Error {}

/** A path's action that broke (spec §19.9): the run ends with exit 3 and `PATH broke step=<n> kind=<kind>`. */
class Broke extends Error {
  constructor(step, kind) {
    super(`step ${step} ${kind}`);
    Object.assign(this, { step, kind });
  }
}

/** A path's action failure → its break kind: no match, several, or the action itself. */
const breakOf = (why) => (why === "missing-target" ? "target-missing" : why === "ambiguous-target" ? "target-ambiguous" : "action-failed");

/**
 * Smoke path `path` (`{id, list}`: a journey id and its DSL list) of the lock's run → `{runId, slotRec, dir}`
 * as reproRef gives a candidate's: `slotRec` holds the journey (its accounts are the suite's, set once
 * live.json is read), `dir` the path's records `.argus/live/<run>/smoke/<id>/`. Refused: another shape, no cycle.
 */
function pathRef(main, p) {
  if (!isObj(p) || typeof p.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(p.id) || !Array.isArray(p.list)) throw new Error("refused: a path is {id, list}: a journey id and its steps");
  const lock = readLock(main);
  if (!lock) throw new Error("refused: no journey cycle is running");
  return { runId: lock.runId, candidate: null, slotRec: { journey: p.id, accounts: {} }, dir: path.join(liveDir(main), lock.runId, "smoke", p.id) };
}

/**
 * Candidate `ref` (`<slot>.<generation>.<k>`) of the lock's run → `{runId, slot, generation, k, candidate,
 * slotRec, dir}`: the candidate read from `returns/<slot>.<generation>.json` (the orchestrator never
 * re-types a repro), the slot's run.json record (its allocation), and the candidate's record directory
 * `.argus/live/<run>/repro/<ref>/` (decision 2). Refused: a ref of another shape, no cycle, `refused:
 * repro: no return <slot>.<generation>`, `refused: repro: return <slot>.<generation> has no candidate <k>`.
 */
export function reproRef(main, ref) {
  const m = typeof ref === "string" ? REF.exec(ref) : null;
  if (!m) throw new Error(`refused: repro: ${typeof ref === "string" && /^[\x20-\x7e]{1,40}$/.test(ref) ? ref : "that"} is not <slot>.<generation>.<k>`);
  const lock = readLock(main);
  if (!lock) throw new Error("refused: no journey cycle is running");
  const runId = lock.runId;
  const [slot, generation, k] = [m[1], m[2], m[3]].map(Number);
  let ret = null;
  try {
    ret = JSON.parse(fs.readFileSync(path.join(liveDir(main), runId, "returns", `${slot}.${generation}.json`), "utf8"));
  } catch {
    ret = null;
  }
  if (!isObj(ret)) throw new Error(`refused: repro: no return ${slot}.${generation}`);
  const candidate = Array.isArray(ret.candidates) ? ret.candidates[k - 1] : undefined;
  if (!isObj(candidate)) throw new Error(`refused: repro: return ${slot}.${generation} has no candidate ${k}`);
  const rec = readRun(main);
  const slotRec = rec && rec.runId === runId && rec.slots ? rec.slots[String(slot)] : null;
  if (!isObj(slotRec) || !isObj(slotRec.accounts)) throw new Error(`refused: repro: slot ${slot} was never minted in cycle ${runId}`);
  return { runId, slot, generation, k, candidate, slotRec, dir: path.join(liveDir(main), runId, "repro", ref) };
}

/** Every file under `dir`, as paths relative to it (none when it is missing). */
function filesUnder(dir) {
  const out = [];
  const walk = (rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(rel, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk("");
  return out.sort();
}

/**
 * The digest of what failed final `step` showed (`shown`), the values of the placeholders the final names
 * (`{{marker}}`, a saved record id) put back as those placeholders: two runs that fail a final the same way
 * have the same one, whatever marker or id each made.
 */
function shownDigest(shown, step, vars) {
  let text = JSON.stringify(shown ?? null);
  const used = new Set([...JSON.stringify(step).matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map((m) => m[1]));
  const names = [...used].filter((k) => Object.hasOwn(vars, k) && String(vars[k]) !== "").sort((a, b) => String(vars[b]).length - String(vars[a]).length);
  for (const k of names) text = text.split(JSON.stringify(String(vars[k])).slice(1, -1)).join(`{{${k}}}`);
  return createHash("sha256").update(text).digest("hex");
}

/** Writes `text` to `file` whole (beside, then renamed into place), mode 0600. */
export const writePrivate = (file, text) => fs.renameSync(tempBeside(file, text, 0o600), file);

/**
 * One run (number `i`) of candidate `ref`'s repro (`list` in its place when given: a minimizer's reduced
 * list) → `{code, lines, result}`, each line also given to `say` as it is made. In order:
 * 1. parseRepro against the slot's allocation (a refusal → exit 2 `HARNESS: repro: step <n>: <reason>`);
 * 2. an acting account in run.json `loginFailed` → exit 2 `HARNESS: <role>.<k> cannot sign in this cycle`
 *    (decision 4), no browser opened;
 * 3. `fresh(main)` (`up --fresh`; a failure at a step → exit 2 `HARNESS: up --fresh failed at <step>`),
 *    `fresh: instance <id>`;
 * 4. slot `r` (under its lock to the end): its CLI config with the repro's context, a fresh state.json;
 * 5. each step in order, a `parallel` group's actions spawned together behind a barrier 1500 ms ahead: the
 *    account's session on first use (opened and hooked, signed in unless `anon`, a login-command role or
 *    its first step is a `login`, then `tracing-start`), the step substituted, then the browser step's
 *    template through the driver (the account `drained: false` around it, the answer's drain kept), a
 *    `trigger`, `fact-equals` or `mail` through runHook (the facts and mail polled every 500 ms up to
 *    settle_ms), `no-error` from the account's errors since the previous step, a `login` per decision 26
 *    (the trace stopped, the user checked, the password in the ledger as `created password`, signed in
 *    with slot `r`'s `createdFailed` as its record, the trace started again). Exit 2: a missing target, an
 *    action that failed, a click-family step that changed state with no proving expect, an expectation
 *    before the final that failed, a session lost (logged_in gone on the page and in a probe), a login
 *    that failed;
 * 6. the final: held → exit 0 `NOT REPRODUCED`; failed → exit 3, what was expected and what the page
 *    showed in one nonce fence, then `REPRODUCED step=<n> expected=<kind>[:<number>] observed=<enum>`;
 * 7. always: each account's last drain (`observe`), `tracing-stop`, its session closed and dropped from
 *    run.json; `run-<i>.json` (`i` given, else numbered after the candidate's records: none is overwritten) `{exit, step, expected, observed, shownSha256, ms, saved, traces, changed,
 *    reduced}` (`shownSha256` the digest of what a failed final showed, `saved` masked, `traces` the trace
 *    files under `r/out/traces/` the run wrote, `changed` the click-family steps that changed state,
 *    `reduced` true for a run of a minimizer's `list`) and `steps-<i>.jsonl` (0600) written to the
 *    candidate's directory, with `repro.json` unless the run was given a `list`.
 * Any other throw → exit 2 `HARNESS: failed: <message, masked>`; a ref reproRef refuses is thrown as is.
 *
 * Path mode (spec §19.4, §19.9; `path` `{id, list}`, `ref` unused): the list parsed in path mode against the
 * suite's accounts (suiteAccounts), `dirty` skipping the `up --fresh` (`dirty: instance <id>`: the instance
 * as the last run left it); an action with no match, several or failing → exit 3 `PATH broke step=<n>
 * kind=target-missing|target-ambiguous|action-failed`, an expectation that fails (several matches included)
 * → its fence and exit 3 `PATH broke step=<n> kind=expect-failed`, every step held → exit 0 `PATH held`; the
 * harness's failures as above. Records under `.argus/live/<run>/smoke/<id>/`: `path.json` (the list and its
 * parse) and the numbered `run-<i>.json` (with `kind` and `dirty`) and `steps-<i>.jsonl`.
 */
export async function runOnce(main, ref, { list = null, i = null, path: smoke = null, dirty = false, fresh = upFresh, cli = null, runner = run, cliRunner = runAsync, say = () => {} } = {}) {
  const { runId, candidate, slotRec, dir } = smoke ? pathRef(main, smoke) : reproRef(main, ref);
  const n = i ?? nextRun(dir);
  const started = Date.now();
  const lines = [];
  const emit = (l) => {
    lines.push(l);
    say(l);
  };
  const result = { exit: 2, step: null, expected: null, observed: null, shownSha256: null, ms: 0, saved: {}, traces: [], changed: [], reduced: list !== null, ...(smoke ? { kind: null, dirty } : {}) };
  const repro = smoke ? smoke.list : (list ?? candidate.repro);
  const created = [];
  const stepLog = [];
  let secrets = {};
  let parsed = null;
  const drivers = new Map();
  let js = null;
  let rdir = null;
  let tracesBefore = null;
  try {
    const { config, errors, secrets: envSecrets } = loadLive(main);
    if (!config || errors.length) throw new Error(`failed: .argus/live.json: ${errors.join("; ")}`);
    let rec = readRun(main);
    if (!rec || rec.runId !== runId) throw new Error(`failed: run.json does not name cycle ${runId}`);
    const live = expandConfig(config, { ports: { ...(rec.ports ?? {}) }, secrets: envSecrets });
    const mask = () => ({ ...maskSecrets(main, config, live, { created: {} }), ...Object.fromEntries(created.map((p, j) => [`created:repro.${j}`, p])) });
    secrets = mask();
    if (smoke) slotRec.accounts = suiteAccounts(live);
    try {
      parsed = parseRepro(repro, { accounts: slotRec.accounts, live, path: Boolean(smoke) });
    } catch (e) {
      if (!/^refused: /.test(e.message)) throw e;
      throw new Harness(e.message.replace(/^refused: /, ""));
    }
    const { context, steps } = parsed;
    const firstOf = new Map();
    for (const s of steps) if (s.as !== "system" && !firstOf.has(s.as)) firstOf.set(s.as, s);
    for (const [a, first] of firstOf) {
      const role = a.split(".")[0];
      const user = slotRec.accounts[a];
      if (role === "anon" || first.do === "login" || typeof user !== "string") continue;
      if (rec.loginFailed && Object.hasOwn(rec.loginFailed, `${role}/${user}`)) throw new Harness(`${a} cannot sign in this cycle`);
    }
    const settleMs = live.settle_ms ?? 10_000;
    const code = await withSlotLock(
      main,
      runId,
      "r",
      async () => {
        if (dirty) emit(`dirty: instance ${rec.instanceId}`);
        else {
          try {
            const summary = await fresh(main, { runner });
            emit(`fresh: instance ${summary.instanceId}`);
          } catch (e) {
            if (e && e.step) throw new Harness(`up --fresh failed at ${e.step}`);
            throw e;
          }
        }
        rec = readRun(main);
        const ifLive = { main, runId };
        rdir = slotDir(main, runId, "r");
        const view = { ...live, locale: context.locale, timezone: context.timezone, viewports: [context.viewport] };
        writeSlotConfig(rdir, slotConfig({ dir: rdir, origins: rec.origins ?? [], allowOrigins: rec.allowOrigins ?? [], proxyPort: rec.internal && rec.internal.proxy, live: view, chrome: { channel: rec.browser && rec.browser.channel } }));
        fs.rmSync(path.join(rdir, "state.json"), { force: true });
        writeSlotState(rdir, readSlotState(rdir), ifLive);
        tracesBefore = new Set(filesUnder(path.join(rdir, "out", "traces")));
        js = cli ?? (rec.browser && rec.browser.js);
        if (typeof js !== "string" || !fs.existsSync(js)) throw new Error("failed: the browser CLI is not installed (run.json names none, or it is gone)");
        const runOrigins = [...new Set([...(rec.origins ?? []), ...(rec.allowOrigins ?? [])].map((o) => new URL(o).origin))];
        // A created account's failed sign-ins are kept in slot r's state.json, never in run.json `loginFailed`.
        const createdFailures = {
          get: (key) => {
            const f = readSlotState(rdir).createdFailed ?? {};
            return Object.hasOwn(f, key) ? f[key] : null;
          },
          set: (key, reason) => {
            const cur = readSlotState(rdir);
            writeSlotState(rdir, { ...cur, createdFailed: { ...(cur.createdFailed ?? {}), [key]: reason } }, ifLive);
          },
        };
        const save = (u, extra = {}) => {
          const after = readSlotState(rdir);
          writeSlotState(rdir, { ...after, ...extra, sessions: { ...(after.sessions ?? {}), [u.account]: u.d.state } }, ifLive);
        };
        const traceStart = async (u) => {
          u.tracing = (await u.d.cli(["tracing-start"], 30_000)).code === 0;
        };
        const traceStop = async (u) => {
          if (u.tracing) await u.d.cli(["tracing-stop"], 60_000);
          u.tracing = false;
        };
        /** Account `a`'s session for step `n`: on first use opened and hooked, signed in (unless anon, a login-command role or a first step that is a login), then traced. */
        const use = async (a, n) => {
          if (drivers.has(a)) return drivers.get(a);
          // An unhooked session is never used here (a HARNESS at once), so the ledger needs no mark for it.
          const d = sessionDriver({ main, runId, slot: "r", account: a, rec, live, envSecrets, slotRec, dir: rdir, js, failures: createdFailures, markUnhooked: false, runner, cliRunner });
          const u = { account: a, d, record: null, tracing: false };
          drivers.set(a, u);
          const { record, events } = await d.ensure();
          u.record = record;
          if (events.length) throw new Harness(`step ${n} ${a} hook failed`);
          if (d.role !== "anon" && firstOf.get(a).do !== "login" && !d.state.signedIn) {
            d.state.drained = false; // the sign-in runs in the hooked context: its values wait for the next drain
            if (!(await d.signIn()).ok) throw new Harness(`${a} cannot sign in this cycle`);
          }
          save(u);
          await traceStart(u);
          return u;
        };
        /** True when `a`'s session lost its sign-in: logged_in gone from the page and from a probe tab at the role's base_url. */
        const lost = async (a) => {
          const u = drivers.get(a);
          if (!u || u.d.role === "anon" || !u.d.state.signedIn) return false;
          try {
            const { o } = await u.d.observe();
            save(u);
            if (!o || o.loggedIn !== false) return false;
            const p = await u.d.stage("probe", { url: u.d.plan.base, loggedIn: u.d.plan.loggedIn, settleMs: u.d.plan.settleMs });
            return !p.in;
          } catch {
            return false;
          }
        };
        const vars = { marker: `argus-${randomBytes(4).toString("hex")}` };
        const saved = result.saved; // filled as the steps read, so a harness failure keeps what was read
        const errs = new Map();
        const changed = new Set();
        /** A browser step's template run in its account's session, its drain kept and its counted errors in the account's buffer. */
        const browserStep = async (s, at = null) => {
          const u = await use(s.as, s.n);
          const sub = substitute(s, vars);
          if (sub.do === "goto") {
            try {
              sub.url = checkUrl(sub.path, { origins: rec.origins ?? [], base: u.d.plan.base });
            } catch {
              throw new Harness(`step ${s.n} goto is outside the run's origins`);
            }
          }
          u.d.state.drained = false;
          save(u);
          const t0 = Date.now();
          const ans = await u.d.code(stepCode(sub, { settleMs, at, runOrigins }));
          keepDrain(main, runId, u.d.name, ans && ans.drain, CAP_BYTES);
          u.d.state.drained = true;
          save(u);
          const list = errs.get(s.as) ?? [];
          for (const e of Array.isArray(ans && ans.errors) ? ans.errors : []) list.push({ n: s.n, kind: e.kind });
          errs.set(s.as, list);
          return { ...ans, sub, ms: Date.now() - t0 };
        };
        const log = (s, entry) => stepLog.push({ n: s.n, as: s.as, kind: s.do ?? s.expect, ...entry });
        const line = (s, word) => emit(`step ${s.n} ${s.as} ${s.do ?? s.expect}: ${word}`);
        /** An action's answer judged: a failure is the harness's; a click-family step that changed state needs its proving expect. */
        const acted = async (s, ans) => {
          log(s, { ok: ans.ok, why: ans.why ?? null, detail: ans.detail ?? null, changed: Boolean(ans.changed), method: ans.method ?? null, errors: (ans.errors ?? []).length, ms: ans.ms });
          if (!ans.ok) {
            line(s, "failed");
            if (await lost(s.as)) throw new Harness(`step ${s.n} ${s.as} lost its session`);
            if (smoke) throw new Broke(s.n, breakOf(ans.why));
            throw new Harness(ans.why === "missing-target" ? `step ${s.n} missing target` : `step ${s.n} ${s.do} failed (${ans.why === "timeout" ? "timeout" : "error"})`);
          }
          if (s.do === "read") saved[s.save] = vars[s.save] = String(ans.value ?? "");
          if (CLICKS.includes(s.do) && ans.changed) {
            changed.add(s.n);
            result.changed = [...changed];
          }
          line(s, changed.has(s.n) ? "changed-state" : "ok");
          if (changed.has(s.n) && provingExpect(steps, s.n, changed) === null) throw new Harness(`step ${s.n} changed state (a ${/^[A-Z]{1,16}$/.test(ans.method) ? ans.method : "non-GET"} request) with no proving expect`);
        };
        /** A hook polled every 500 ms up to settle_ms until `test` holds → `{held, observed, shown}`. */
        const poll = async (s, kind, values, test) => {
          const end = Date.now() + settleMs;
          let shown = null;
          for (;;) {
            let h;
            try {
              h = await runHook(kind, kind, values, { rec, live, runner: cliRunner });
            } catch (e) {
              if (/^refused: /.test(e.message)) throw new Harness(`step ${s.n} ${e.message.replace(/^refused: /, "")}`);
              throw e;
            }
            let v;
            try {
              v = JSON.parse(h.stdout);
            } catch {
              v = undefined;
            }
            const r = v === undefined ? null : test(v);
            if (r && r.held) return { held: true, observed: null, shown: r.shown };
            if (r) shown = r.shown;
            if (Date.now() >= end) return { held: false, observed: shown === null ? "absent" : "differs", shown };
            await sleep(500);
          }
        };
        /** An expectation of step `s` → `{held, observed, shown, detail}`. */
        const expectation = async (s) => {
          const sub = substitute(s, vars);
          if (s.expect === "fact-equals") {
            return poll(s, "facts", [sub.marker], (v) => (isObj(v) && Object.hasOwn(v, sub.field) ? { held: String(v[sub.field]) === String(sub.value), shown: v[sub.field] } : null));
          }
          if (s.expect === "mail") {
            return poll(s, "mail", [], (v) => (Array.isArray(v) ? { held: v.some((m) => m && m.to === sub.to && `${m.subject}\n${m.text}`.includes(sub.contains)), shown: v.length } : null));
          }
          const ans = await browserStep(s);
          if (s.expect === "no-error") {
            const since = (errs.get(s.as) ?? []).filter((e) => e.n >= s.n - 1);
            return { held: since.length === 0, observed: since.length ? `errors:${since.length}` : null, shown: since.map((e) => e.kind), sub };
          }
          return { ...ans, sub };
        };
        const finalFence = (s, ans) => {
          const sub = ans.sub ?? substitute(s, vars);
          const expected = { kind: s.expect, ...(sub.target ? { target: targetCode(sub.target) } : {}), ...(sub.value !== undefined ? { value: sub.value } : {}), ...(sub.marker !== undefined ? { marker: sub.marker, field: sub.field } : {}), ...(sub.to !== undefined ? { to: sub.to, contains: sub.contains } : {}) };
          const { body, truncated } = fence(`expected: ${JSON.stringify(expected)}\nobserved: ${JSON.stringify({ observed: ans.observed, shown: ans.shown ?? null })}`, { secrets });
          emit(body);
          if (truncated) emit(`truncated ${truncated} characters`);
        };

        let idx = 0;
        while (idx < steps.length) {
          const s0 = steps[idx];
          const batch = s0.group ? steps.filter((x) => x.group === s0.group) : [s0];
          idx += batch.length;
          if (batch.length > 1) {
            // Every account ready first (opened and signed in), then the actions behind one barrier.
            for (const s of batch) await use(s.as, s.n);
            const at = Date.now() + 1500;
            const answers = await Promise.all(batch.map((s) => browserStep(s, at)));
            for (const [j, s] of batch.entries()) await acted(s, answers[j]);
            continue;
          }
          const s = s0;
          if (s.do === "trigger") {
            const sub = substitute(s, vars);
            let h;
            try {
              h = await runHook("trigger", sub.name, sub.values, { rec, live, runner: cliRunner });
            } catch (e) {
              if (/^refused: /.test(e.message)) throw new Harness(`step ${s.n} ${e.message.replace(/^refused: /, "")}`);
              throw e;
            }
            log(s, { ok: h.code === 0, code: h.code });
            if (h.code !== 0) {
              line(s, "failed");
              throw new Harness(`step ${s.n} trigger ${h.code === null ? "timed out" : `exited ${h.code}`}`);
            }
            line(s, "ok");
          } else if (s.do === "login") {
            const u = await use(s.as, s.n);
            const sub = substitute(s, vars);
            await traceStop(u);
            if (configuredUser(live, sub.user)) throw new Harness(`step ${s.n} login takes an account the journey created, never a configured user`);
            created.push(sub.password);
            secrets = mask();
            appendLedger(main, runId, [{ c: "created password", v: sub.password }]);
            u.d.state.drained = false;
            save(u);
            const res = await u.d.signIn({ user: sub.user, password: sub.password, totpSecret: null, created: true });
            log(s, { ok: res.ok, reason: res.ok ? null : res.reason });
            if (!res.ok) {
              line(s, "failed");
              throw new Harness(`step ${s.n} ${s.as} login failed`);
            }
            save(u, { created: { ...(readSlotState(rdir).created ?? {}), [s.as]: { user: sub.user, password: sub.password } } });
            await traceStart(u);
            line(s, "ok");
          } else if (s.do) {
            await acted(s, await browserStep(s));
          } else {
            const ans = await expectation(s);
            log(s, { held: ans.held, observed: ans.observed ?? null, detail: ans.detail ?? null, errors: (ans.errors ?? []).length, ms: ans.ms ?? null });
            if (ans.held) {
              line(s, "held");
              if (s.final !== undefined) {
                result.step = s.n;
                emit("NOT REPRODUCED");
                return 0;
              }
              continue;
            }
            line(s, "failed");
            if (!HOOK_EXPECTS.includes(s.expect) && (await lost(s.as))) throw new Harness(`step ${s.n} ${s.as} lost its session`);
            if (!OBSERVED.test(String(ans.observed)) && !(smoke && ans.observed === "ambiguous")) throw new Harness(`step ${s.n} expectation could not be judged`);
            if (s.final === undefined && !smoke) throw new Harness(`step ${s.n} expectation failed before the final step`);
            const expected = s.expect === "count" ? `count:${s.value}` : s.expect;
            finalFence(s, ans);
            Object.assign(result, { step: s.n, expected, observed: ans.observed, shownSha256: shownDigest(ans.shown, s, vars) });
            if (smoke) {
              result.kind = "expect-failed";
              emit(`PATH broke step=${s.n} kind=expect-failed`);
              return 3;
            }
            emit(`REPRODUCED step=${s.n} expected=${expected} observed=${ans.observed}`);
            return 3;
          }
        }
        if (smoke) {
          emit("PATH held");
          return 0;
        }
        throw new Error("failed: the repro ended without its final");
      },
      { waitMs: slotLockWaitMs(settleMs) },
    );
    result.exit = code;
  } catch (e) {
    result.exit = 2;
    if (e instanceof Broke) {
      Object.assign(result, { exit: 3, step: e.step, kind: e.kind });
      emit(`PATH broke step=${e.step} kind=${e.kind}`);
    } else if (e instanceof Harness) {
      const m = /^step (\d+) /.exec(e.message);
      if (m) result.step = Number(m[1]);
      emit(`HARNESS: ${e.message}`);
    } else {
      const msg = /^failed: run-code: /.test(String(e && e.message)) ? "the browser CLI's run-code failed" : String((e && e.message) || e).replace(/^(failed|refused): /, "");
      emit(`HARNESS: failed: ${clean(msg, { secrets }).split("\n")[0].slice(0, 500)}`);
    }
  } finally {
    await closeRun({ main, runId, drivers, js, runner, cliRunner });
    try {
      result.ms = Date.now() - started;
      result.saved = Object.fromEntries(Object.entries(result.saved).map(([k, v]) => [k, clean(String(v), { secrets })]));
      if (rdir && tracesBefore) {
        const now = filesUnder(path.join(rdir, "out", "traces"));
        // A trace's resources may be shared with an earlier run's: the run names every one present.
        result.traces = now.filter((f) => !tracesBefore.has(f) || f.startsWith(`resources${path.sep}`));
      }
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (smoke) writePrivate(path.join(dir, "path.json"), `${JSON.stringify({ id: smoke.id, path: repro, ...(parsed ? parsed : {}) })}\n`);
      else if (list === null) writePrivate(path.join(dir, "repro.json"), `${JSON.stringify({ ref, repro, ...(parsed ? parsed : {}) })}\n`);
      writePrivate(path.join(dir, `run-${n}.json`), `${JSON.stringify(result)}\n`);
      writePrivate(path.join(dir, `steps-${n}.jsonl`), stepLog.map((x) => `${clean(JSON.stringify(x), { secrets })}\n`).join(""));
    } catch (e) {
      lines.push(`HARNESS: failed: the run's records could not be written (${String(e.message).slice(0, 200)})`);
    }
  }
  return { code: result.exit, lines, result };
}

/** A valid exit 3's last line (decision 8): enums and integers only. */
const REPRODUCED = /^REPRODUCED step=\d+ expected=[a-z-]+(:\d+)? observed=[a-z-]+(:\d+)?$/;

/**
 * Candidate `ref`'s repro, two of two (spec §10 "Reproduce"; decision 9) → `{code, lines}`: run 1, and run
 * 2 only when run 1 reproduced. Each run's lines are prefixed `run <i> ` (a fence stays whole, its nonce
 * lines as made), then the verdict: run 2's `REPRODUCED …` (exit 3, both runs reproduced), `NOT REPRODUCED
 * runs=<k>/<n>` (exit 0; `1/2` the intermittent case) or `HARNESS: run <i>: <reason>` (exit 2, at once): an
 * exit 3 without its REPRODUCED line, or any exit but 0, 2 and 3, is the harness's too. `verdict.json`
 * `{runs: [exit…], verdict: "reproduced"|"not-reproduced"|"intermittent"|"harness"}` (0600) goes to the
 * candidate's directory. Each run's records are numbered after the candidate's (`run <i>` in the lines is
 * this repro's run). `once` is the one-run seam (runOnce); `opts` reach it as they are.
 */
export async function repro(main, ref, { once = runOnce, say = () => {}, ...opts } = {}) {
  const { dir } = reproRef(main, ref);
  const first = nextRun(dir);
  const lines = [];
  const emit = (l) => {
    lines.push(l);
    say(l);
  };
  const runs = [];
  let verdict = null;
  let code = 0;
  for (let i = 1; i <= 2 && verdict === null; i++) {
    const prefix = (l) => (l.startsWith("<<<") ? l : `run ${i} ${l}`);
    const r = await once(main, ref, { ...opts, i: first + i - 1, say: (l) => say(prefix(l)) });
    for (const l of r.lines) lines.push(prefix(l));
    runs.push(r.code);
    const last = r.lines.at(-1) ?? "";
    if (r.code === 3 && !REPRODUCED.test(last)) [verdict, code] = [`HARNESS: run ${i}: exit 3 without its REPRODUCED line`, 2];
    else if (r.code === 2) [verdict, code] = [`HARNESS: run ${i}: ${last.startsWith("HARNESS: ") ? last.slice(9) : "exit 2"}`, 2];
    else if (r.code !== 0 && r.code !== 3) [verdict, code] = [`HARNESS: run ${i}: exit ${r.code}`, 2];
    else if (r.code === 0) verdict = `NOT REPRODUCED runs=${i - 1}/${i}`;
    else if (i === 2) [verdict, code] = [last, 3];
  }
  emit(verdict);
  const word = code === 3 ? "reproduced" : code === 2 ? "harness" : runs.length === 2 ? "intermittent" : "not-reproduced";
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivate(path.join(dir, "verdict.json"), `${JSON.stringify({ runs, verdict: word })}\n`);
  return { code, lines };
}

/** The number the candidate's next run record takes: one past its highest `run-<i>.json` (unreadable ones too). */
export function nextRun(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /^run-[1-9][0-9]*\.json$/.test(f));
  } catch {
    names = [];
  }
  return Math.max(0, ...names.map((f) => Number(f.slice(4, -5)))) + 1;
}

/** The final kinds whose defect shows without the UI (spec §19.14), each with the live.json key it reads. */
const API_READS = { "fact-equals": "live.facts", mail: "live.mail" };

/**
 * Spec §19.14: the line `repro <ref> --test` adds after `red test:` for candidate `ref` → `api-level: suggested
 * (the final reads live.facts|live.mail)` when its final is a `fact-equals` or `mail` expectation (the defect is
 * observable through the app's facts or mail, so the issue suggests an API-level RED test beside the UI one),
 * else null. The final is the candidate's own: minimizing never drops it (reductions).
 */
export function apiLevelHint(main, ref) {
  const { candidate } = reproRef(main, ref);
  const last = Array.isArray(candidate.repro) ? candidate.repro.at(-1) : null;
  const reads = isObj(last) && typeof last.final === "string" && Object.hasOwn(API_READS, last.expect) ? API_READS[last.expect] : null;
  return reads === null ? null : `api-level: suggested (the final reads ${reads})`;
}

/**
 * The end of every run (decision 13, decision 3): each opened account's last drain (`observe`; one that
 * fails while the account was undrained marks the ledger incomplete), `tracing-stop`, then the sessions
 * closed and their records dropped from run.json (their sockets too, unless another session of that HOME
 * remains).
 */
async function closeRun({ main, runId, drivers, js, runner, cliRunner }) {
  const records = [];
  for (const u of drivers.values()) {
    try {
      const { o } = await u.d.observe();
      if (!o && u.d.state.drained === false) appendLedger(main, runId, [{ c: "incomplete", v: `${u.d.name} lost before its drain` }]);
    } catch {
      // the close below still runs
    }
    try {
      if (u.tracing) await u.d.cli(["tracing-stop"], 60_000);
    } catch {
      // the trace is diagnosis only
    }
    if (u.record) records.push(u.record);
  }
  if (!records.length) return;
  await closeSessions(records, { js, runner, cliRunner, graceMs: 3000 });
  let shared = true;
  try {
    const after = updateRun(main, runId, (prev) => (prev ? { ...prev, sessions: (prev.sessions ?? []).filter((s) => !s || !records.some((r) => r.name === s.name)) } : undefined), { create: false });
    shared = Boolean(after && (after.sessions ?? []).some((s) => s && records.some((r) => r.home === s.home)));
  } catch {
    // run.json gone or sealed: the teardown closes what it holds
  }
  if (!shared) for (const h of new Set(records.map((r) => r.home))) removeSockets(h);
}
