// argus-live-ease.mjs — the ease probes of the taste pass (spec §20.2: perceived performance, states and microcopy,
// consistency, efficiency). A leaf module (it reads the plugin's bar file, no other argus-live module). EASE_INIT, in
// the session hook's init payload, records each document's actions, first visible changes and busy signals into the
// taste buffer, and its requests, clicked controls and edits beside it (`document.__argusEase`); EASE_SOURCE measures
// a screen and judges a recorded one (`kind: "judge"`, no DOM, so Node runs it too); the Node exports price a path
// (pathCost) and compare a cycle's screens (crossRules). A finding is `{rule, key, measured, expected}`, its key page
// text (fenced wherever printed) with digit runs `#`. Precision first: a feedback rule measures only an action that
// started a same-origin request and showed a change before the user's next input; a change counts only when it renders
// (an added node, or a RENDER_ATTRIBUTES change on a node that passes checkVisibility, never `data-*`); a rule that
// cannot decide stays silent.
import { readFileSync } from "node:fs";

/** argus-live-tastecfg.mjs TASTE_KEY_MARK (a leaf cannot import it; a test pins the two equal): the lane's taste key goes in its place. */
const KEY_MARK = "@@argus-taste-key@@";
/** argus-live-tastecfg.mjs RENDER_ATTRIBUTES (a leaf cannot import it; a test pins the two equal). */
export const EASE_RENDER = ["class", "style", "hidden", "aria-hidden", "open", "disabled", "aria-expanded", "aria-selected", "aria-busy"];
/** A request's route template: numeric, uuid and long token segments become `:id`. */
const ROUTE_OF = String.raw`(p) => String(p || "/").split("?")[0].split("/").map((s) => (/^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || (s.length >= 16 && /\d/.test(s) && /^[A-Za-z0-9_-]+$/.test(s)) ? ":id" : s)).join("/")`;
/** A form's key: its label, name or id, else its first heading or legend (digit runs `#`). */
const FORM_KEY = String.raw`(f) => String(f.getAttribute("aria-label") || f.getAttribute("name") || f.id || (f.querySelector("h1, h2, h3, h4, legend") || {}).textContent || "form").replace(/\s+/g, " ").trim().replace(/[0-9]+/g, "#").slice(0, 60)`;
/**
 * A control's name that never reads what a user typed (a value, an editable box's text): a field (an input that is no
 * button, a textarea, a select, an editable box) by its aria-label, its labels' own words or its name attribute; a
 * button-type input by its value; any other control by its text.
 */
const NAME_OF = String.raw`(c) => {
    const n = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    const tag = c.tagName.toLowerCase();
    const words = (l) => [...l.childNodes].filter((x) => x.nodeType === 3 || (x.nodeType === 1 && !x.matches("input, select, textarea, [contenteditable]"))).map((x) => x.textContent).join(" ");
    if (tag === "input" && /^(button|submit|reset)$/i.test(c.type)) return n(c.getAttribute("aria-label") || c.value || c.getAttribute("title"));
    if (tag === "input" || tag === "textarea" || tag === "select" || c.isContentEditable) return n(c.getAttribute("aria-label") || [...(c.labels || [])].map(words).join(" ") || c.getAttribute("name") || c.getAttribute("title") || (tag === "input" ? c.getAttribute("alt") : ""));
    return n(c.getAttribute("aria-label") || c.innerText || c.textContent || c.getAttribute("title"));
  }`;
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
 * one that hides it, `focus` when focus moves to a shown element other than the action's own target, or `navigation`
 * at pagehide), and `busy` on/off per signal: `aria-busy`, `progressbar` (a
 * determinate one), `spinner` (an indeterminate progressbar or a rotating infinite animation), `skeleton`, `disabled`
 * (a control that went disabled). Beside the buffer, `document.__argusEase` keeps the page's fetch and XHR requests
 * (`{t, end, status, method, route, keys, same}`: body field names, never values), the clicked controls (`{t, role,
 * name, region}`), the edits in forms, and how many skeletons were replaced by a layout shift.
 */
export const EASE_INIT = String.raw`(() => {
  const doc = document;
  if (Object.prototype.hasOwnProperty.call(doc, "__argusEase") || typeof doc.__argusTastePush !== "function") return;
  const KEY = "${KEY_MARK}";
  const push = (rec) => doc.__argusTastePush(rec, KEY);
  const now = () => performance.now();
  const S = { v: 1, requests: [], actions: [], edits: [], shifts: 0, pending: false };
  const roots = new Set();
  // Fixed properties a page cannot replace: what the probes read, as a copy (writing to it changes nothing), and the
  // live record only with the taste key (the request wrappers write to it).
  const fix = (name, desc) => Object.defineProperty(doc, name, { ...desc, configurable: false, enumerable: false });
  fix("__argusEase", { get: () => ({ v: S.v, requests: S.requests.map((r) => Object.assign({}, r)), actions: S.actions.map((a) => Object.assign({}, a)), edits: S.edits.map((e) => Object.assign({}, e)), shifts: S.shifts, pending: S.pending, observe: S.observe }) });
  fix("__argusEaseLive", { value: (key) => (key === KEY ? S : null), writable: false });
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
  const nameOf = ${NAME_OF};
  // A control in an empty state's region (an empty list or table beside it, or a box named empty): its own way to start.
  const EMPTY_LIST = "ul, ol, [role=list], [role=listbox], [role=feed], table, [role=table], [role=grid]";
  const emptyState = (c) => {
    if (c.closest('[class*="empty" i], [data-empty]')) return true;
    const box = c.closest("section, article, aside, [role=region]");
    return Boolean(box) && [...box.querySelectorAll(EMPTY_LIST)].some((l) => !l.querySelector("li, [role=listitem], [role=option], [role=article], article, td, [role=cell], [role=gridcell]"));
  };
  const control = (t, target) => {
    const c = target && target.closest ? target.closest(CONTROL) : null;
    const tag = c ? c.tagName.toLowerCase() : "";
    if (c) cap(S.actions, 100, { ...(emptyState(c) ? { empty: true } : {}), t, role: norm(c.getAttribute("role")).split(" ")[0] || (tag === "input" ? (/^(button|submit|reset|image)$/i.test(c.type) ? "button" : c.type) : TAGS[tag] || tag), name: nameOf(c).replace(/[0-9]+/g, "#").replace(/\|/g, "/").slice(0, 80), region: (REGION.find(([, q]) => c.closest(q)) || ["page"])[0] });
  };
  let typed = -1e9, acted = null;
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
    acted = e.target;
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
    const all = (q) => [...roots].flatMap((r) => [...r.querySelectorAll(q)]);
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
    // After a write answered 2xx: the first change that can name the new state (a busy toggle cannot), for states.success.
    if (S.answered && !S.pending) for (const m of records) { const r = relevant(m); if (r && !(r[0] === "attribute" && /^(disabled|aria-busy)$/.test(r[1]))) { push({ kind: "change", t, cause: r[0], attr: r[1] }); S.answered = false; break; } }
    if (since === null) since = t;
    if (!timer) timer = setTimeout(() => { const s = since; timer = 0; since = null; last = now(); scan(s); }, Math.max(0, last + 30 - t));
  });
  // Shadow roots too (web components render there): each one attachShadow makes, once the wrapper below is on.
  (S.observe = (root) => roots.add(root) && mo.observe(root, { subtree: true, childList: true, characterData: true, characterDataOldValue: true, attributes: true, attributeOldValue: true, attributeFilter: ${JSON.stringify(EASE_RENDER)} }))(doc);
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.value > 0.001) cap(jolts, 50, e.startTime); match(); }).observe({ type: "layout-shift", buffered: true }); } catch (e) {}
  addEventListener("pagehide", () => { if (S.pending) push({ kind: "change", t: now(), cause: "navigation", attr: null }); });
  // A focus move is visible feedback (decision 10): to a shown element that is not the action's own control, which
  // takes focus on the click itself.
  doc.addEventListener("focusin", (e) => {
    const el = e.target;
    if (!S.pending || el !== doc.activeElement || !shown(el) || (acted && acted.nodeType === 1 && (acted === el || acted.contains(el) || el.contains(acted)))) return;
    push({ kind: "change", t: now(), cause: "focus", attr: null });
    S.pending = false;
  }, true);
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
    try { const st = typeof document.__argusEaseLive === "function" ? document.__argusEaseLive(KEY) : null, u = new URL(String(url), location.href); return st ? cap(st.requests, 200, { t: performance.now(), end: null, status: 0, method: String(method || "GET").toUpperCase(), route: routeOf(u.pathname), keys: keysOf(body), same: u.origin === location.origin }) : null; } catch (e) { return null; }
  };
  const done = (r, status) => {
    if (!r) return;
    [r.end, r.status] = [performance.now(), status];
    const live = typeof document.__argusEaseLive === "function" ? document.__argusEaseLive(KEY) : null;
    if (live && r.same && !/^(GET|HEAD|OPTIONS)$/.test(r.method) && status >= 200 && status < 300) live.answered = true;
  };
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
 *   the drained buffer of one document, ease a `screen` answer, optionally with `error` and `recovery`), `rules` the
 *   bar's, `cfg` `{off, optimistic}` (taste.json's);
 * - `feedback` ({events, requests, now}; pure) → `{acts, loaders}`, the actions and loaders the clock saw;
 * - `screen` ({terms, vague, palette?}) → `{v, now, route, lang, requests, actions, edits, shifts, copy, vague, empty,
 *   exits, footers, forms, palette?}`: `terms` the bar's copy.vague terms per language, `vague` the owner's labels
 *   (any language); `palette: true` adds the palette probe (it sends a synthetic Mod+K, then Escape);
 * - `error` → `{blank, loader, exit}` of the page as it stands (the caller routed the fault and waited);
 * - `fields` ({form}) → the form's fields as `{i, key, filled, need, text, digest}` (a value's digest, never the value);
 * - `palette` → `{opens, closed?}` or null while a dialog is open;
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
    // The new state is named only by a change after the write answered, before the next input: a control disabled and
    // enabled again, or busy, names nothing, nor does text shown while the request ran.
    const naming = (Array.isArray(s.events) ? s.events : []).filter((x) => x && x.kind === "change" && typeof x.t === "number" && !(x.cause === "attribute" && /^(disabled|aria-busy)$/.test(x.attr || "")));
    // On a route the owner declared optimistic, the change made before the answer is the naming (decision 10).
    const optimistic = ((cfg && cfg.optimistic) || []).some((g) => globMatch(g, route));
    const shownAfter = (w) => naming.filter((x) => x.t >= (optimistic ? w.a.start : w.end) && (w.a.end === null || x.t < w.a.end)).reduce((m, x) => (m === null || x.t < m ? x.t : m), null);
    const unnamed = worst(writes.filter((w) => (shownAfter(w) === null ? w.a.horizon - w.end > named : shownAfter(w) > w.end + named)), (w) => (shownAfter(w) === null ? w.a.horizon : Math.max(shownAfter(w), w.end)) - w.end);
    if (unnamed > named) add("states.success", "action", unnamed, "the new state named within " + named + " ms");
    if (((cfg && cfg.optimistic) || []).some((g) => globMatch(g, route))) {
      const late = writes.filter((w) => (after(w) === null ? w.a.horizon - w.end > named : after(w) >= w.end)).length;
      if (late > th("feedback.optimistic").max) add("feedback.optimistic", "action", late, "the change shown before the response");
    }
    for (const c of e.copy || []) add("copy.broken", c.key, c.text, "no unrendered value");
    for (const v of e.vague || []) add("copy.vague", v.key, v.name, "a label that names its result");
    for (const x of e.empty || []) add("states.empty-next", x.key, "no control in the empty state", "a next step in the empty state");
    for (const x of e.exits || []) add("states.error-exit", x.key, "no control in its region", "a way on beside the error");
    const er = e.error;
    const dead = er && er.faulted ? (er.loader ? "endless loader" : er.blank ? "blank main" : !er.exit ? "no control to retry or leave" : null) : null;
    if (dead) add("states.error", "error-state", dead, "an error state with a way to retry or leave");
    for (const x of e.recovery || []) add("states.recovery", x.key, "lost", "the value typed before the rejected submit");
    return out;
  };
  if (A.kind === "judge") return judge(A.screen, A.rules, A.cfg);
  if (A.kind === "feedback") return feedback(A.events, A.requests, A.now);
  const doc = document;
  const st = doc.__argusEase || null;
  // The document's buffered records (the taste key's), never drained here.
  const peek = () => (typeof doc.__argusTastePeek === "function" ? doc.__argusTastePeek("${KEY_MARK}") || [] : []);
  const V = { checkOpacity: true, checkVisibilityCSS: true };
  const shown = (el) => Boolean(el) && el.nodeType === 1 && el.isConnected && (typeof el.checkVisibility !== "function" || el.checkVisibility(V));
  const formKey = ${FORM_KEY};
  ${LOADER_FNS}
  const tag = (el) => el.tagName.toLowerCase();
  const safeName = ${NAME_OF};
  const nameOf = (el) => norm((el.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => (doc.getElementById(id) || {}).textContent || "").join(" ")) || safeName(el);
  const CTRL = "a[href], button, input[type=button], input[type=submit], input[type=reset], [role=button], [role=link]";
  const controls = (root) => (root ? [...root.querySelectorAll(CTRL)].filter((c) => shown(c) && !c.disabled) : []);
  const DIALOG = "dialog, [role=dialog], [role=alertdialog]";
  // A value word (undefined, NaN, null) is broken copy only where a value stands: an element's whole text, a field's
  // whole value, or right after a value's marker ("Total: NaN", "= null", "$undefined"); never inside prose, never in a
  // reference table's value column (Default, Type, Returns...), never a word part ("NaN-safe"). A "{{ }}" is not broken
  // inside a block about templates or syntax.
  const TOKENS = [["undefined", /^\s*undefined\s*$|(^|[:=$€£¥(])\s*undefined(?![\w-])/, true], ["NaN", /^\s*NaN\s*$|(^|[:=$€£¥(])\s*NaN(?![\w-])/, true], ["[object Object]", /\[object Object\]/], ["Invalid Date", /\bInvalid Date\b/], ["{{", /\{\{\s*[\w.$]+\s*\}\}/], ["%s", /(^|\s)%s(?=$|[\s.,:;!?)])/], ["null", /^\s*null\s*$|(^|[:=$€£¥(])\s*null(?=\s*($|[),.;:!?\]]))/, true]];
  const BLOCK = "p, li, td, th, dd, dt, h1, h2, h3, h4, h5, h6, label, button, a, figcaption, legend";
  const valueColumn = (el) => {
    const td = el.closest("td");
    const table = td && td.closest("table");
    const head = table && table.querySelector("thead tr");
    const th = head ? head.children[[...td.parentElement.children].indexOf(td)] : null;
    return Boolean(th) && /default|value|type|return|example/i.test(th.textContent || "");
  };
  const copy = () => {
    const out = [];
    const SKIP = "script, style, noscript, template, code, pre, kbd, samp, var, textarea, [contenteditable]";
    const check = (text, el, attr, name) => {
      const block = norm((el.closest(BLOCK) || el).innerText || text);
      const hit = TOKENS.find(([word, re, valueWord]) => re.test(text) && !(valueWord && !attr && valueColumn(el)) && !(word === "{{" && /template|syntax|interpolat|placeholder|mustache|handlebars/i.test(block)));
      if (!hit) return;
      const ctx = (name || (attr ? text : block)).slice(0, 80);
      const key = keyOf(hit[0], ctx.slice(0, 60));
      if (out.length < 50 && !out.some((o) => o.key === key)) out.push({ key, text: ctx });
    };
    if (!doc.body) return out;
    const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.parentElement && /\S/.test(n.data) && !n.parentElement.closest(SKIP) && shown(n.parentElement)) check(n.data, n.parentElement);
    for (const el of doc.querySelectorAll("input[placeholder], textarea[placeholder]")) if (shown(el)) check(el.getAttribute("placeholder"), el, true);
    for (const el of doc.querySelectorAll("input[type=button], input[type=submit]")) if (shown(el)) check(el.value, el, true);
    // A field showing a value word as its whole value (read to compare, never kept: the key names the field's label).
    for (const el of doc.querySelectorAll("input:not([type]), input[type=text], input[type=number], input[type=email], input[type=search], input[type=tel], input[type=url]")) if (shown(el) && /^\s*(undefined|NaN|null)\s*$/.test(el.value)) check(el.value, el, true, safeName(el));
    return out;
  };
  // The labels a vague one is named from: the owner's, and the bar's for the page's language (none: not measured).
  const vagueWords = () => {
    const lang = norm(doc.documentElement.getAttribute("lang")).toLowerCase();
    const words = [...(Array.isArray(A.vague) ? A.vague : [])];
    for (const [l, list] of Object.entries(A.terms || {})) if (lang === l.toLowerCase() || lang.startsWith(l.toLowerCase() + "-")) words.push(...list);
    return new Set(words.map((x) => norm(x).toLowerCase()));
  };
  const vague = () => {
    const want = vagueWords();
    const out = [], seen = new Set();
    const pick = (where, list) => {
      for (const c of [...list].filter((x) => !seen.has(x) && seen.add(x) && shown(x))) if (want.has(nameOf(c).toLowerCase()) && !out.some((o) => o.key === keyOf(where, nameOf(c)))) out.push({ key: keyOf(where, nameOf(c)), name: nameOf(c) });
    };
    if (!want.size) return out;
    // A vague label commits an action whose object the page names: never the one button of an informational dialog
    // (an acknowledgement), nor a sign-in step's submit (Continue on a form of credentials alone).
    const BUTTONS = "button, [role=button], input[type=button], input[type=submit]";
    for (const d of doc.querySelectorAll(DIALOG)) if (shown(d) && [...d.querySelectorAll(BUTTONS)].filter(shown).length > 1) pick("dialog", d.querySelectorAll(BUTTONS));
    const CREDENTIAL = "input[type=password], input[type=email], input[autocomplete~=username], input[autocomplete~=one-time-code], input[autocomplete~=email], input[name*=otp i]";
    const signIn = (f) => { const fields = [...f.elements].filter((x) => /^(INPUT|SELECT|TEXTAREA)$/.test(x.tagName) && !/^(hidden|submit|button|reset|checkbox)$/i.test(x.type) && shown(x)); return fields.length > 0 && fields.every((x) => x.matches(CREDENTIAL)); };
    for (const f of doc.querySelectorAll("form")) if (!signIn(f) && !f.closest(DIALOG)) pick("form", f.querySelectorAll("button:not([type]), button[type=submit], input[type=submit]"));
    return out;
  };
  const boxOf = (el) => el.closest("section, article, main, aside, form, [role=region], [role=main], [role=complementary], [role=form], [role=search]") || el.parentElement;
  const empty = () => {
    const out = [];
    const HEAD = "h1, h2, h3, h4, h5, h6, [role=heading], caption, legend, script, style, noscript";
    for (const el of doc.querySelectorAll("table, [role=table], [role=grid], ul, ol, [role=list], [role=listbox], [role=feed]")) {
      if (el.getAttribute("aria-busy") === "true" || !shown(el) || el.closest("nav, [role=navigation], header, footer, [role=banner], [role=contentinfo]")) continue;
      const headed = (r) => Boolean(r.closest("thead")) || (Boolean(r.querySelector("th, [role=columnheader]")) && !r.querySelector("td, [role=cell], [role=gridcell]"));
      const grid = tag(el) === "table" || /^(table|grid)$/.test(el.getAttribute("role") || "");
      const data = [...el.querySelectorAll("tr, [role=row]")].filter((r) => !headed(r));
      const note = grid && data.length === 1 && data[0].querySelectorAll("td, [role=cell], [role=gridcell]").length === 1 ? data[0] : null;
      if (grid ? !el.querySelector("thead, th, [role=columnheader]") || (data.length && !note) : el.querySelectorAll("li, [role=listitem], [role=option], [role=article], article").length > 0) continue;
      const box = boxOf(el);
      const own = (n) => !el.contains(n) || (note && note.contains(n));
      const w = doc.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      let text = false;
      for (let n = w.nextNode(); n && !text; n = w.nextNode()) text = Boolean(n.parentElement) && own(n.parentElement) && !n.parentElement.closest(HEAD) && /\p{L}/u.test(n.data) && shown(n.parentElement);
      if (!text || controls(box).some(own)) continue;
      out.push({ key: keyOf(el.getAttribute("role") || tag(el), el.getAttribute("aria-label") || norm((el.querySelector("caption, th, [role=columnheader]") || {}).textContent) || tag(el)) });
    }
    return out;
  };
  const exits = () => [...doc.querySelectorAll("[role=alert]")].filter((el) => shown(el) && /\p{L}/u.test(el.textContent || "") && !controls(boxOf(el)).length).slice(0, 20).map((el) => ({ key: keyOf("alert", norm(el.textContent).slice(0, 60)) }));
  const loaderNow = () => [...doc.querySelectorAll('[aria-busy="true"], [role=progressbar]:not([aria-valuenow]), progress:not([value])')].some(shown) || (doc.getAnimations ? doc.getAnimations() : []).some((a) => looping(a) && shown(a.effect.target) && (rotates(a) || bare(a.effect.target)));
  const errorState = () => {
    const main = doc.querySelector("main, [role=main]") || doc.body;
    let text = false;
    const w = doc.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n && !text; n = w.nextNode()) text = /[\p{L}\p{N}]/u.test(n.data) && Boolean(n.parentElement) && !n.parentElement.closest("script, style, noscript, template") && shown(n.parentElement);
    // Content the walker cannot read (media, a frame, a custom element's shadow) is never blank.
    const media = [...main.querySelectorAll("*")].some((m) => (/^(IMG|SVG|CANVAS|VIDEO|IFRAME|OBJECT|EMBED)$/i.test(m.tagName) || m.tagName.includes("-")) && shown(m) && m.getBoundingClientRect().width > 48 && m.getBoundingClientRect().height > 0);
    return { blank: !text && !media && !controls(main).length, loader: loaderNow(), exit: controls(doc.body).length > 0 };
  };
  const SUBMIT = "button:not([type]), button[type=submit], input[type=submit]";
  const forms = () => [...doc.querySelectorAll("form")].filter(shown).slice(0, 20).map((f) => ({ key: formKey(f), submit: [...f.querySelectorAll(SUBMIT)].some(shown), fields: [...new Set([...f.elements].map((x) => norm(x.name)).filter(Boolean))].slice(0, 30) }));
  // The first opaque background from el up (a button that paints its own is filled).
  const paint = (el) => { for (let p = el; p; p = p.parentElement) { const c = getComputedStyle(p).backgroundColor, m = c.match(/rgba?\(([^)]+)\)/); if (m && Number((m[1].split(",")[3] || "1").trim()) >= 0.5) return c; } return "rgb(255, 255, 255)"; };
  const footers = () => {
    const out = [];
    const BTN = "button, [role=button], input[type=submit], input[type=button], input[type=reset]";
    const boxes = [...doc.querySelectorAll(DIALOG)].filter(shown).map((d) => ["dialog", d]).concat([...doc.querySelectorAll("form")].filter((f) => shown(f) && !f.closest(DIALOG)).map((f) => ["form", f]));
    for (const [kind, box] of boxes) {
      const btns = [...box.querySelectorAll(BTN)].filter(shown), at = (b) => b.getBoundingClientRect();
      const row = btns.filter((b) => Math.abs(at(b).top - Math.max(...btns.map((x) => at(x).top))) <= 8).sort((x, y) => at(x).left - at(y).left);
      if (row.length < 2) continue;
      const ground = paint(box);
      const submits = row.filter((b) => b.form && b.type === "submit");
      const filled = row.filter((b) => getComputedStyle(b).backgroundColor === paint(b) && paint(b) !== ground);
      const primary = submits.length === 1 ? submits[0] : filled.length === 1 ? filled[0] : null;
      const i = row.indexOf(primary);
      if (i === 0 || (i > 0 && i === row.length - 1)) out.push({ kind, position: i === 0 ? "first" : "last", name: nameOf(primary).replace(/[0-9]+/g, "#").slice(0, 60) });
    }
    return out;
  };
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  const palette = async () => {
    if ([...doc.querySelectorAll(DIALOG)].some(shown)) return null;
    const OPEN = "dialog, [role=dialog], [role=combobox], [role=listbox], [role=searchbox], input[type=search]";
    const before = new Set([...doc.querySelectorAll(OPEN)].filter(shown));
    const focus = doc.activeElement;
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || "");
    doc.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }));
    await pause(300);
    const opened = [...doc.querySelectorAll(OPEN)].filter((x) => shown(x) && !before.has(x));
    if (!opened.length && (doc.activeElement === focus || !doc.activeElement || !doc.activeElement.matches(OPEN + ", input"))) return { opens: false };
    (doc.activeElement || doc.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    await pause(300);
    return { opens: true, closed: !opened.some(shown) };
  };
  const digest = (v) => { let h = 2166136261; for (let i = 0; i < v.length; i++) h = Math.imul(h ^ v.charCodeAt(i), 16777619) >>> 0; return h.toString(16); };
  const fields = (at) => {
    const f = doc.forms[at];
    if (!f || !f.isConnected) return null;
    return [...f.elements].map((x, i) => ({ x, i })).filter(({ x }) => /^(INPUT|SELECT|TEXTAREA)$/.test(x.tagName) && !/^(hidden|submit|button|reset|image|file|password)$/i.test(x.type) && shown(x) && !x.disabled).map(({ x, i }) => {
      const box = /^(checkbox|radio)$/i.test(x.type);
      const v = box ? String(x.checked) : String(x.value);
      return { i, key: norm((x.labels && x.labels[0] && x.labels[0].textContent) || x.getAttribute("aria-label") || x.name || x.placeholder).replace(/[0-9]+/g, "#").slice(0, 60), filled: box ? x.checked : v !== "", need: (x.required || x.getAttribute("aria-required") === "true") && (f.noValidate || !x.required), text: !box && x.tagName !== "SELECT", box, digest: digest(v) };
    });
  };
  // The bar-class rules' own numbers (calibration's bands and the judge's witness read each by its metric name): counts
  // of what the screen kind found, and, from the document's buffer as it stands, the slowest first change after an
  // action that sent a request (feedback.latency) and the shortest loader shown (feedback.loader-flash) when there is one.
  const metricsOf = (s) => {
    const m = { empty_states_without_control: s.empty.length, errors_without_exit: s.exits.length };
    if (vagueWords().size) m.vague_labels = s.vague.length;
    const fb = feedback(peek(), s.requests, s.now);
    const waits = fb.acts.filter((a) => a.reqs.length && a.first !== null).map((a) => a.first);
    if (waits.length) m.first_change_ms = Math.round(Math.max(...waits));
    if (fb.loaders.length) m.loader_shown_ms = Math.round(Math.min(...fb.loaders.map((l) => l.shown)));
    return m;
  };
  const screen = () => {
    const s = { v: 1, now: performance.now(), route: routeOf(location.pathname), lang: norm(doc.documentElement.getAttribute("lang")), requests: st ? st.requests.map((r) => Object.assign({}, r)) : [], actions: st ? st.actions.slice() : [], edits: st ? st.edits.slice() : [], shifts: st ? st.shifts : 0, copy: copy(), vague: vague(), empty: empty(), exits: exits(), footers: footers(), forms: forms() };
    s.metrics = metricsOf(s);
    return s;
  };
  if (A.kind === "screen") return A.palette ? palette().then((p) => Object.assign(screen(), { palette: p })) : screen();
  if (A.kind === "error") return errorState();
  if (A.kind === "fields") return fields(A.form);
  if (A.kind === "palette") return palette();
  if (A.kind === "rule") {
    const s = screen();
    if (A.rule === "states.error") s.error = Object.assign({ faulted: true }, errorState());
    const events = peek();
    return judge({ route: s.route, events, ease: s }, A.rules, { optimistic: A.optimistic || [] }).filter((f) => f.rule === A.rule);
  }
  throw new Error("failed: ease: no kind " + String(A.kind).slice(0, 40));
}`;

/**
 * D12's routed fault, `async (page, origin) => {faulted(), off()}`: armed BEFORE the navigation to the screen (Task 0.1),
 * it answers the screen's first same-origin JSON GET (fetch or XHR) with a 500. A request whose Accept names JSON is
 * answered without reaching the app or the proxy; another is fetched once (a GET) to read its content-type, and passes
 * unless that says JSON. `faulted()` is the path answered (null: none), `off()` removes the route.
 */
export const FAULT_SOURCE = String.raw`async (page, origin) => {
  let faulted = null;
  const fault = (route, url) => (faulted = new URL(url).pathname) && route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "argus: a routed fault" }) });
  const handler = async (route) => {
    const q = route.request();
    if (faulted !== null || q.method() !== "GET" || !/^(fetch|xhr)$/.test(q.resourceType()) || new URL(q.url()).origin !== origin) return route.fallback();
    if (/json/i.test(q.headers()["accept"] || "")) return fault(route, q.url());
    let res;
    try { res = await route.fetch(); } catch (e) { return route.fallback(); }
    return faulted === null && /\bjson\b/i.test(res.headers()["content-type"] || "") ? fault(route, q.url()) : route.fulfill({ response: res });
  };
  await page.route("**/*", handler);
  return { faulted: () => faulted, off: () => page.unroute("**/*", handler) };
}`;

/**
 * D12's form case, `async (page, submit, ease) => lost | null` (`submit` a Locator, `ease` EASE_SOURCE's function):
 * the first required field holding a value that the browser will not check itself (the form is novalidate, or the
 * field only aria-required) is emptied and the submit clicked; every other field whose value then changed is lost
 * (`[{key}]`, the field's label). Every value is put back. null when there is no such field or form, when a write was
 * accepted (phase 6's a11y case reports that), or when the form is gone.
 */
export const RECOVERY_SOURCE = String.raw`async (page, submit, ease) => {
  if ((await submit.count()) !== 1) return null;
  const at = await submit.evaluate((b) => [...document.forms].indexOf(b.form || b.closest("form")));
  const before = at < 0 ? null : await page.evaluate(ease, { kind: "fields", form: at });
  const c = before && before.find((x) => x.need && x.filled && x.text);
  if (!c) return null;
  const handle = async (i) => (await page.evaluateHandle((a) => document.forms[a[0]] && document.forms[a[0]].elements[a[1]], [at, i])).asElement();
  const kept = before.filter((x) => x.filled), values = [];
  for (const x of kept) values.push(x.box ? null : await (await handle(x.i)).inputValue());
  let accepted = false;
  const seen = (r) => { if (r.request().method() !== "GET" && r.status() >= 200 && r.status() < 300) accepted = true; };
  page.on("response", seen);
  try {
    await (await handle(c.i)).fill("");
    await submit.click();
    try { await page.waitForResponse((r) => r.request().method() !== "GET", { timeout: 800 }); } catch (e) {}
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const after = accepted ? null : await page.evaluate(ease, { kind: "fields", form: at }).catch(() => null);
    if (!after) return null;
    const gone = kept.filter((x) => x.i !== c.i && !after.some((y) => y.i === x.i && y.digest === x.digest));
    for (let j = 0; j < kept.length; j++) {
      const x = kept[j];
      if (x.i !== c.i && !gone.includes(x)) continue;
      const h = await handle(x.i);
      if (h) await (x.box ? h.setChecked(true) : x.text ? h.fill(values[j]) : h.selectOption(values[j])).catch(() => null);
    }
    return gone.map((x) => ({ key: x.key }));
  } finally {
    page.off("response", seen);
  }
}`;

// ---------------------------------------------------------------------------------------------------
// The Node side.

const BAR = JSON.parse(readFileSync(new URL("../data/taste-bar.json", import.meta.url), "utf8"));
const MINE = BAR.rules.filter((r) => ["feedback", "states", "copy", "consistent", "efficiency"].includes(r.family));
const TERMS = (MINE.find((r) => r.id === "copy.vague") || {}).terms || {};
const easeFn = new Function(`return (${EASE_SOURCE});`)();

// Decision 3's operators (Kieras' KLM) and the pointer's throughput (MacKenzie: 4.9 bits/s is typical for a mouse).
const K = 0.28, BB = 0.2, H = 0.4, M = 1.2, P_MEAN = 1.1, P_MIN = 0.8, P_MAX = 1.5, THROUGHPUT = 4.9;
/** The steps a path's user does with the pointer, and the clicks each costs (hover only points). */
const POINTED = { click: 1, dblclick: 2, check: 1, uncheck: 1, fill: 1, select: 2, hover: 0 };
const round2 = (x) => Math.round(x * 100) / 100;

/**
 * A path's cost (decision 3) → `{actions, typed, modals, fitts_bits, klm_s}`. `geometry` is `{goals, targets}` or the
 * bare `targets`: each step's target box `{x, y, width, height, dialog?}` in the replay (index-aligned with `steps`, or
 * keyed by `n`; `dialog` the open dialog's name); `goals` the journey's map goal steps, one M each (else one per path
 * `expect`). Actions are the pointer steps, `press` and `go-back`. K per character and per key of a chord; P from Fitts
 * (ID = log2(A/W + 1), A between the previous and this target's centres, W this one's smaller side) as ID / 4.9 bounded
 * to 0.8-1.5 s, else Kieras' mean 1.1 s; BB per click; H per hand move; a select's option the short bound (it opens
 * beside the control). `modals`: dialogs whose steps fill no field.
 */
export function pathCost(steps, geometry) {
  if (!Array.isArray(steps)) throw new Error("failed: pathCost: steps must be an array");
  const g = Array.isArray(geometry) ? { targets: geometry } : geometry && typeof geometry === "object" ? geometry : {};
  const boxOf = (s, k) => {
    const b = Array.isArray(g.targets) ? g.targets[k] : g.targets && g.targets[s.n];
    return b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && Math.min(b.width, b.height) > 0 ? b : null;
  };
  let actions = 0, typed = 0, modals = 0, bits = 0, secs = 0, hand = "pointer", prev = null, episode = null;
  steps.forEach((s, k) => {
    if (!s || s.as === "system" || !(Object.hasOwn(POINTED, s.do) || s.do === "press" || s.do === "go-back")) return;
    actions += 1;
    const box = boxOf(s, k);
    const dialog = box && typeof box.dialog === "string" && box.dialog !== "" ? box.dialog : null;
    if (episode && episode.dialog !== dialog) modals += episode.filled ? 0 : 1;
    if (!dialog) episode = null;
    else if (!episode || episode.dialog !== dialog) episode = { dialog, filled: false };
    if (episode && ["fill", "select", "check", "uncheck"].includes(s.do)) episode.filled = true;
    if (s.do === "press") {
      secs += (hand === "pointer" ? H : 0) + K * String(s.key || "").split("+").length;
      hand = "keys";
      return;
    }
    secs += hand === "keys" ? H : 0;
    hand = "pointer";
    let p = P_MEAN;
    if (box && prev) {
      const id = Math.log2(Math.hypot(box.x + box.width / 2 - (prev.x + prev.width / 2), box.y + box.height / 2 - (prev.y + prev.height / 2)) / Math.min(box.width, box.height) + 1);
      bits += id;
      p = Math.min(P_MAX, Math.max(P_MIN, id / THROUGHPUT));
    }
    prev = s.do === "go-back" ? null : box;
    secs += p + BB * (s.do === "go-back" ? 1 : POINTED[s.do]) + (s.do === "select" ? P_MIN : 0);
    const n = s.do === "fill" ? String(s.value ?? "").length : 0;
    if (s.do === "fill") [typed, secs, hand] = [typed + n, secs + H + K * n, "keys"];
  });
  if (episode && !episode.filled) modals += 1;
  const goals = Number.isInteger(g.goals) && g.goals >= 0 ? g.goals : steps.filter((s) => s && typeof s.expect === "string").length;
  return { actions, typed, modals, fitts_bits: round2(bits), klm_s: round2(secs + M * goals) };
}

/** The ease measurements of `page` (a Playwright Page) → EASE_SOURCE's `screen` answer, with the bar's vague terms. */
export async function easeOf(page) {
  return page.evaluate(`(${EASE_SOURCE})(${JSON.stringify({ kind: "screen", terms: TERMS })})`);
}

/**
 * The per-screen findings `[{rule, key, measured, expected}]` of `screen` against `bar` and `cfg` (loadTaste's): `screen`
 * is `{route, events, ease}` (route the screen's template, events the drained buffer of its document, ease easeOf's or
 * the `screen` kind's answer, with `error` from a routed fault and `recovery` from a form case when measured).
 */
export function rulesFor(screen, bar, cfg) {
  return easeFn({ kind: "judge", screen, rules: (bar && bar.rules) || [], cfg: cfg || {} });
}

/** Screen rules no page expression can measure alone: their measurement needs a driver or the cycle's peers. */
const NOT_ON_A_PAGE = { "states.recovery": "a form case drives it", "feedback.skeleton-peers": "it compares a screen with its peers" };

/** A page expression → the findings `[{rule, key, measured, expected}]` of one screen rule of this module's families on the current page. */
export function ruleExpression(rule) {
  const r = MINE.find((x) => x.id === rule);
  if (!r || ["consistent", "efficiency"].includes(r.family)) throw new Error(`refused: ruleExpression: ${String(rule).slice(0, 60)} is not a screen rule of the ease probe`);
  if (NOT_ON_A_PAGE[rule]) throw new Error(`refused: ruleExpression: ${rule} has no page expression: ${NOT_ON_A_PAGE[rule]}`);
  return `(${EASE_SOURCE})(${JSON.stringify({ kind: "rule", rule, rules: MINE, terms: TERMS })})`;
}

/**
 * The `expected` of a consistency row whose screens split evenly: no way is the app's own, so the owner decides
 * (decision 19's needs-owner). The one mark: filing (argus-live-tastefile.mjs) reads this constant, never a literal.
 */
export const NO_MAJORITY = "no majority";

/**
 * The cycle-scope rules over recorded screens (`[{key, route, journey, archetype?, events, ease}]`) → `[{screen, rule,
 * key, measured, expected}]`. consistent.action: one non-GET (method, route template, body field names) sent within
 * 100 ms of clicks on different controls (role and name, wherever they sit; a control in an empty state's region is
 * left out; each way on two routes at least); footer-order: the primary first or last in dialog (and
 * in form) footers; save-pattern: a form with a submit whose edits also saved (PUT or PATCH naming the field, or a POST
 * naming two of its fields) with no click between; palette: Mod+K opening on some of a journey's routes and not on
 * others (opening on a minority is a local shortcut: no row). A split counts routes: the minority is flagged against the
 * majority, an even split every side with NO_MAJORITY. feedback.skeleton-peers: a load behind a spinner alone for a wait
 * in the rule's range where another route (same archetype, when given) loads behind a skeleton.
 */
export function crossRules(screens, bar, cfg) {
  const R = new Map(((bar && bar.rules) || []).map((r) => [r.id, r]));
  const off = new Set((cfg && cfg.off) || []);
  const out = [];
  const add = (screen, rule, key, measured, expected) => {
    if (R.has(rule) && !off.has(rule) && !out.some((f) => f.screen === screen && f.rule === rule && f.key === key)) out.push({ screen, rule, key: String(key).slice(0, 300), measured, expected });
  };
  const list = (Array.isArray(screens) ? screens : []).map((s, i) => ({ id: s.key ?? i, route: s.route ?? (s.ease && s.ease.route), journey: s.journey ?? null, archetype: s.archetype ?? null, e: s.ease || {}, events: s.events || [] }));
  const way = (m, value, x) => {
    const l = m.get(value) || m.set(value, []).get(value);
    if (!l.some((y) => y.id === x.id && y.key === x.key)) l.push(x);
  };
  const split = (rule, ways, describe, minRoutes = 1) => {
    const routes = (v) => new Set(ways.get(v).map((x) => x.route)).size;
    const order = [...ways.keys()].sort((a, b) => routes(b) - routes(a));
    if (order.length < 2 || order.some((v) => routes(v) < minRoutes)) return;
    const tie = routes(order[0]) === routes(order[1]);
    for (const v of order) if (tie || v !== order[0]) for (const x of ways.get(v)) add(x.id, rule, x.key, describe(v), tie ? NO_MAJORITY : describe(order[0]));
  };
  const sub = (m, k) => m.get(k) || m.set(k, new Map()).get(k);
  const groups = new Map();
  for (const s of list) {
    for (const r of s.e.requests || []) {
      const a = r && r.same !== false && !/^(GET|HEAD|OPTIONS)$/.test(r.method) ? (s.e.actions || []).filter((x) => x.t <= r.t).pop() : null;
      if (!a || r.t - a.t > 100 || a.empty) continue;
      const g = `${r.method} ${r.route}${r.keys && r.keys.length ? ` {${r.keys.join(",")}}` : ""}`;
      // One way: a control's role and name, wherever it sits (the same action in several places is no inconsistency).
      way(sub(groups, g), `${a.role}|${a.name}`, { id: s.id, route: s.route, key: `${g}|${a.role}|${a.name}` });
    }
  }
  // A split needs each way on two routes at least: one screen's own control is no pattern.
  for (const m of groups.values()) split("consistent.action", m, (v) => v.replace(/^([^|]*)\|(.*)$/, '$1 "$2"'), 2);
  const kinds = new Map();
  for (const s of list) for (const f of s.e.footers || []) way(sub(kinds, f.kind), f.position, { id: s.id, route: s.route, key: `${f.kind}|${f.name}` });
  for (const m of kinds.values()) split("consistent.footer-order", m, (v) => `primary ${v}`);
  for (const s of list) {
    const clicks = (s.e.actions || []).map((x) => x.t);
    for (const f of s.e.forms || []) {
      if (!f.submit) continue;
      const saves = (ed, r) => r.same !== false && r.t > ed.t && r.t - ed.t <= 3000 && !clicks.some((t) => t > ed.t && t <= r.t) && Array.isArray(r.keys) && r.keys.includes(ed.field) && (/^(PUT|PATCH)$/.test(r.method) || (r.method === "POST" && r.keys.filter((k) => f.fields.includes(k)).length >= 2));
      if ((s.e.edits || []).some((ed) => ed.form === f.key && ed.field && (s.e.requests || []).some((r) => saves(ed, r)))) add(s.id, "consistent.save-pattern", f.key, "autosave and a submit button", "one save pattern per form");
    }
  }
  const journeys = new Map();
  for (const s of list.filter((x) => x.e.palette && typeof x.e.palette.opens === "boolean")) {
    const m = sub(journeys, s.journey);
    const r = m.get(s.route) || { opens: false, ids: [] };
    m.set(s.route, { opens: r.opens || s.e.palette.opens, ids: [...r.ids, s.id] });
  }
  for (const m of journeys.values()) {
    const opens = [...m.values()].filter((r) => r.opens).length;
    const gaps = [...m.values()].filter((r) => !r.opens);
    if (opens === 0 || opens < gaps.length) continue;
    for (const r of gaps) for (const id of r.ids) add(id, "consistent.palette", "Mod+K", "does not open", opens > gaps.length ? `opens, as on ${opens} other screens of the journey` : NO_MAJORITY);
  }
  const within = ((R.get("feedback.skeleton-peers") || {}).threshold || {}).within;
  const loads = list.map((s) => ({ s, l: easeFn({ kind: "feedback", events: s.events, requests: s.e.requests, now: s.e.now }).loaders.filter((x) => x.phase === "load") }));
  for (const x of within ? loads : []) {
    if (x.l.some((l) => l.signal === "skeleton")) continue;
    const w = Math.max(-Infinity, ...x.l.filter((l) => l.signal === "spinner").map((l) => l.wait));
    const peer = loads.find((y) => y.s.route !== x.s.route && y.s.archetype === x.s.archetype && y.l.some((l) => l.signal === "skeleton"));
    if (w >= within[0] && w <= within[1] && peer) add(x.s.id, "feedback.skeleton-peers", "load|spinner", Math.round(w), `a skeleton, as ${peer.s.route} uses`);
  }
  return out;
}
