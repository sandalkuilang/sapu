// argus-live-repro.mjs — the repro runner (spec §10 "Reproduce"; decisions 2–4, 6, 8, 11–13, 26): one run
// of a candidate's repro on a freshly reset instance. Its steps are data (argus-live-steps.mjs); every
// browser step runs as the wrapper's own `run-code` template in slot `r`'s sessions, through the session
// driver, proxy and per-slot config an explorer's use; its answer is an exit code — 0 not reproduced, 3
// reproduced, 2 a harness failure — and lines in the wrapper's own words, what the page showed fenced.
// `repro` runs it twice and files only at two of two (decision 9); `minimize` drops one role or step at a
// time and keeps a drop only when the run still fails its final the same way (decision 10); `redTestFile`
// writes the Playwright test a sapu worker uses as its RED test.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { slotConfig, slotDir, writeSlotConfig } from "./argus-live-browser.mjs";
import { closeSessions, removeSockets } from "./argus-live-cli.mjs";
import { expandConfig, loadLive } from "./argus-live-config.mjs";
import { clean, fence } from "./argus-live-fence.mjs";
import { runHook } from "./argus-live-hooks.mjs";
import { upFresh } from "./argus-live-instance.mjs";
import { appendLedger, readSeen, secretHits } from "./argus-live-ledger.mjs";
import { liveDir, readLock } from "./argus-live-lock.mjs";
import { checkUrl } from "./argus-live-origin.mjs";
import { run, runAsync, sleep, tempBeside } from "./argus-live-proc.mjs";
import { redTest } from "./argus-live-redtest.mjs";
import { readRun, updateRun } from "./argus-live-run.mjs";
import { redactIds, REF, scrubSecrets, verdictOf } from "./argus-live-scrub.mjs";
import { CAP_BYTES, configuredUser, keepDrain, maskSecrets, sessionDriver } from "./argus-live-session.mjs";
import { readSlotState, slotLockWaitMs, withSlotLock, writeSlotState } from "./argus-live-slots.mjs";
import { CLICKS, parseRepro, provingExpect, reductions, stepCode, substitute } from "./argus-live-steps.mjs";
import { targetCode } from "./argus-live-targets.mjs";

/** What a failed expectation may say it observed (decision 8): enums and integers only. */
const OBSERVED = /^(absent|hidden|visible|disabled|differs|errors:\d+|count:\d+)$/;
/** The expectation kinds the browser judges (the others run through runHook, or read the error buffer). */
const HOOK_EXPECTS = ["fact-equals", "mail"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** A harness failure: the run ends with exit 2 and `HARNESS: <message>`. */
class Harness extends Error {}

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
const writePrivate = (file, text) => fs.renameSync(tempBeside(file, text, 0o600), file);

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
 */
export async function runOnce(main, ref, { list = null, i = null, fresh = upFresh, cli = null, runner = run, cliRunner = runAsync, say = () => {} } = {}) {
  const { runId, candidate, slotRec, dir } = reproRef(main, ref);
  const n = i ?? nextRun(dir);
  const started = Date.now();
  const lines = [];
  const emit = (l) => {
    lines.push(l);
    say(l);
  };
  const result = { exit: 2, step: null, expected: null, observed: null, shownSha256: null, ms: 0, saved: {}, traces: [], changed: [], reduced: list !== null };
  const repro = list ?? candidate.repro;
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
    try {
      parsed = parseRepro(repro, { accounts: slotRec.accounts, live });
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
        try {
          const summary = await fresh(main, { runner });
          emit(`fresh: instance ${summary.instanceId}`);
        } catch (e) {
          if (e && e.step) throw new Harness(`up --fresh failed at ${e.step}`);
          throw e;
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
            if (!OBSERVED.test(String(ans.observed))) throw new Harness(`step ${s.n} expectation could not be judged`);
            if (s.final === undefined) throw new Harness(`step ${s.n} expectation failed before the final step`);
            const expected = s.expect === "count" ? `count:${s.value}` : s.expect;
            finalFence(s, ans);
            Object.assign(result, { step: s.n, expected, observed: ans.observed, shownSha256: shownDigest(ans.shown, s, vars) });
            emit(`REPRODUCED step=${s.n} expected=${expected} observed=${ans.observed}`);
            return 3;
          }
        }
        throw new Error("failed: the repro ended without its final");
      },
      { waitMs: slotLockWaitMs(settleMs) },
    );
    result.exit = code;
  } catch (e) {
    result.exit = 2;
    if (e instanceof Harness) {
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
      if (list === null) writePrivate(path.join(dir, "repro.json"), `${JSON.stringify({ ref, repro, ...(parsed ? parsed : {}) })}\n`);
      writePrivate(path.join(dir, `run-${n}.json`), `${JSON.stringify(result)}\n`);
      writePrivate(path.join(dir, `steps-${n}.jsonl`), stepLog.map((x) => `${clean(JSON.stringify(x), { secrets })}\n`).join(""));
    } catch (e) {
      lines.push(`HARNESS: failed: the run's records could not be written (${String(e.message).slice(0, 200)})`);
    }
  }
  return { code: result.exit, lines, result };
}

/** The least time a minimize run is taken to need before the lock's deadline. */
const MIN_RUN_MS = 60_000;

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

/** The repo's live config, expanded with the running cycle's ports (the static checks read it). */
function liveOf(main) {
  const { config, errors, secrets } = loadLive(main);
  if (!config || errors.length) throw new Error(`failed: .argus/live.json: ${errors.join("; ")}`);
  const rec = readRun(main);
  return expandConfig(config, { ports: { ...((rec && rec.ports) ?? {}) }, secrets });
}

/** The number the candidate's next run record takes: one past its highest `run-<i>.json` (unreadable ones too). */
function nextRun(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /^run-[1-9][0-9]*\.json$/.test(f));
  } catch {
    names = [];
  }
  return Math.max(0, ...names.map((f) => Number(f.slice(4, -5)))) + 1;
}

/** The candidate's run records in `dir` → `[{i, rec}]` by run number (an unreadable one left out). */
function runRecords(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /^run-[1-9][0-9]*\.json$/.test(f));
  } catch {
    names = [];
  }
  const out = [];
  for (const f of names) {
    try {
      out.push({ i: Number(f.slice(4, -5)), rec: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) });
    } catch {
      // unreadable: not a record
    }
  }
  return out.sort((a, b) => a.i - b.i);
}

/**
 * Candidate `ref`'s repro minimized (spec §10 "Minimize"; decision 10) → `{code: 0, lines}`. Its base is the
 * newest run of the whole list that reproduced (refused without one): its `changed` names the click-family
 * steps that changed state, and how it failed its final (`expected`, `observed`, `shownSha256`) is what a
 * kept reduction must match. The removal units (`reductions`, numbered as the whole list is) are tried in
 * order, each once: a unit whose reduced list the static checks refuse is skipped without a run; any other
 * is one run of `once` with that list (`run-<i>.json` numbered after the candidate's records), kept only
 * when it exits 3 failing the final the same way. Runs stop at `max` (`limits.minimize_runs`, default 12),
 * one of them kept for a confirming run of the result; with no unit left untried it stopped at its
 * fixpoint. `min.json` (0600; the context element first) is written only when the confirm run failed the
 * same way; `minimize.json` `{runs, max, stopped, from, to, confirmed, tried: [{label, exit}]}` (`exit`
 * null for a skipped unit) always. Before each run (a try or the confirm) the lock must still name the
 * candidate's run (else `stopped down`) with the longest run so far, a minute at least, left before its
 * deadline (else `stopped deadline`): no confirm then, and exit 2. Lines: `try <label>: exit <k>|skipped
 * (…)`, `confirm: exit <k>`, then `minimized <ref>: steps <a> → <b>, runs <k>/<max>, stopped
 * fixpoint|budget|down|deadline, confirmed yes|no`; never a page's text. → `{code: 0|2, lines}`.
 */
export async function minimize(main, ref, { once = runOnce, max = null, say = () => {}, ...opts } = {}) {
  const { runId, candidate, slotRec, dir } = reproRef(main, ref);
  const records = runRecords(dir);
  const base = records.filter((r) => isObj(r.rec) && r.rec.exit === 3 && !r.rec.reduced).at(-1);
  if (!base) throw new Error(`refused: repro: ${ref} has no reproducing run (repro ${ref} first)`);
  const live = liveOf(main);
  const budget = max ?? (live.limits && live.limits.minimize_runs) ?? 12;
  const at = { accounts: slotRec.accounts, live };
  const list = candidate.repro;
  const parsed = parseRepro(list, at);
  // Each element of the list (the context left out) → the numbers its steps carry: a parallel group's members each count.
  const items = Array.isArray(list) && isObj(list[0]) && Object.hasOwn(list[0], "context") ? list.slice(1) : list;
  const grouped = (item) => isObj(item) && Array.isArray(item.parallel);
  let n = 0;
  const numbers = items.map((item) => (grouped(item) ? item.parallel.map(() => (n += 1)) : [(n += 1)]));
  /** The list holding the steps numbered in `keep`, the context element first. */
  const listOf = (keep) => [
    { context: parsed.context },
    ...items.flatMap((item, j) => {
      if (!grouped(item)) return keep.has(numbers[j][0]) ? [item] : [];
      const members = item.parallel.filter((_, x) => keep.has(numbers[j][x]));
      return members.length ? [{ ...item, parallel: members }] : [];
    }),
  ];
  const sameFinal = (r) => Boolean(r && r.code === 3 && isObj(r.result) && r.result.expected === base.rec.expected && r.result.observed === base.rec.observed && r.result.shownSha256 === base.rec.shownSha256);
  const changed = Array.isArray(base.rec.changed) ? base.rec.changed : [];
  const lines = [];
  const emit = (l) => {
    lines.push(l);
    say(l);
  };
  fs.rmSync(path.join(dir, "min.json"), { force: true });
  let next = nextRun(dir);
  // Each run needs the cycle and time: the longest run so far (a minute at least) before the lock's deadline.
  const need = Math.max(MIN_RUN_MS, ...records.map((r) => (isObj(r.rec) && Number.isFinite(r.rec.ms) ? r.rec.ms : 0)));
  /** Why no run may start now: `down` (the lock names no run, or another), `deadline` (too little of it left), else null. */
  const cannotRun = () => {
    let lock = null;
    try {
      lock = readLock(main);
    } catch {
      lock = null;
    }
    if (!lock || lock.runId !== runId) return "down";
    return lock.deadline * 1000 - Date.now() < need ? "deadline" : null;
  };
  let keep = new Set(parsed.steps.map((s) => s.n));
  const tried = [];
  const done = new Set();
  let runs = 0;
  let stopped = "fixpoint";
  for (;;) {
    const unit = reductions(parsed.steps.filter((s) => keep.has(s.n)), { changed: changed.filter((x) => keep.has(x)) }).find((u) => !done.has(u.label));
    if (!unit) break;
    if (runs >= budget - 1) {
      stopped = "budget";
      break;
    }
    done.add(unit.label);
    const without = new Set([...keep].filter((x) => !unit.drop.includes(x)));
    const reduced = listOf(without);
    try {
      parseRepro(reduced, at);
    } catch (e) {
      if (!/^refused: /.test(e.message)) throw e;
      tried.push({ label: unit.label, exit: null });
      emit(`try ${unit.label}: skipped (the static checks refuse it)`);
      continue;
    }
    const why = cannotRun();
    if (why) {
      stopped = why;
      break;
    }
    runs += 1;
    const r = await once(main, ref, { ...opts, list: reduced, i: next++ });
    tried.push({ label: unit.label, exit: r.code });
    emit(`try ${unit.label}: exit ${r.code}`);
    if (sameFinal(r)) keep = without;
  }
  const result = listOf(keep);
  let confirmed = false;
  const cutShort = () => stopped === "down" || stopped === "deadline";
  if (!cutShort() && runs < budget) stopped = cannotRun() ?? stopped;
  if (!cutShort() && runs < budget) {
    runs += 1;
    const c = await once(main, ref, { ...opts, list: result, i: next++ });
    confirmed = sameFinal(c);
    emit(`confirm: exit ${c.code}`);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (confirmed) writePrivate(path.join(dir, "min.json"), `${JSON.stringify(result)}\n`);
  const from = parsed.steps.length;
  writePrivate(path.join(dir, "minimize.json"), `${JSON.stringify({ runs, max: budget, stopped, from, to: keep.size, confirmed, tried })}\n`);
  emit(`minimized ${ref}: steps ${from} → ${keep.size}, runs ${runs}/${budget}, stopped ${stopped}, confirmed ${confirmed ? "yes" : "no"}`);
  return { code: cutShort() ? 2 : 0, lines };
}

/**
 * Candidate `ref`'s RED test (spec §10 "Issue body additions") written to `red.spec.ts` (0600) in its
 * records → the file's absolute path, only once its `verdict.json` says reproduced (two of two): from `min.json` when the last minimize confirmed it, else from the
 * whole list `repro.json` holds (refused without one), parsed against the slot's allocation, its journey
 * the slot's, its oracle the final's, `SETTLE` the run's settle_ms.
 */
export function redTestFile(main, ref) {
  const { runId, slotRec, dir } = reproRef(main, ref);
  const word = verdictOf(main, runId, ref);
  if (word !== "reproduced") throw new Error(`refused: repro: ${ref} did not reproduce two of two (${word}); repro ${ref} first`);
  const read = (f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      return null;
    }
  };
  const m = read("minimize.json");
  const min = isObj(m) && m.confirmed === true ? read("min.json") : null;
  const whole = read("repro.json");
  const list = Array.isArray(min) ? min : isObj(whole) ? whole.repro : null;
  if (!Array.isArray(list)) throw new Error(`refused: repro: ${ref} has no records (repro ${ref} first)`);
  const live = liveOf(main);
  const { context, steps } = parseRepro(list, { accounts: slotRec.accounts, live });
  const text = redTest({ journey: slotRec.journey, oracle: steps.at(-1).final, ref, context, steps, settleMs: live.settle_ms ?? 10_000 });
  const file = path.resolve(dir, "red.spec.ts");
  writePrivate(file, text);
  return file;
}

/** Spec §19.14 (not built yet): the `api-level: suggested (…)` line `repro <ref> --test` adds for candidate `ref`, or null. */
export const apiLevelHint = (main, ref) => null;

/**
 * `repro <ref> --saved` (Phase 5's issue body): the values the candidate's newest reproducing run of its whole
 * list read (`run-<i>.json` `saved`) as scrub would let them leave → `{code, out}`: scrub's refusal for the
 * run (scrubSecrets: a ledger gone, damaged or incomplete; exit 1), else per value `saved <name>: <JSON
 * string>`, its long unknown tokens redacted as scrub redacts them (the run's seen ids stay), or `saved
 * <name>: *** (<class>)` for one holding a secret (secretHits; a value that could not be checked: `***
 * (unchecked)`). Refused without such a run.
 */
export function savedValues(main, ref, { env = process.env } = {}) {
  const { runId, dir } = reproRef(main, ref);
  const base = runRecords(dir).filter((r) => isObj(r.rec) && r.rec.exit === 3 && !r.rec.reduced).at(-1);
  if (!base) throw new Error(`refused: repro: ${ref} has no reproducing run (repro ${ref} first)`);
  const { secrets, refusal } = scrubSecrets(main, { runId, env });
  if (refusal) return { code: 1, out: [refusal] };
  const seen = readSeen(main, runId);
  const out = Object.entries(isObj(base.rec.saved) ? base.rec.saved : {}).map(([k, v]) => {
    const name = /^[a-z][a-z0-9_]{0,39}$/.test(k) ? k : "(name not shown)";
    let hits;
    try {
      hits = secretHits(String(v), secrets);
    } catch {
      return `saved ${name}: *** (unchecked)`;
    }
    return hits.length ? `saved ${name}: *** (${hits[0].cls})` : `saved ${name}: ${JSON.stringify(redactIds(String(v), seen).text)}`;
  });
  return { code: 0, out };
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
