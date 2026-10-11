// argus-live-aiux.mjs — the AI-surface probe of the taste pass (spec §20, decision 14: `ai.stop`, `ai.error`,
// `ai.regenerate`). A leaf module (it reads the plugin's bar file, no other argus-live module). The rules judge only a
// route the owner declares (`.argus/taste.json` `ai`), and only where the page shows an AI surface by what it does,
// never by a name: an answer streamed into a live or busy region (its text extended in three or more steps after an
// action, letters or digits each time) and a composer (a text box with its send control). AIUX_INIT, in the session
// hook's init payload, records each document's streams, the composer's sends and the controls that appeared while a
// stream ran and after it, as counts and times only, never page text; AIUX_SOURCE reads that record and judges it (its
// `judge` kind is pure, so Node runs it too); AIUX_DRIVE is the lane's confirmation: it sends a fixed prompt on the
// surface, presses each control that appeared while the answer streamed, then each that appeared after it, and arms
// nothing itself (AIUX_FAULT, armed before the navigation, fails the drive's own send for `ai.error`). Precision first:
// a screen with no AI surface, an undeclared route, a stream too short to stop or an answer not yet settled stays
// silent. Provenance and uncertainty display need judgment: the Curator's leads, never a rule here.
import { readFileSync } from "node:fs";

/** The probe's definitions (the bar holds no number for them): a stream's quiet end, a stop's bound, an error's settle, an action's reach. */
const QUIET_MS = 1500, STOP_MS = 1000, SETTLE_MS = 2000, TRIGGER_MS = 30000, MIN_TICKS = 3, MIN_SPAN_MS = 150;
/** Each rule's `expected`, as its findings say it. */
export const AI_EXPECTED = Object.freeze({
  "ai.stop": `a Stop control while it streams, ending the stream within ${STOP_MS} ms`,
  "ai.regenerate": "a control that answers again once the answer is complete",
  "ai.error": "the failure shown, with a way to retry or go on",
});
/** A request's route template: numeric, uuid and long token segments become `:id` (argus-live-ease.mjs ROUTE_OF's rule). */
const ROUTE_OF = String.raw`(p) => String(p || "/").split("?")[0].split("/").map((s) => (/^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || (s.length >= 16 && /\d/.test(s) && /^[A-Za-z0-9_-]+$/.test(s)) ? ":id" : s)).join("/")`;

/**
 * The page-side words both the recorder and the drive use. A control acts (buttons, never a link); a composer is the
 * nearest ancestor (four levels at most) holding a text box and a control, and neither a live or busy region nor more
 * than eight controls (so an answer's own buttons are never the composer's).
 */
const CORE = String.raw`const V = { checkOpacity: true, checkVisibilityCSS: true };
  const shown = (el) => Boolean(el) && el.nodeType === 1 && el.isConnected && (typeof el.checkVisibility !== "function" || el.checkVisibility(V));
  const CONTROL = "button, [role=button], input[type=submit], input[type=button], input[type=image]";
  const TEXTBOX = "textarea, input:not([type]), input[type=text], input[type=search], [contenteditable=''], [contenteditable=true], [role=textbox]";
  const LIVE = "[aria-live]:not([aria-live=off]), [role=log], [role=status]";
  const enabled = (el) => !el.disabled && el.getAttribute("aria-disabled") !== "true";
  const writable = (el) => shown(el) && enabled(el) && !el.readOnly && el.getAttribute("aria-readonly") !== "true";
  const nameOf = (el) => String(el.getAttribute("aria-label") || (el.tagName === "INPUT" ? (/^(button|submit|reset)$/i.test(el.type) ? el.value : el.getAttribute("name")) : el.isContentEditable ? "" : el.textContent) || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const controls = () => [...document.querySelectorAll(CONTROL)].filter((el) => shown(el) && enabled(el));
  const composerOf = (el) => {
    for (let a = el, k = 0; a && a.nodeType === 1 && k < 5; a = a.parentElement, k++) {
      if (a.matches(TEXTBOX) || !a.querySelector(TEXTBOX) || !(a.matches(CONTROL) || a.querySelector(CONTROL))) continue;
      return a.querySelector(LIVE + ", [aria-busy]") || a.querySelectorAll(CONTROL).length > 8 ? null : a;
    }
    return null;
  };
  const regionOf = (el) => el.closest(LIVE) || el.closest('[aria-busy="true"]');`;

/**
 * The AI-surface recorder of the session hook's init payload (argus-live-browser.mjs PAGE_INIT), once a document.
 * Each trusted action (pointerdown with the main button, Enter, or a click or submit with no action in the second
 * before) snapshots the shown, enabled controls and their names; one from the composer is a send. A region's text
 * that grows by letters or digits in three steps or more, over 150 ms or more, after an action the 30 s before, is a
 * stream of that action; a rewrite resets a growth not yet a stream, and punctuation alone (a thinking indicator) is
 * no step. While it streams, each control that is new or renamed since the action and not inside the answer itself
 * (the region's child the text grows in: a Source chip, a code block's Copy) is counted, a stop's candidates; a click
 * on one is a stop tried. A stream after a click on a control that appeared after the last answer is that answer
 * regenerated. A composer send counts as a failure only once the document streamed before it. The times of text
 * shown outside text boxes are kept, a burst at its latest (an error shown after a failure). Names stay in the page
 * (they tell a renamed control); nothing the page says leaves it. `document.__argusAi` holds `read()` (the counts AIUX_SOURCE's `screen` kind returns) and, for the drive, `composer()`
 * ([text box, send control]), `stops()` and `regens()` (the candidates of the latest stream, as elements).
 */
export const AIUX_INIT = String.raw`(() => {
  const doc = document;
  if (doc.__argusAi) return;
  const now = () => performance.now();
  ${CORE}
  const own = new WeakMap(), state = new WeakMap(), pending = new Map();
  const streams = [], sends = [], texts = [], acts = [];
  const cap = (list, n, x) => { list.push(x); if (list.length > n) list.shift(); return x; };
  const snapshot = () => new Map(controls().map((el) => [el, nameOf(el)]));
  const freshOf = (base) => controls().filter((el) => !base.has(el) || base.get(el) !== nameOf(el));
  const open = () => { const s = streams[streams.length - 1]; return s && now() - s.last < ${QUIET_MS} ? s : null; };
  let act = null, seen = 0, timer = 0;
  const onInput = (e) => {
    if (!e.isTrusted || (e.type === "pointerdown" && e.button !== 0) || (e.type === "keydown" && e.key !== "Enter")) return;
    const t = now();
    if (act && t - act.t < 1000 && (e.type === "click" || e.type === "submit")) return;
    const target = e.target && e.target.nodeType === 1 ? e.target : null;
    const el = target ? target.closest(CONTROL) : null;
    const s = open(), h = s ? own.get(s) : null;
    const stop = Boolean(h && el && h.fresh.has(el));
    if (stop) [s.tried, s.lastTry] = [s.tried + 1, Math.round(t)];
    const box = e.type === "keydown" && target && target.matches(TEXTBOX) ? target : null;
    const composer = !stop && Boolean((el && composerOf(el)) || box || (e.type === "submit" && target && composerOf(target)));
    const prev = streams[streams.length - 1], ph = prev && !s ? own.get(prev) : null;
    const regenOf = !stop && ph && el && !composerOf(el) && (!ph.base.has(el) || ph.base.get(el) !== nameOf(el)) ? prev : null;
    act = { t, base: snapshot(), composer, regenOf, used: stop };
    cap(acts, 50, Math.round(t));
    if (composer) own.set(cap(sends, 20, { t: Math.round(t), streamed: seen > 0 }), act);
  };
  for (const type of ["pointerdown", "keydown", "click", "submit"]) doc.addEventListener(type, onInput, true);
  const tick = () => {
    timer = 0;
    const t = now();
    for (const [r, msg] of pending) {
      const st = state.get(r) || { text: "", run: null };
      state.set(r, st);
      const txt = r.isConnected ? String(r.textContent || "") : "", was = st.text;
      st.text = txt;
      if (txt === was) continue;
      let k = 0;
      while (k < was.length && k < txt.length && was.charCodeAt(k) === txt.charCodeAt(k)) k++;
      const grew = txt.length > was.length && k >= was.length - 8;
      let s = null;
      for (let i = streams.length - 1; i >= 0 && !s; i--) if (own.get(streams[i]).region === r) s = streams[i];
      if (s && !(own.get(s).act === act || t - s.last < ${QUIET_MS})) s = null;
      if (!grew) { if (!s) st.run = null; continue; }
      const added = txt.slice(k);
      if (!/[\p{L}\p{N}]/u.test(added)) continue;
      if (s) [s.ticks, s.chars, s.last, own.get(s).msg] = [s.ticks + 1, s.chars + added.length, Math.round(t), msg || own.get(s).msg];
      else {
        const run = st.run && t - st.run.last < ${QUIET_MS} ? st.run : (st.run = { t0: t, last: t, ticks: 0, chars: 0 });
        [run.ticks, run.chars, run.last] = [run.ticks + 1, run.chars + added.length, t];
        if (run.ticks < ${MIN_TICKS} || run.last - run.t0 < ${MIN_SPAN_MS} || !act || act.used || act.t > run.t0 || run.t0 - act.t > ${TRIGGER_MS}) continue;
        st.run = null;
        seen += 1;
        s = cap(streams, 20, { t0: Math.round(run.t0), last: Math.round(t), ticks: run.ticks, chars: run.chars, stops: 0, outside: 0, tried: 0, lastTry: null, again: false });
        const back = act.regenOf ? own.get(act.regenOf) : null;
        own.set(s, { region: r, msg, base: back ? back.base : act.base, act, fresh: new Set() });
        act.used = true;
        if (act.regenOf) act.regenOf.again = true;
      }
      const h = own.get(s);
      for (const el of freshOf(h.base)) if (!h.fresh.has(el) && !(h.msg && h.msg.contains(el))) { h.fresh.add(el); s.stops += 1; if (!r.contains(el)) s.outside += 1; }
    }
    pending.clear();
  };
  new MutationObserver((records) => {
    const t = now();
    for (const m of records) {
      const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      if (!el) continue;
      const textual = m.type === "characterData" ? /\S/.test(m.target.data) : [...m.addedNodes].some((n) => /\S/.test(n.textContent || ""));
      // A burst keeps its latest time, so a message shown right after the user's own echo is never read as the echo.
      if (textual && !el.closest(TEXTBOX)) { if (texts.length && t - texts[texts.length - 1] <= 30) texts[texts.length - 1] = t; else cap(texts, 200, t); }
      const r = regionOf(el);
      if (!r) continue;
      // The answer: the region's child the text changed in (its own controls, a Source chip, are never a stop).
      let msg = el;
      while (msg && msg.parentElement !== r) msg = msg.parentElement;
      if (msg || !pending.has(r)) pending.set(r, msg);
    }
    if (pending.size && !timer) timer = setTimeout(tick, 50);
  }).observe(doc, { subtree: true, childList: true, characterData: true });
  const busy = () => [...doc.querySelectorAll('[aria-busy="true"], [role=progressbar]:not([aria-valuenow]), progress:not([value])')].some(shown);
  const regens = () => {
    const s = streams[streams.length - 1];
    return s ? freshOf(own.get(s).base).filter((el) => !composerOf(el) && !el.closest("dialog, [role=dialog], [role=alertdialog]")) : [];
  };
  doc.__argusAi = {
    v: 1,
    read: () => {
      const t = now();
      const boxes = [...doc.querySelectorAll(TEXTBOX)];
      const surface = boxes.some(shown) && Boolean(doc.querySelector(LIVE + ", [aria-busy]"));
      const list = streams.map((s, i) => {
        const r = own.get(s).region;
        const ended = t - s.last >= ${QUIET_MS} && !(r.closest('[aria-busy="true"]') || r.querySelector('[aria-busy="true"]'));
        const regen = i === streams.length - 1 && ended && !s.tried ? regens().length : null;
        return { t0: s.t0, last: s.last, ticks: s.ticks, chars: s.chars, stops: s.stops, outside: s.outside, tried: s.tried, wentOn: s.lastTry === null ? 0 : Math.max(0, s.last - s.lastTry), again: s.again, ended, regen, size: r.isConnected ? String(r.textContent || "").length : 0 };
      });
      const reqs = doc.__argusEase && Array.isArray(doc.__argusEase.requests) ? doc.__argusEase.requests : [];
      const failures = [];
      for (const sd of surface ? sends : []) {
        if (!sd.streamed) continue;
        const q = reqs.find((x) => x && x.same !== false && !/^(GET|HEAD|OPTIONS)$/.test(x.method) && x.t >= sd.t - 5 && x.t <= sd.t + 1000);
        if (!q || typeof q.end !== "number" || (q.status >= 200 && q.status < 400) || t - q.end < ${SETTLE_MS}) continue;
        if (q.status === 0 && acts.some((x) => x > sd.t + 5 && x <= q.end)) continue;
        const a = own.get(sd);
        failures.push({ t: sd.t, status: q.status, busy: busy(), shown: texts.some((x) => x > q.end), wayOn: boxes.some(writable) || freshOf(a.base).some((el) => !composerOf(el)) });
      }
      return { surface, seen, streams: list, failures };
    },
    composer: () => {
      const boxes = [...doc.querySelectorAll(TEXTBOX)].filter(writable);
      const box = boxes.find((b) => composerOf(b)) || boxes[0];
      if (!box) return [];
      const c = composerOf(box);
      const all = c ? [...c.querySelectorAll(CONTROL)].filter((el) => shown(el) && enabled(el)) : [];
      const send = all.find((el) => el.type === "submit") || all[all.length - 1];
      return send ? [box, send] : [box];
    },
    stops: () => {
      const s = streams[streams.length - 1];
      if (!s) return [];
      const h = own.get(s), at = (el) => el.getBoundingClientRect();
      const b = [...doc.querySelectorAll(TEXTBOX)].find(writable), o = b ? at(b) : { x: 0, y: 0 };
      const far = (el) => Math.hypot(at(el).x - o.x, at(el).y - o.y);
      return [...h.fresh].filter((el) => shown(el) && enabled(el)).sort((x, y) => Number(h.region.contains(x)) - Number(h.region.contains(y)) || far(x) - far(y));
    },
    regens,
  };
})();
`;

/**
 * The AI-surface measurement, `(arg) => result`, run as `(${AIUX_SOURCE})(arg)`. Kinds:
 * - `judge` ({screen, rules, cfg}; pure, no DOM) → the screen's findings: `screen` is `{route, ai}`, `ai` a `screen`
 *   answer, `rules` the bar's, `cfg` taste.json's (`ai` route globs, `off`); an undeclared route gives none;
 * - `screen` → `{v, now, route, surface, seen, streams, failures}`: counts and times only. A stream is `{t0, last,
 *   ticks, chars, stops, outside, tried, wentOn, again, ended, regen, size}` (`regen` the controls new since its action,
 *   outside the composer and any dialog, for the latest stream once it ended untouched, else null); a failure is a
 *   composer send whose request (non-GET, the page's origin, within a second) answered no 2xx or 3xx, 2 s settled:
 *   `{t, status, busy, shown, wayOn}`;
 * - `rule` ({rule, rules}) → `judge`'s findings of that one rule on this page, its route taken as declared (the caller
 *   chose the page).
 */
export const AIUX_SOURCE = String.raw`(arg) => {
  const A = arg || {};
  const routeOf = ${ROUTE_OF};
  const globMatch = (glob, route) => typeof glob === "string" && typeof route === "string" && new RegExp("^" + glob.split(/(\/\*\*$|\*\*|\*)/).map((p) => (p === "/**" ? "(?:/.*)?" : p === "**" ? ".*" : p === "*" ? "[^/]*" : p.replace(/[.+?^$(){}|[\]\\]/g, "\\$&").replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "[^/]+"))).join("") + "$").test(route);
  const EXPECTED = ${JSON.stringify(AI_EXPECTED)};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const judge = (screen, rules, cfg, declared) => {
    const R = new Set((Array.isArray(rules) ? rules : []).filter((r) => r && r.family === "ai").map((r) => r.id));
    const c = cfg && typeof cfg === "object" ? cfg : {};
    const off = new Set(Array.isArray(c.off) ? c.off : []);
    const s = screen && typeof screen === "object" ? screen : {};
    const a = s.ai && typeof s.ai === "object" ? s.ai : {};
    const route = typeof s.route === "string" ? s.route : typeof a.route === "string" ? a.route : "/";
    const out = [];
    if (!declared && !(Array.isArray(c.ai) ? c.ai : []).some((g) => globMatch(g, route))) return out;
    const add = (id, key, measured) => { if (R.has(id) && !off.has(id) && !out.some((f) => f.rule === id)) out.push({ rule: id, key, measured, expected: EXPECTED[id] }); };
    const list = (Array.isArray(a.streams) ? a.streams : []).filter((x) => x && typeof x === "object");
    for (const x of list) {
      if (num(x.stops) === 0 && num(x.last) - num(x.t0) >= ${STOP_MS}) add("ai.stop", "stream", "no stop control while it streamed");
      else if (num(x.tried) > 0 && num(x.wentOn) > ${STOP_MS}) add("ai.stop", "stream", "it streamed " + Math.round(num(x.wentOn)) + " ms past a stop");
    }
    const last = list[list.length - 1];
    if (last && last.ended === true && num(last.tried) === 0 && !list.some((x) => x.again === true) && last.regen === 0) add("ai.regenerate", "answer", "no control once the answer was complete");
    for (const f of a.surface === true && Array.isArray(a.failures) ? a.failures : []) {
      const why = !f || typeof f !== "object" ? null : f.busy === true ? "an endless loader" : f.shown !== true ? "nothing shown" : f.wayOn !== true ? "no way on" : null;
      if (why) add("ai.error", "failed-stream", why);
    }
    return out;
  };
  if (A.kind === "judge") return judge(A.screen, A.rules, A.cfg, false);
  const S = document.__argusAi;
  const screen = () => Object.assign({ v: 1, now: Math.round(performance.now()), route: routeOf(location.pathname) }, S && typeof S.read === "function" ? S.read() : { surface: false, seen: 0, streams: [], failures: [] });
  if (A.kind === "screen") return screen();
  if (A.kind === "rule") return judge({ ai: screen() }, A.rules, {}, true).filter((f) => f.rule === A.rule);
  throw new Error("failed: aiux: no kind " + String(A.kind).slice(0, 40));
}`;

/**
 * The confirmation's drive, `async (page, A) => rows | null` (A is driveArg's): on the page as the replay reached it,
 * it types A.marker into the composer and sends it, then measures A.rule. `ai.stop`: once the answer streams, it
 * presses each control that appeared while it streamed (three at most, those outside the answer first), until the
 * stream stays quiet for the stop's bound. `ai.regenerate`: once the answer is complete, each control that appeared
 * after it (four at most) until one streams an answer again; a dialog it opens is closed with Escape. `ai.error`: the
 * send's failure (AIUX_FAULT armed before the navigation). Rows are AIUX_SOURCE's `rule` kind's, plus the drive's own
 * `ai.regenerate` row when no candidate answered again. `[]` when the page shows no AI surface; null (undecided) when the
 * answer never ended, no stop was tried, a control left the route or removed the answer, or no failure came.
 */
export const AIUX_DRIVE = String.raw`async (page, A) => {
  const INIT = ${JSON.stringify(AIUX_INIT)};
  const SRC = ${JSON.stringify(AIUX_SOURCE)};
  const wait = (ms) => page.waitForTimeout(ms);
  const read = () => page.evaluate("(" + SRC + ")(" + JSON.stringify({ kind: "screen" }) + ")");
  const rows = () => page.evaluate("(" + SRC + ")(" + JSON.stringify({ kind: "rule", rule: A.rule, rules: A.rules }) + ")");
  const until = async (ok, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      const s = await read();
      if (ok(s)) return s;
      if (Date.now() >= end) return null;
      await wait(100);
    }
  };
  const handles = async (expr) => {
    const h = await page.evaluateHandle(expr);
    const n = await h.evaluate((a) => a.length);
    const out = [];
    for (let i = 0; i < n; i++) { const e = (await h.getProperty(String(i))).asElement(); if (e) out.push(e); }
    return out;
  };
  const send = async (text) => {
    const first = await handles("document.__argusAi.composer()");
    if (!first.length) return false;
    await first[0].fill(text);
    const c = await handles("document.__argusAi.composer()");
    if (c.length > 1) await c[1].click({ timeout: 5000 }); else await first[0].press("Enter");
    return true;
  };
  // Never a destructive control (the lexicon) or one the owner's live.json prohibits: such a candidate leaves the drive undecided.
  const RISK = new RegExp(A.refuse, "iu");
  const risky = async (el) => {
    const n = String(await el.evaluate((e) => e.getAttribute("aria-label") || (e.tagName === "INPUT" ? e.value : e.innerText || e.textContent) || e.getAttribute("title") || "").catch(() => "")).replace(/\s+/g, " ").trim().toLowerCase();
    return RISK.test(n) || (n !== "" && (A.prohibited || []).some((p) => { const q = String(p).toLowerCase(); return q.includes(n) || n.includes(q); }));
  };
  if (!(await page.evaluate("Boolean(document.__argusAi)"))) await page.evaluate(INIT);
  let before = await read();
  if (!(await send(A.rule === "ai.error" ? A.plain : A.marker))) return [];
  const url = page.url();
  const mine = (s) => (s && s.seen > before.seen && s.streams.length ? s.streams[s.streams.length - 1] : null);
  if (!(await until((x) => mine(x) !== null, A.startMs))) return [];
  if (A.rule === "ai.error") {
    // A stream first (the page is an AI surface), then the drive's marked prompt, which the armed fault fails.
    if (!(await until((x) => mine(x).ended, A.endMs))) return null;
    before = await read();
    if (!(await send(A.marker))) return null;
    return (await until((x) => x.failures.length > before.failures.length, A.startMs + A.settleMs)) ? rows() : null;
  }
  if (A.rule === "ai.stop") {
    const s = mine(await read());
    if (s.stops > 0) {
      for (const el of (await handles("document.__argusAi.stops()")).slice(0, 3)) {
        const at = await read(), m = mine(at);
        if (!m || at.now - m.last >= A.stopMs) break;
        if (await risky(el)) return null;
        await el.click({ timeout: 2000 }).catch(() => null);
        await wait(A.stopMs + 500);
        const after = await read(), n = mine(after);
        if (!n || after.now - n.last >= A.stopMs) break;
      }
    }
    const done = await until((x) => mine(x).ended, A.endMs);
    if (!done || (s.stops > 0 && !mine(done).tried)) return null;
    return rows();
  }
  const ended = await until((x) => mine(x).ended, A.endMs);
  if (!ended || mine(ended).tried) return null;
  if (mine(ended).regen === 0) return rows();
  const tried = (await handles("document.__argusAi.regens()")).slice(0, 4);
  for (const el of tried) {
    const at = await read(), size = mine(at) ? mine(at).size : 0;
    if (await risky(el)) return null;
    await el.click({ timeout: 2000 }).catch(() => null);
    const again = await until((x) => x.seen > at.seen, 3000);
    if (page.url() !== url) return null;
    if (again) return (await until((x) => x.streams[x.streams.length - 1].ended, A.endMs)) ? rows() : null;
    const now = await read(), m = now.streams[now.streams.length - 1];
    if (m && m.size < size / 2) return null;
    if (await page.evaluate("Boolean(document.querySelector('dialog[open], [role=dialog], [role=alertdialog]'))")) await page.keyboard.press("Escape");
  }
  return [{ rule: "ai.regenerate", key: "answer", measured: "none of " + tried.length + " controls shown after the answer answered again", expected: A.expected }];
}`;

/**
 * The fault of `ai.error` (decision 12's pattern for an AI surface), `async (page, marker) => {faulted(), off()}`:
 * armed BEFORE the navigation, on the page's context, it answers 500 to the first non-GET fetch or XHR whose body
 * holds `marker` (the drive's own prompt, so no request of the path itself is touched); nothing else is answered or
 * fetched. `faulted()` is that request's path (null: none), `off()` removes the route.
 */
export const AIUX_FAULT = String.raw`async (page, marker) => {
  let faulted = null;
  const handler = async (route) => {
    const q = route.request();
    let body = "";
    try { body = String(q.postData() || ""); } catch (e) { body = ""; }
    if (faulted !== null || q.method() === "GET" || !/^(fetch|xhr)$/.test(q.resourceType()) || !body.includes(marker)) return route.fallback();
    faulted = new URL(q.url()).pathname;
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "argus: a routed fault" }) });
  };
  await page.context().route("**/*", handler);
  return { faulted: () => faulted, off: () => page.context().unroute("**/*", handler) };
}`;

// ---------------------------------------------------------------------------------------------------
// The Node side.

const BAR = JSON.parse(readFileSync(new URL("../data/taste-bar.json", import.meta.url), "utf8"));
const MINE = BAR.rules.filter((r) => r.family === "ai");
const aiFn = new Function(`return (${AIUX_SOURCE});`)();

/** The drive's prompts: plain letters and hyphens, so a JSON or form body holds them as typed. AIUX_FAULT fails only the marked one. */
export const AI_MARKER = "argus-taste-probe";
const AI_PLAIN = "argus-taste-check";

/**
 * The per-screen findings `[{rule, key, measured, expected}]` of `screen` against `bar` and `cfg` (loadTaste's): `screen`
 * is the recorded screen (`route`, the route template; `ai`, AIUX_SOURCE's `screen` answer). Only a route `cfg.ai`
 * declares is judged.
 */
export function rulesFor(screen, bar, cfg) {
  return aiFn({ kind: "judge", screen, rules: (bar && bar.rules) || [], cfg: cfg || {} });
}

/** A page expression → the findings of AI rule `rule` from what the current page recorded (a send must have happened: the drive makes one). */
export function ruleExpression(rule) {
  if (!MINE.some((x) => x.id === rule)) throw new Error(`refused: ruleExpression: ${String(rule).slice(0, 60)} is not a screen rule of the aiux probe`);
  return `(${AIUX_SOURCE})(${JSON.stringify({ kind: "rule", rule, rules: MINE })})`;
}

/**
 * The words that name a control the drive never presses, whatever rule it measures: what deletes, removes, sends, pays,
 * publishes, approves, deploys or transfers (English, then a few other languages' words for the same), as a whole word.
 */
export const DESTRUCTIVE = String.raw`(^|[^\p{L}])(delete|remove|destroy|erase|purge|discard|send|submit|pay|payment|purchase|buy|checkout|order|publish|post|approve|deploy|transfer|withdraw|revoke|unsubscribe|hapus|kirim|bayar|terbitkan|setujui|löschen|senden|bezahlen|veröffentlichen|supprimer|envoyer|payer|publier|eliminar|borrar|enviar|pagar|publicar|aprobar)($|[^\p{L}])`;

/**
 * AIUX_DRIVE's argument for `rule`: the bar's AI rules, the prompt, its bounds (start of the answer, its end, a stop, an
 * error's settle), and what it never presses: DESTRUCTIVE's words and `prohibited` (live.json's, matched by words).
 */
export function driveArg(rule, prohibited = []) {
  if (!MINE.some((x) => x.id === rule)) throw new Error(`refused: driveArg: ${String(rule).slice(0, 60)} is not an AI rule of the bar`);
  return { rule, rules: MINE, marker: AI_MARKER, plain: AI_PLAIN, startMs: 15_000, endMs: 45_000, stopMs: STOP_MS, settleMs: SETTLE_MS + 1000, expected: AI_EXPECTED[rule], refuse: DESTRUCTIVE, prohibited: (Array.isArray(prohibited) ? prohibited : []).filter((p) => typeof p === "string" && p.trim() !== "").slice(0, 50) };
}

/** The confirmation's arm for an `ai.error` row (the session driver runs it right after its hook, before any navigation). */
export function faultArm() {
  return `async page => {\n  const F = ${AIUX_FAULT};\n  await F(page, ${JSON.stringify(AI_MARKER)});\n  return { armed: true };\n}\n`;
}
