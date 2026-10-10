// argus-live-ease.mjs — the ease probes of the taste pass (spec §20.2: perceived performance, states and microcopy,
// consistency, efficiency). A leaf module (it reads the plugin's bar file, no other argus-live module). EASE_INIT, in
// the session hook's init payload, records each document's actions, first visible changes and busy signals into the
// taste buffer, and its requests, clicked controls and edits beside it (`document.__argusEase`); EASE_SOURCE measures
// a screen and judges a recorded one (`kind: "judge"`, no DOM, so Node runs it too); the Node side judges a
// recorded screen (rulesFor). A finding is `{rule, key, measured, expected}`, its key page
// text (fenced wherever printed) with digit runs `#`. Precision first: a feedback rule measures only an action that
// started a same-origin request and showed a change before the user's next input; a change counts only when it renders
// (an added node, or a RENDER_ATTRIBUTES change on a node that passes checkVisibility, never `data-*`); a rule that
// cannot decide stays silent.
import { readFileSync } from "node:fs";

/** argus-live-tastecfg.mjs RENDER_ATTRIBUTES (a leaf cannot import it; a test pins the two equal). */
export const EASE_RENDER = ["class", "style", "hidden", "aria-hidden", "open", "disabled", "aria-expanded", "aria-selected", "aria-busy"];
/** A request's route template: numeric, uuid and long token segments become `:id`. */
const ROUTE_OF = String.raw`(p) => String(p || "/").split("?")[0].split("/").map((s) => (/^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || (s.length >= 16 && /\d/.test(s) && /^[A-Za-z0-9_-]+$/.test(s)) ? ":id" : s)).join("/")`;
/** A form's key: its label, name or id, else its first heading or legend (digit runs `#`). */
const FORM_KEY = String.raw`(f) => String(f.getAttribute("aria-label") || f.getAttribute("name") || f.id || (f.querySelector("h1, h2, h3, h4, legend") || {}).textContent || "form").replace(/\s+/g, " ").trim().replace(/[0-9]+/g, "#").slice(0, 60)`;
/** The loader shapes both sources share: a rotating infinite animation is a spinner, a bare animated or `skeleton`-classed box a skeleton. */
const LOADER_FNS = String.raw`const SKELETON = /(^|[-_])(skeleton|shimmer)([-_]|$)/i;
  const bare = (el) => { const r = el.getBoundingClientRect(); return !/\S/.test(el.textContent || "") && !el.querySelector("a, button, input, select, textarea, img, video, canvas") && r.width >= 16 && r.height >= 6; };
  const rotates = (a) => { try { return a.effect.getKeyframes().some((k) => /rotate/i.test(String(k.transform || "")) || (k.rotate !== undefined && k.rotate !== "none")); } catch (e) { return false; } };
  const looping = (a) => Boolean(a.effect && a.effect.target && !a.effect.pseudoElement && a.playState === "running" && a.effect.getComputedTiming().iterations === Infinity);`;

/**
 * The feedback clock of the session hook's init payload (argus-live-browser.mjs PAGE_INIT), once a document after the
 * taste buffer: `input` records (pointerdown with the main button, click, dblclick, submit, keydown of Enter or Space,
 * and typing as `input`, one record per burst), the first rendering change after each (`change`: an added node or text
 * that passes checkVisibility (a text node's new text counts as added), a RENDER_ATTRIBUTES change on a shown node or
 * one that hides it, or `navigation` at pagehide), and `busy` on/off per signal: `aria-busy`, `progressbar` (a
 * determinate one), `spinner` (an indeterminate progressbar or a rotating infinite animation), `skeleton`, `disabled`
 * (a control that went disabled). Beside the buffer, `document.__argusEase` keeps the page's fetch and XHR requests
 * (`{t, end, status, method, route, keys, same}`: body field names, never values), the clicked controls (`{t, role,
 * name, region}`), the edits in forms, and how many skeletons were replaced by a layout shift.
 */
export const EASE_INIT = String.raw`(() => {
  const doc = document;
  if (doc.__argusEase || typeof doc.__argusTastePush !== "function") return;
  const push = doc.__argusTastePush;
  const now = () => performance.now();
  const S = (doc.__argusEase = { v: 1, requests: [], actions: [], edits: [], shifts: 0, pending: false, roots: new Set() });
  const V = { checkOpacity: true, checkVisibilityCSS: true };
  const shown = (el) => Boolean(el) && el.nodeType === 1 && el.isConnected && (typeof el.checkVisibility !== "function" || el.checkVisibility(V));
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const routeOf = ${ROUTE_OF};
  const formKey = ${FORM_KEY};
  const cap = (list, n, x) => { list.push(x); if (list.length > n) list.shift(); return x; };
  ${LOADER_FNS}
  const REGION = [["dialog", "dialog, [role=dialog], [role=alertdialog]"], ["form", "form, [role=form], [role=search]"], ["nav", "nav, [role=navigation]"], ["header", "header, [role=banner]"], ["footer", "footer, [role=contentinfo]"], ["aside", "aside, [role=complementary]"], ["main", "main, [role=main]"]];
  const TAGS = { a: "link", button: "button", summary: "button", select: "combobox", textarea: "textbox" };
  const CONTROL = "a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=menuitem], [role=tab], [role=option], [role=checkbox], [role=switch], [role=radio]";
  const control = (t, target) => {
    const c = target && target.closest ? target.closest(CONTROL) : null;
    const tag = c ? c.tagName.toLowerCase() : "";
    if (c) cap(S.actions, 100, { t, role: norm(c.getAttribute("role")).split(" ")[0] || (tag === "input" ? (/^(button|submit|reset|image)$/i.test(c.type) ? "button" : c.type) : TAGS[tag] || tag), name: norm(c.getAttribute("aria-label") || (tag === "input" ? c.value : c.innerText || c.textContent) || c.getAttribute("title")).replace(/[0-9]+/g, "#").replace(/\|/g, "/").slice(0, 80), region: (REGION.find(([, q]) => c.closest(q)) || ["page"])[0] });
  };
  let typed = -1e9;
  const onInput = (e) => {
    const type = e.type;
    if ((type !== "submit" && type !== "input" && !e.isTrusted) || (type === "pointerdown" && e.button !== 0) || (type === "keydown" && e.key !== "Enter" && e.key !== " ")) return;
    const t = e.timeStamp > 0 && e.timeStamp <= now() ? e.timeStamp : now();
    if (type === "input" && e.target && e.target.form) cap(S.edits, 100, { t, form: formKey(e.target.form), field: norm(e.target.name).slice(0, 60) });
    const burst = type === "input" && t - typed < 250;
    if (type === "input") typed = t;
    if (burst) return;
    push({ kind: "input", t, type });
    S.pending = true;
    const prior = S.actions[S.actions.length - 1];
    if (type === "click" || type === "dblclick" || (type === "submit" && !(prior && t - prior.t <= 50))) control(t, type === "submit" ? e.submitter || e.target : e.target);
  };
  for (const type of ["pointerdown", "click", "dblclick", "submit", "keydown", "input"]) doc.addEventListener(type, onInput, true);
  const relevant = (m) => {
    if (m.type === "childList") return [...m.addedNodes].some((n) => (n.nodeType === 1 ? shown(n) : n.nodeType === 3 && /\S/.test(n.data) && shown(n.parentElement))) ? ["added", null] : null;
    if (m.type === "characterData") return m.oldValue !== m.target.data && /\S/.test(m.target.data) && shown(m.target.parentElement) ? ["added", null] : null;
    const el = m.target, a = m.attributeName;
    if (m.oldValue === el.getAttribute(a)) return null;
    return shown(el) || (/^(hidden|class|style|open)$/.test(a) && shown(el.parentElement)) ? ["attribute", a] : null;
  };
  const dis = new Set(), on = {}, offs = [], jolts = [];
  // A skeleton gone (offs) and a layout shift within 500 ms after it (jolts), in either order of arrival.
  const match = () => {
    for (let i = offs.length - 1; i >= 0; i--) if (jolts.some((j) => j >= offs[i] - 20 && j <= offs[i] + 500)) { offs.splice(i, 1); S.shifts += 1; } else if (now() - offs[i] > 5000) offs.splice(i, 1);
  };
  const scan = (t) => {
    const c = { "aria-busy": 0, progressbar: 0, spinner: 0, skeleton: 0, disabled: 0, decoration: 0 };
    const all = (q) => [...S.roots].flatMap((r) => [...r.querySelectorAll(q)]);
    for (const el of all('[aria-busy="true"]')) if (shown(el)) c["aria-busy"] += 1;
    for (const el of all("[role=progressbar], progress")) if (shown(el)) c[(el.tagName === "PROGRESS" ? el.hasAttribute("value") : el.hasAttribute("aria-valuenow")) ? "progressbar" : "spinner"] += 1;
    const seen = new Set();
    for (const a of doc.getAnimations ? doc.getAnimations() : []) {
      if (looping(a) && !seen.has(a.effect.target) && shown(a.effect.target) && seen.add(a.effect.target)) c[rotates(a) ? "spinner" : bare(a.effect.target) ? "skeleton" : "decoration"] += 1;
    }
    for (const el of all('[class*="skeleton" i], [class*="shimmer" i]')) if (!seen.has(el) && [...el.classList].some((k) => SKELETON.test(k)) && shown(el) && bare(el)) c.skeleton += 1;
    for (const el of dis) if (!el.isConnected || !el.disabled) dis.delete(el); else if (shown(el)) c.disabled += 1;
    for (const k of ["aria-busy", "progressbar", "spinner", "skeleton", "disabled"]) if ((c[k] > 0) !== Boolean(on[k])) {
      on[k] = c[k] > 0;
      push({ kind: "busy", t, on: on[k], signal: k });
      if (k === "skeleton" && !on[k]) { offs.push(t); match(); }
    }
  };
  let since = null, timer = 0, last = -1e9;
  const mo = new MutationObserver((records) => {
    const t = now();
    for (const m of records) if (m.type === "attributes" && m.attributeName === "disabled") { if (m.oldValue === null && m.target.hasAttribute("disabled")) dis.add(m.target); else dis.delete(m.target); }
    if (S.pending) for (const m of records) { const r = relevant(m); if (r) { push({ kind: "change", t, cause: r[0], attr: r[1] }); S.pending = false; break; } }
    if (since === null) since = t;
    if (!timer) timer = setTimeout(() => { const s = since; timer = 0; since = null; last = now(); scan(s); }, Math.max(0, last + 30 - t));
  });
  // Shadow roots too (web components render there): each one attachShadow makes, once the wrapper below is on.
  (S.observe = (root) => S.roots.add(root) && mo.observe(root, { subtree: true, childList: true, characterData: true, characterDataOldValue: true, attributes: true, attributeOldValue: true, attributeFilter: ${JSON.stringify(EASE_RENDER)} }))(doc);
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.value > 0.001) cap(jolts, 50, e.startTime); match(); }).observe({ type: "layout-shift", buffered: true }); } catch (e) {}
  addEventListener("pagehide", () => { if (S.pending) push({ kind: "change", t: now(), cause: "navigation", attr: null }); });
  if (window.__argusEaseWrapped) return;
  window.__argusEaseWrapped = true;
  const attach = Element.prototype.attachShadow;
  if (typeof attach === "function") Element.prototype.attachShadow = function () { const root = attach.apply(this, arguments); try { document.__argusEase.observe(root); } catch (e) {} return root; };
  // A request body's field names (JSON, form-encoded, URLSearchParams, FormData), never its values.
  const keysOf = (b) => {
    let k = [];
    try { k = typeof b === "string" ? (b.trim().charAt(0) === "{" ? Object.keys(JSON.parse(b)) : /^[^=&\s]+=/.test(b.trim()) ? [...new URLSearchParams(b.trim()).keys()] : []) : b instanceof URLSearchParams || b instanceof FormData ? [...b.keys()] : []; } catch (e) { k = []; }
    return [...new Set(k)].map((x) => String(x).slice(0, 40)).sort().slice(0, 20);
  };
  // The current document's record of a request (null when it has none), and its end; the wrappers change nothing else.
  const rec = (method, url, body) => {
    try { const st = document.__argusEase, u = new URL(String(url), location.href); return st ? cap(st.requests, 200, { t: performance.now(), end: null, status: 0, method: String(method || "GET").toUpperCase(), route: routeOf(u.pathname), keys: keysOf(body), same: u.origin === location.origin }) : null; } catch (e) { return null; }
  };
  const done = (r, status) => { if (r) [r.end, r.status] = [performance.now(), status]; };
  const native = window.fetch;
  if (typeof native === "function") window.fetch = function (input, init) {
    const q = typeof Request === "function" && input instanceof Request ? input : null;
    const r = rec((init && init.method) || (q && q.method), q ? q.url : input, init && init.body), p = native.apply(this, arguments);
    p.then((res) => done(r, res.status), () => done(r, 0));
    return p;
  };
  const X = window.XMLHttpRequest && window.XMLHttpRequest.prototype, open = X && X.open, send = X && X.send;
  if (X) X.open = function (m, u) { this.__argusEaseReq = [m, u]; return open.apply(this, arguments); };
  if (X) X.send = function (b) { const r = this.__argusEaseReq ? rec(this.__argusEaseReq[0], this.__argusEaseReq[1], b) : null; if (r) this.addEventListener("loadend", () => done(r, this.status)); return send.apply(this, arguments); };
})();
`;

/**
 * The in-page ease measurement, `(arg) => result`, run as `(${EASE_SOURCE})(arg)`. Kinds:
 * - `judge` ({screen, rules, cfg}; pure, no DOM) → the screen's findings: `screen` is `{route, events, ease}` (events
 *   the drained buffer of one document, ease a `screen` answer), `rules` the bar's, `cfg` `{off, optimistic}` (taste.json's);
 * - `feedback` ({events, requests, now}; pure) → `{acts, loaders}`, the actions and loaders the clock saw;
 * - `screen` → `{v, now, route, lang, requests, actions, edits, shifts}`;
 * - `rule` ({rule, rules, terms, optimistic}) → `judge`'s findings of that one rule on this page (the buffer read, not drained).
 */
export const EASE_SOURCE = String.raw`(arg) => {
  const A = arg || {};
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const keyOf = (...parts) => parts.map((p) => norm(p).replace(/[0-9]+/g, "#").replace(/\|/g, "/")).join("|").slice(0, 300);
  const routeOf = ${ROUTE_OF};
  const globMatch = (glob, route) => typeof glob === "string" && typeof route === "string" && new RegExp("^" + glob.split(/(\/\*\*$|\*\*|\*)/).map((p) => (p === "/**" ? "(?:/.*)?" : p === "**" ? ".*" : p === "*" ? "[^/]*" : p.replace(/[.+?^$(){}|[\]\\]/g, "\\$&").replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "[^/]+"))).join("") + "$").test(route);
  const LOADERS = ["spinner", "skeleton", "progressbar"];
  const WRITE = (r) => !/^(GET|HEAD|OPTIONS)$/.test(r.method) && typeof r.end === "number" && r.status >= 200 && r.status < 300;
  const feedback = (events, requests, now) => {
    const ev = (Array.isArray(events) ? events : []).filter((x) => x && typeof x.t === "number").slice().sort((a, b) => a.t - b.t);
    const reqs = (Array.isArray(requests) ? requests : []).filter((r) => r && typeof r.t === "number" && r.same !== false);
    const inputs = ev.filter((x) => x.kind === "input");
    const changes = ev.filter((x) => x.kind === "change").map((x) => x.t);
    const busy = ev.filter((x) => x.kind === "busy");
    const horizon = typeof now === "number" ? now : ev.length ? ev[ev.length - 1].t : 0;
    const acts = [];
    inputs.forEach((x, k) => {
      if (!/^(click|dblclick|submit)$/.test(x.type)) return;
      const prev = acts[acts.length - 1];
      if (prev && ((x.type === "submit" && x.t - prev.at <= 50) || (x.type === "dblclick" && x.t - prev.at <= 500))) return;
      const before = inputs[k - 1];
      acts.push({ start: before && /^(pointerdown|keydown)$/.test(before.type) && x.t - before.t <= 1000 ? before.t : x.t, at: x.t });
    });
    for (const a of acts) {
      const next = inputs.find((y) => y.t > a.at && !(y.type === "submit" && y.t - a.at <= 50) && !(y.type === "dblclick" && y.t - a.at <= 500));
      a.end = next ? next.t : null;
      const inside = (t) => t >= a.start && (a.end === null || t < a.end);
      const first = changes.find(inside);
      a.first = first === undefined ? null : first - a.start;
      a.reqs = reqs.filter((r) => r.t >= a.start && r.t <= a.at + 100);
      a.reqEnd = a.reqs.length && a.reqs.every((r) => typeof r.end === "number") ? Math.max(...a.reqs.map((r) => r.end)) : null;
      a.horizon = a.end === null ? horizon : a.end;
      const on = busy.filter((b) => b.on && inside(b.t));
      a.determinate = on.some((b) => b.signal === "progressbar");
      const offs = busy.filter((b) => !b.on && inside(b.t) && on.some((o) => o.signal === b.signal && o.t <= b.t)).map((b) => b.t);
      a.wait = a.reqs.length && (a.reqEnd !== null || offs.length) ? Math.max(a.reqEnd === null ? -Infinity : a.reqEnd, ...offs) - a.start : null;
    }
    const loaders = [];
    const firstInput = inputs.length ? inputs[0].t : Infinity;
    for (const s of LOADERS) {
      let since = null;
      for (const b of busy.filter((x) => x.signal === s)) {
        if (b.on && since === null) since = b.t;
        else if (!b.on && since !== null) {
          const act = acts.find((x) => since >= x.start && (x.end === null || since < x.end));
          const phase = since < firstInput ? "load" : "action";
          loaders.push({ signal: s, phase, shown: b.t - since, wait: phase === "load" ? b.t : act && act.reqEnd !== null ? act.reqEnd - act.start : null });
          since = null;
        }
      }
    }
    return { acts, loaders };
  };
  const judge = (screen, rules, cfg) => {
    const R = new Map((Array.isArray(rules) ? rules : []).map((r) => [r.id, r]));
    const off = new Set((cfg && cfg.off) || []);
    const out = [];
    const th = (id) => (R.get(id) || {}).threshold || {};
    const add = (id, key, measured, expected) => {
      if (!R.has(id) || off.has(id) || out.some((f) => f.rule === id && f.key === key)) return;
      out.push({ rule: id, key, measured: typeof measured === "number" ? Math.round(measured) : norm(measured).slice(0, 120), expected });
    };
    const s = screen || {};
    const e = s.ease || {};
    const route = s.route || e.route || "/";
    const fb = feedback(s.events, e.requests, e.now);
    const worst = (list, f) => list.reduce((m, a) => Math.max(m, f(a)), -Infinity);
    const waits = fb.acts.filter((a) => a.reqs.length && a.first !== null);
    const lat = worst(waits, (a) => a.first);
    if (lat > th("feedback.latency").max) add("feedback.latency", "action", lat, "a visible change within " + th("feedback.latency").max + " ms");
    const uns = worst(waits, (a) => Math.min(a.first, a.reqEnd === null ? Infinity : a.reqEnd - a.start));
    if (uns > th("feedback.busy").max) add("feedback.busy", "action", uns, "a busy signal within " + th("feedback.busy").max + " ms");
    const ind = worst(fb.acts.filter((a) => a.wait !== null && !a.determinate), (a) => a.wait);
    if (ind > th("feedback.progress").max) add("feedback.progress", "action", ind, "a determinate progress bar for a wait past " + th("feedback.progress").max + " ms");
    const fl = th("feedback.loader-flash");
    for (const l of fb.loaders.slice().sort((x, y) => x.shown - y.shown)) if (l.shown < fl.min || (l.wait !== null && l.wait < fl.min_wait)) add("feedback.loader-flash", l.phase + "|" + l.signal, l.shown, "shown at least " + fl.min + " ms, and none for a wait under " + fl.min_wait + " ms");
    if (e.shifts > th("feedback.skeleton-shift").max) add("feedback.skeleton-shift", "skeleton", e.shifts, "content that keeps its skeleton's place");
    const writes = fb.acts.map((a) => ({ a, end: Math.max(...a.reqs.filter(WRITE).map((r) => r.end)) })).filter((w) => w.end > -Infinity);
    const named = th("states.success").max;
    const after = (w) => (w.a.first === null ? null : w.a.start + w.a.first);
    if (((cfg && cfg.optimistic) || []).some((g) => globMatch(g, route))) {
      const late = writes.filter((w) => (after(w) === null ? w.a.horizon - w.end > named : after(w) >= w.end)).length;
      if (late > th("feedback.optimistic").max) add("feedback.optimistic", "action", late, "the change shown before the response");
    }
    return out;
  };
  if (A.kind === "judge") return judge(A.screen, A.rules, A.cfg);
  if (A.kind === "feedback") return feedback(A.events, A.requests, A.now);
  const doc = document;
  const st = doc.__argusEase || null;
  const V = { checkOpacity: true, checkVisibilityCSS: true };
  const shown = (el) => Boolean(el) && el.nodeType === 1 && el.isConnected && (typeof el.checkVisibility !== "function" || el.checkVisibility(V));
  const screen = () => ({ v: 1, now: performance.now(), route: routeOf(location.pathname), lang: norm(doc.documentElement.getAttribute("lang")), requests: st ? st.requests.map((r) => Object.assign({}, r)) : [], actions: st ? st.actions.slice() : [], edits: st ? st.edits.slice() : [], shifts: st ? st.shifts : 0 });
  if (A.kind === "screen") return screen();
  if (A.kind === "rule") {
    const s = screen();
    const events = doc.__argusTasteEvents ? doc.__argusTasteEvents.slice() : [];
    return judge({ route: s.route, events, ease: s }, A.rules, { optimistic: A.optimistic || [] }).filter((f) => f.rule === A.rule);
  }
  throw new Error("failed: ease: no kind " + String(A.kind).slice(0, 40));
}`;

// ---------------------------------------------------------------------------------------------------
// The Node side.

const BAR = JSON.parse(readFileSync(new URL("../data/taste-bar.json", import.meta.url), "utf8"));
const MINE = BAR.rules.filter((r) => ["feedback", "states", "copy", "consistent", "efficiency"].includes(r.family));
const TERMS = (MINE.find((r) => r.id === "copy.vague") || {}).terms || {};
const easeFn = new Function(`return (${EASE_SOURCE});`)();
/** The suite's ease checks, as argus-live-layout.mjs registers its own: `{name, project, when, source, emit}`. */
export const CHECKS = [];

/** A path's cost (decision 3) from its steps and their replay geometry → `{actions, typed, modals, fitts_bits, klm_s}`. */
export function pathCost(steps, geometry) {
  throw new Error("refused: pathCost: not built yet");
}

/** The ease measurements of `page` (a Playwright Page) → EASE_SOURCE's `screen` answer, with the bar's vague terms. */
export async function easeOf(page) {
  return page.evaluate(`(${EASE_SOURCE})(${JSON.stringify({ kind: "screen", terms: TERMS })})`);
}

/**
 * The per-screen findings `[{rule, key, measured, expected}]` of `screen` against `bar` and `cfg` (loadTaste's): `screen`
 * is `{route, events, ease}` (route the screen's template, events the drained buffer of its document, ease easeOf's or
 * the `screen` kind's answer).
 */
export function rulesFor(screen, bar, cfg) {
  return easeFn({ kind: "judge", screen, rules: (bar && bar.rules) || [], cfg: cfg || {} });
}

/** Screen rules no page expression can measure alone: their measurement needs a driver or the cycle's peers. */
const NOT_ON_A_PAGE = { "states.recovery": "a form case drives it", "feedback.skeleton-peers": "it compares a screen with its peers" };

/** A page expression → the findings `[{rule, key, measured, expected}]` of one screen rule of this module's families on the current page. */
export function ruleExpression(rule) {
  // Decision 14's AI-surface rules are the ease probe's family, but no task of phase 7 builds their probe.
  if (BAR.rules.some((x) => x.id === rule && x.family === "ai")) throw new Error(`refused: ruleExpression: ${rule}: not built yet`);
  const r = MINE.find((x) => x.id === rule);
  if (!r || ["consistent", "efficiency"].includes(r.family)) throw new Error(`refused: ruleExpression: ${String(rule).slice(0, 60)} is not a screen rule of the ease probe`);
  if (NOT_ON_A_PAGE[rule]) throw new Error(`refused: ruleExpression: ${rule} has no page expression: ${NOT_ON_A_PAGE[rule]}`);
  return `(${EASE_SOURCE})(${JSON.stringify({ kind: "rule", rule, rules: MINE, terms: TERMS })})`;
}
