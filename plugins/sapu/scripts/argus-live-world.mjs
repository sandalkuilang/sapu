// argus-live-world.mjs — the taste recorders' own JavaScript world (spec §20.4). The lane installs its recorders (the
// taste buffer, the motion recorder, the feedback clock, the AI-surface recorder) in an isolated world of every page of
// a lane session, as a browser extension's content script lives: the same DOM, its own globals and builtins. Chrome's
// DevTools Protocol does it, through the pinned CLI's Playwright (a CDP session a page: Page.addScriptToEvaluateOnNewDocument
// with a world name, Page.createIsolatedWorld and Runtime.evaluate to read it). The page's own scripts can then neither
// read the records, nor patch a builtin or a prototype the recorders call, nor touch the AI recorder's state.
//
// A wrapper around fetch or XMLHttpRequest sees nothing in a world of its own, so the page's requests are timed from
// the driver instead: Playwright's request events in the daemon, with the browser's own request timing. That vantage
// is outside the page (a page cannot forge or hide a request from it), and unlike the run's proxy it sees a request a
// routed fault answers inside the browser (the replay's 500s never reach the proxy), knows fetch and XHR from a
// document or an image, and needs no TLS of its own. Where the recorders run in the page's own world (the generated
// suite's, on the owner's app in CI), EASE_NET wraps fetch and XHR for them instead. A leaf: code as text, no import.

/** argus-live-tastecfg.mjs TASTE_KEY_MARK (a leaf cannot import it; a test pins the two equal): the lane's taste key goes in its place. */
const KEY_MARK = "@@argus-taste-key@@";
/** argus-live-ease.mjs's request route template (a leaf cannot import it; a test pins the two equal): numeric, uuid and long token segments become `:id`. */
export const ROUTE_OF = String.raw`(p) => String(p || "/").split("?")[0].split("/").map((s) => (/^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || (s.length >= 16 && /\d/.test(s) && /^[A-Za-z0-9_-]+$/.test(s)) ? ":id" : s)).join("/")`;

/** The world's name: one a page, made once a document. */
export const WORLD = "argus-taste";

/**
 * The session hook's install, `async (ctx, payload) => void`, once a context: `payload` (the recorders' script) runs in
 * world WORLD first in every document of every page of `ctx`, the pages it has and each one it opens (each through one
 * CDP session, kept on `ctx.__argusWorld`; a document that began before its page's session gets the script on the
 * first read, WORLD_EVAL). And each fetch or XHR request a page makes is kept for it, the last 200: `{start, end,
 * status, method, url, keys}`: start and end in epoch ms by the browser's own timing (`end` null until it answered, 0
 * its status when it failed), the URL's origin and path (never its query), and `keys` the names of a JSON or form body's
 * fields (never a value).
 */
export const WORLD_INSTALL = String.raw`async (ctx, payload) => {
  if (ctx.__argusWorld) return;
  const W = (ctx.__argusWorld = { name: "${WORLD}", payload, cdp: new Map(), net: new Map() });
  // One session a page, made once; one that failed is made again on the next attach.
  W.attach = (page) => {
    if (!W.cdp.has(page)) {
      const made = (async () => {
        const cdp = await ctx.newCDPSession(page);
        await cdp.send("Page.enable");
        await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: W.payload, worldName: W.name });
        return cdp;
      })();
      W.cdp.set(page, made);
      made.catch(() => W.cdp.get(page) === made && W.cdp.delete(page));
      page.once("close", () => (W.cdp.delete(page), W.net.delete(page)));
    }
    return W.cdp.get(page);
  };
  const keysOf = (q) => {
    let body = "";
    try { body = String(q.postData() || ""); } catch (e) { body = ""; }
    const type = String((q.headers() || {})["content-type"] || "");
    let k = [];
    try {
      if (/^\s*\{/.test(body)) k = Object.keys(JSON.parse(body));
      else if (/multipart\/form-data/i.test(type)) k = [...body.matchAll(/content-disposition:[^\r\n]*\bname="([^"]{1,40})"/gi)].map((m) => m[1]);
      else if (/^[^=&\s]+=/.test(body.trim())) k = [...new URLSearchParams(body.trim()).keys()];
    } catch (e) { k = []; }
    return [...new Set(k)].map((x) => String(x).slice(0, 40)).sort().slice(0, 20);
  };
  const open = new Map();
  ctx.on("request", (q) => {
    let page = null, u = null;
    try { page = q.frame().page(); u = new URL(q.url()); } catch (e) { return; }
    if (!/^(fetch|xhr)$/.test(q.resourceType()) || !/^https?:$/.test(u.protocol)) return;
    const list = W.net.get(page) || [];
    W.net.set(page, list);
    const r = { start: Date.now(), end: null, status: 0, method: q.method(), url: u.origin + u.pathname, keys: keysOf(q) };
    list.push(r);
    if (list.length > 200) list.shift();
    open.set(q, r);
  });
  const done = async (q, failed) => {
    const r = open.get(q);
    if (!r) return;
    open.delete(q);
    let t = null;
    try { t = q.timing(); } catch (e) { t = null; }
    if (!failed) { try { const res = await q.response(); r.status = res ? res.status() : 0; } catch (e) { r.status = 0; } }
    if (t && t.startTime > 0) r.start = t.startTime;
    r.end = t && t.startTime > 0 && t.responseEnd >= 0 ? t.startTime + t.responseEnd : Date.now();
  };
  ctx.on("requestfinished", (q) => done(q, false));
  ctx.on("requestfailed", (q) => done(q, true));
  ctx.on("page", (page) => { W.attach(page).catch(() => {}); });
  for (const page of ctx.pages()) await W.attach(page).catch(() => {});
}`;

/**
 * `async (page, expr) => value`: page expression `expr` evaluated in world WORLD of `page`'s main frame (its promise
 * awaited, its value returned by value), after the recorders were put in a document they did not reach first, and with
 * `window.__argusNet` set there to the document's requests as WORLD_INSTALL timed them, in the document's own clock
 * (`{t, end, status, method, url, keys}`, `t` and `end` ms since its time origin). Throws where the context has no world
 * (the hook did not install it): a read never falls back to the page's own world, which the page controls.
 */
export const WORLD_EVAL = String.raw`async (page, expr) => {
  const W = page.context().__argusWorld;
  if (!W) throw new Error("argus: this context has no taste world");
  const cdp = await W.attach(page);
  const frameId = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
  const contextId = (await cdp.send("Page.createIsolatedWorld", { frameId, worldName: W.name })).executionContextId;
  const run = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, contextId, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("argus: in the taste world: " + String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || "").split("\n")[0].slice(0, 300));
    return r.result.value;
  };
  const origin = await run("(() => {\nif (!Object.prototype.hasOwnProperty.call(document, \"__argusTastePush\")) {\n" + W.payload + "\n}\nreturn performance.timeOrigin;\n})()");
  const net = (W.net.get(page) || []).filter((r) => r.start >= origin - 50).map((r) => ({ t: r.start - origin, end: r.end === null ? null : r.end - origin, status: r.status, method: r.method, url: r.url, keys: r.keys }));
  await run("window.__argusNet = " + JSON.stringify(net) + ";");
  return run(expr);
}`;

/**
 * The feedback clock's request record in the page's own world (the suite's, which installs it after argus-live-ease.mjs EASE_INIT): the
 * page's fetch and XHR requests into `document.__argusEase` (`{t, end, status, method, route, keys, same}`, a body's
 * field names, never its values; a 2xx write marks the change after it), and each shadow root attachShadow makes
 * observed. The lane's recorders live in a world of their own, where a wrapper sees nothing: the driver times its
 * requests there (argus-live-world.mjs).
 */
export const EASE_NET = String.raw`(() => {
  const doc = document;
  if (typeof doc.__argusEaseLive !== "function") return;
  const KEY = "${KEY_MARK}";
  const routeOf = ${ROUTE_OF};
  const cap = (list, n, x) => { list.push(x); if (list.length > n) list.shift(); return x; };
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
