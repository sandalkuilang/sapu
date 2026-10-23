// argus-live-logincode.mjs — the wrapper's own browser code for signing in and observing a session (spec
// §9 "Login"): constant templates run through `run-code`, split from argus-live-login.mjs, which drives them.
import { SIGNAL_SCRIPT } from "./argus-live-browser.mjs";
import { MAX_SECRET } from "./argus-live-ledger.mjs";
import { parseTarget, targetCode } from "./argus-live-targets.mjs";
import { WORLD_INSTALL } from "./argus-live-world.mjs";
// ---------------------------------------------------------------------------------------------------
// The wrapper's own browser code: `async page => {…}` functions run through `run-code --filename`. Each
// is a constant template; a stage's payload enters only as `const P = <JSON>;` and its targets only as
// targetCode's output (every string a JSON literal), so no value and no config string becomes code.

/**
 * Helpers every stage has: waiting, visibility, waiting up to a time for a condition; and `drain(c)`, what
 * the hook (below) gathered in context `c` since the last drain, plus the context's cookies and every
 * page's localStorage and sessionStorage → `{cookies: [{name, value, httpOnly, secure}], storage: [{key,
 * value}], headers: [[name, value]], leaves: [[key, value]], paths: [[previous, segment]], errors,
 * overflow}`, the pending arrays emptied (never `seen`). The observation and the repro's step templates
 * (argus-live-steps.mjs) drain.
 */
export const HELPERS = `  const pause = (ms) => page.waitForTimeout(ms);
  const visible = async (loc) => {
    try {
      return await loc.first().isVisible();
    } catch (e) {
      return false;
    }
  };
  const settle = async (check, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      let v = null;
      try {
        v = await check();
      } catch (e) {
        v = null;
      }
      if (v) return v;
      if (Date.now() >= end) return null;
      await pause(100);
    }
  };
  const ctx = page.context();
  const bodyText = async (pg) => {
    try {
      return await pg.locator("body").innerText({ timeout: 1000 });
    } catch (e) {
      return "";
    }
  };
  const LOCKOUT = /too many|\\blocked\\b|try again later/i;
  const drain = async (c) => {
    let cookies = [];
    try {
      cookies = (await c.cookies()).map((k) => ({ name: k.name, value: k.value, httpOnly: Boolean(k.httpOnly), secure: Boolean(k.secure) }));
    } catch (e) {}
    const storage = [];
    for (const pg of c.pages()) {
      try {
        storage.push(...(await pg.evaluate(() => {
          const out = [];
          for (const s of [window.localStorage, window.sessionStorage]) for (let i = 0; i < s.length; i++) out.push({ key: s.key(i), value: s.getItem(s.key(i)) });
          return out;
        })));
      } catch (e) {}
    }
    const A = c.__argus;
    const take = (a) => (A ? a.splice(0, a.length) : []);
    return { cookies, storage, headers: take(A && A.headers), leaves: take(A && A.leaves), paths: take(A && A.paths), errors: take(A && A.errors), overflow: Boolean(A && A.overflow) };
  };
`;

/** What a login stage watches: the origin of every request and WebSocket of the context's pages (popups included), and any 429. */
const WATCH = `  const origins = new Set();
  let status429 = false;
  const seen = (u) => {
    try {
      const x = new URL(u);
      const s = x.protocol === "ws:" ? "http:" : x.protocol === "wss:" ? "https:" : x.protocol;
      if (s === "http:" || s === "https:") origins.add(s + "//" + x.host);
    } catch (e) {}
  };
  const onRequest = (r) => seen(r.url());
  const onResponse = (r) => {
    if (r.status() === 429) status429 = true;
  };
  const onSocket = (w) => seen(w.url());
  const watched = new Set();
  const watch = (pg) => {
    if (watched.has(pg)) return;
    watched.add(pg);
    pg.on("websocket", onSocket);
  };
  ctx.on("request", onRequest);
  ctx.on("response", onResponse);
  ctx.on("page", watch);
  ctx.pages().forEach(watch);
  const unwatch = () => {
    ctx.off("request", onRequest);
    ctx.off("response", onResponse);
    ctx.off("page", watch);
    for (const pg of watched) pg.off("websocket", onSocket);
  };
  const failure = (e) => String((e && e.message) || e).split("\\n")[0].slice(0, 200);
  const limited = async () => status429 || LOCKOUT.test(await bodyText(page));
  const done = async (state, error, extra) => ({ state, status429, lockout: state !== "in" && LOCKOUT.test(await bodyText(page)), origins: [...origins], ...(error ? { error } : {}), ...extra });
  const TEXT = "input[type=text]:visible, input:not([type]):visible";
  const submit = async (field) => {
    const form = field.locator("xpath=ancestor::form[1]");
    if (await form.count()) {
      const button = form.locator("button[type=submit]:visible, input[type=submit]:visible, button:not([type]):visible");
      if (await button.count()) return button.first().click();
    }
    return field.press("Enter");
  };
  // Which of the inputs "loc" matches a person could type into → [[index, empty]], in one page-side
  // evaluate. Playwright's :visible counts opacity 0, a click-through wrapper and a field taken out of
  // reach as visible. A field that says it is a code field (not "strict") is often drawn as an overlay
  // (opacity 0 over digit boxes, under a modal library's aria-hidden wrapper), so it is dropped only
  // when it or an ancestor is inert, or it is visibility:hidden. "strict" (a guess at a code field, not
  // one that says it is) also drops a field with an opacity 0 or aria-hidden ancestor, pointer-events:none
  // (visibility and pointer-events inherit, so the computed value already holds the ancestors'), a field
  // out of the tab order (tabIndex -1) and a search box (type=search, role combobox or searchbox,
  // aria-autocomplete): a command palette kept in the DOM is not a code field.
  const usable = (loc, strict) =>
    loc.evaluateAll((els, strict) => {
      const role = (el) => String(el.getAttribute("role") || "").toLowerCase();
      const search = (el) => el.type === "search" || role(el) === "combobox" || role(el) === "searchbox" || el.hasAttribute("aria-autocomplete");
      const open = (el) => {
        const s = getComputedStyle(el);
        if (s.visibility === "hidden" || el.closest("[inert]")) return false;
        if (!strict) return true;
        if (s.pointerEvents === "none" || el.closest("[aria-hidden=true]")) return false;
        for (let n = el; n; n = n.parentElement) if (Number(getComputedStyle(n).opacity) === 0) return false;
        return el.tabIndex !== -1 && !search(el);
      };
      return els.flatMap((el, i) => (open(el) ? [[i, el.value === ""]] : []));
    }, strict);
  // The rule behind the field otpField last returned: "one-time-code" (the page says so) or "fallback"
  // (the one usable empty text-like input, a guess).
  let otpRule = null;
  const otpField = async () => {
    const otp = page.locator("input[autocomplete='one-time-code' i]:visible");
    const said = await usable(otp, false);
    if (said.length) {
      otpRule = "one-time-code";
      return otp.nth(said[0][0]);
    }
    if (loggedIn && (await visible(loggedIn(page)))) return null;
    const any = page.locator("input[type=text]:visible, input[type=tel]:visible, input[type=number]:visible, input:not([type]):visible");
    const fit = await usable(any, true);
    // A code field is empty when it appears; a filled one is the user field of a login form still
    // on screen while its app awaits the sign-in.
    if (fit.length !== 1 || !fit[0][1]) return null;
    otpRule = "fallback";
    return any.nth(fit[0][0]);
  };
  // Where the page stands and which field it is: its URL path and the field's tag, type, name, id, role
  // and aria-label, each cut to 80 characters, for the logins log. Never the field's value.
  const describe = async (field) => {
    try {
      return await field.evaluate((el) => {
        const cut = (v) => String(v || "").slice(0, 80);
        return { path: cut(location.pathname), tag: cut(el.localName), type: cut(el.getAttribute("type")), name: cut(el.getAttribute("name")), id: cut(el.id), role: cut(el.getAttribute("role")), label: cut(el.getAttribute("aria-label")) };
      });
    } catch (e) {
      return null;
    }
  };
`;

const STAGES = {
  // Once per context (ctx.__argus): listeners that outlive this call (probed: state and listeners a
  // run-code attaches to the context persist across the session's later calls). Requests: the values of
  // the Cookie, Authorization, Proxy-Authorization and *-Token headers, and the [previous, segment] pairs
  // of a run origin's path; responses: Set-Cookie values, a 5xx, and the [key, value] string leaves of a
  // run origin's JSON. A header value is recorded once (seen holds name\0value), until capBytes of values:
  // past it nothing more and overflow. Every page and popup: console errors, page errors, and the signal
  // script evaluated again at each domcontentloaded, so a popup a link opened is watched from its first
  // document. Errors keep at most 200, ids 2000 of each kind, until the next drain.
  hook: `  if (ctx.__argus) return { installed: false };
  const A = (ctx.__argus = { seen: new Set(), bytes: 0, overflow: false, headers: [], errors: [], leaves: [], paths: [] });
  const RUN = new Set(P.runOrigins);
  const ofRun = (u) => {
    try {
      return RUN.has(new URL(u).origin);
    } catch (e) {
      return false;
    }
  };
  const SECRET_HEADER = /^(cookie|authorization|proxy-authorization|[a-z0-9-]*-token)$/;
  const record = (name, value) => {
    if (A.overflow) return;
    const v = String(value).slice(0, ${MAX_SECRET});
    if (!v || A.seen.has(name + "\\0" + v)) return;
    if (A.bytes + v.length > P.capBytes) {
      A.overflow = true;
      return;
    }
    A.seen.add(name + "\\0" + v);
    A.bytes += v.length;
    A.headers.push([name, v]);
  };
  const idLike = (v) => typeof v === "string" && v.length >= 24 && v.length <= ${MAX_SECRET} && /[A-Za-z]/.test(v) && /[0-9]/.test(v);
  const pushId = (list, pair) => {
    if (list.length < 2000 && !list.some((x) => x[0] === pair[0] && x[1] === pair[1])) list.push(pair);
  };
  const leaves = (v, key, depth) => {
    if (depth > 32) return;
    if (idLike(v)) pushId(A.leaves, [String(key), v]);
    else if (Array.isArray(v)) v.forEach((x) => leaves(x, key, depth + 1));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, k, depth + 1);
  };
  const error = (e) => {
    if (A.errors.length < 200) A.errors.push(e);
  };
  ctx.on("request", async (r) => {
    try {
      if (ofRun(r.url())) {
        const segs = new URL(r.url()).pathname.split("/").filter(Boolean);
        segs.forEach((seg, i) => {
          if (idLike(seg)) pushId(A.paths, [i ? segs[i - 1] : "", seg]);
        });
      }
      for (const [k, v] of Object.entries(await r.allHeaders())) if (SECRET_HEADER.test(k.toLowerCase())) record(k.toLowerCase(), v);
    } catch (e) {}
  });
  ctx.on("response", async (r) => {
    try {
      if (r.status() >= 500) error({ kind: "5xx", status: r.status(), url: r.url() });
      const h = await r.allHeaders();
      if (h["set-cookie"]) for (const v of String(h["set-cookie"]).split("\\n")) record("set-cookie", v);
      if (ofRun(r.url()) && /json/i.test(h["content-type"] || "")) leaves(await r.json(), "", 0);
    } catch (e) {}
  });
  const hookPage = (pg) => {
    pg.on("console", (m) => {
      if (m.type() === "error") error({ kind: "console", text: String(m.text()).slice(0, 500), url: pg.url() });
    });
    pg.on("pageerror", (e) => error({ kind: "pageerror", text: String((e && e.message) || e).slice(0, 500), url: pg.url() }));
    pg.on("domcontentloaded", () => {
      pg.evaluate(P.signals).catch(() => {});
    });
  };
  ctx.pages().forEach(hookPage);
  ctx.on("page", hookPage);
  // The taste recorders, in a world of their own in every page, and the page's requests timed from here
  // (argus-live-world.mjs); a world that cannot be made leaves the recorders out, never the hook.
  let world = null;
  if (P.world) {
    try {
      await (${WORLD_INSTALL})(ctx, P.world);
      world = true;
    } catch (e) {
      world = false;
    }
  }
  return { installed: true, world };
`,
  // Opens the login page fresh, clicks P.open when set, fills the user field (an email input, else the
  // text input before the password field, else the single text input), submits it first when no password
  // field shows (two-step), fills and submits the password, then waits for logged_in or a one-time-code
  // field (otpField: a field a person could use; one that does not say it takes a code gets logged_in one
  // more window first). On "otp" it also returns `otp: {rule, path, tag, type, name, id, role, label}`.
  credentials: `${WATCH}  const pickUser = async () => {
    const email = page.locator("input[type=email]:visible");
    if (await email.count()) return email.first();
    const texts = page.locator(TEXT);
    const n = await texts.count();
    if (!n) return null;
    const pw = page.locator("input[type=password]:visible");
    if (await pw.count()) {
      const handle = await pw.first().elementHandle();
      const i = await texts.evaluateAll((els, p) => {
        let k = -1;
        els.forEach((el, j) => {
          if (el.compareDocumentPosition(p) & 4) k = j;
        });
        return k;
      }, handle);
      await handle.dispose();
      if (i >= 0) return texts.nth(i);
    }
    return n === 1 ? texts.first() : null;
  };
  try {
    await page.goto(P.url);
    if (opener) await opener(page).click();
    const user = await settle(pickUser, P.settleMs);
    if (!user) return await done("no-form");
    await user.fill(P.user);
    const pw = page.locator("input[type=password]:visible");
    if (!(await visible(pw))) {
      await submit(user);
      const next = await settle(async () => ((await visible(pw)) ? "password" : (await limited()) ? "limited" : null), P.settleMs);
      if (next !== "password") return await done(next ? "failed" : "no-form");
    }
    await pw.first().fill(P.password);
    await submit(pw.first());
    let field = null;
    const outcome = await settle(async () => ((await visible(loggedIn(page))) ? "in" : (field = await otpField()) ? "otp" : (await limited()) ? "failed" : null), P.settleMs);
    if (outcome === "otp") {
      // A guessed field may belong to a signed-in page whose logged_in waits on a call that has not
      // returned: it gets one more window before the guess stands. A field that says it takes a code does not.
      if (otpRule === "fallback" && (await settle(() => visible(loggedIn(page)), P.settleMs))) return await done("in");
      return await done("otp", null, { otp: { rule: otpRule, ...(await describe(field)) } });
    }
    return await done(outcome || "failed");
  } catch (e) {
    return await done("error", failure(e));
  } finally {
    unwatch();
  }
`,
  // Fills P.code into the one-time-code field (else the one usable empty text input), submits, waits for logged_in.
  otp: `${WATCH}  try {
    const field = await settle(otpField, P.settleMs);
    if (!field) return await done("no-form");
    await field.fill(P.code);
    await submit(field);
    const outcome = await settle(async () => ((await visible(loggedIn(page))) ? "in" : (await limited()) ? "failed" : null), P.settleMs);
    return await done(outcome || "failed");
  } catch (e) {
    return await done("error", failure(e));
  } finally {
    unwatch();
  }
`,
  // A new page at P.url: is logged_in visible there within P.settleMs? The page is closed again.
  probe: `${WATCH}  let probe = null;
  try {
    probe = await ctx.newPage();
    await probe.goto(P.url);
    const ok = await settle(() => visible(loggedIn(probe)), P.settleMs);
    return { in: Boolean(ok), origins: [...origins] };
  } catch (e) {
    return { in: false, origins: [...origins], error: failure(e) };
  } finally {
    unwatch();
    if (probe) await probe.close().catch(() => {});
  }
`,
  // After an explorer's command: the signals every page buffered (drained), logged_in on the current
  // page (null without a target), its URL and aria snapshot (the wrapper hashes them), the tab count,
  // and what the hook gathered (drain).
  // The signal script is evaluated again in every page first (it installs once per document): a popup a
  // link opened (target=_blank rel=opener) never ran the init script, and is watched from here on.
  observe: `  const signals = [];
  for (const pg of ctx.pages()) {
    try {
      await pg.evaluate(${JSON.stringify(SIGNAL_SCRIPT)});
    } catch (e) {}
    try {
      signals.push(...(await pg.evaluate(() => {
        const b = window.__argusSignals || [];
        return b.splice(0, b.length);
      })));
    } catch (e) {}
  }
  let aria = "";
  try {
    aria = await page.locator("body").ariaSnapshot({ timeout: 2000 });
  } catch (e) {}
  return { signals, loggedIn: loggedIn ? await visible(loggedIn(page)) : null, url: page.url(), aria, tabs: ctx.pages().length, secrets: await drain(ctx) };
`,
  // After an explorer's screenshot, once the call drained (decision 18): the text a scrub verdict reads —
  // every frame's body text (iframes included), then every input, textarea and select value of each, one
  // per line —, whether a visible password or one-time-code field is in any frame, whether the page is an
  // error page (its document's status 400 or more, or a chrome-error: page), and whether a frame could not
  // be read (its text then unknown). Never shown: the wrapper only judges it.
  shot: `  const lines = [];
  let password = false;
  let otp = false;
  let unread = false;
  for (const f of page.frames()) {
    try {
      const r = await f.evaluate(() => {
        const shown = (el) => {
          const s = getComputedStyle(el);
          return el.getClientRects().length > 0 && s.visibility !== "hidden" && s.display !== "none";
        };
        const fields = [...document.querySelectorAll("input, textarea, select")];
        return {
          text: document.body ? document.body.innerText : "",
          values: fields.map((el) => String(el.value ?? "")),
          password: fields.some((el) => el.type === "password" && shown(el)),
          otp: fields.some((el) => String(el.getAttribute("autocomplete") || "").toLowerCase() === "one-time-code" && shown(el)),
        };
      });
      lines.push(r.text, ...r.values);
      password = password || r.password;
      otp = otp || r.otp;
    } catch (e) {
      unread = true;
    }
  }
  let status = 0;
  try {
    status = await page.evaluate(() => (performance.getEntriesByType("navigation")[0] || {}).responseStatus || 0);
  } catch (e) {}
  return { text: lines.join("\\n"), password, otp, error: status >= 400 || page.url().startsWith("chrome-error:"), unread };
`,
};

/** `(pg) => <targetCode>` for a target string the config holds (parseTarget's forms, never a ref), or `null`. */
function targetFn(s) {
  if (s === undefined || s === null) return "null";
  return `(pg) => ${targetCode(parseTarget(s), "pg")}`;
}

/**
 * The code of login stage `stage` (`credentials`, `otp`, `probe`, `hook`, `observe`, `shot`) for `payload`
 * (`url`, `user`, `password`, `code`, `settleMs`, the hook's `runOrigins` (as `URL.origin` spells them),
 * `signals`, `world` (the taste recorders, or null) and `capBytes`, and the target strings `loggedIn` and `open`): the text of an `async page =>
 * {…}` function. The payload enters as `const P = <JSON>;` only; `loggedIn` and `open` also become `(pg)
 * => <targetCode>` functions. A stage returns plain JSON: credentials and otp `{state:
 * "in"|"otp"|"failed"|"no-form"|"error", status429, lockout, origins, error?, otp?}` (credentials' `otp`:
 * `{rule: "one-time-code"|"fallback", path, tag, type, name, id, role, label}`, the field it stopped at), probe `{in, origins}`,
 * hook `{installed, world}` (false when the context had it; `world` null without `P.world`, else whether the taste
 * recorders' world was made), observe `{signals, loggedIn, url, aria, tabs, secrets}` (`secrets` the drain), shot
 * `{text, password, otp, error, unread}`.
 */
export function loginCode(stage, payload) {
  if (!Object.hasOwn(STAGES, stage)) throw new Error(`failed: no login stage ${stage}`);
  return `async page => {\n  const P = ${JSON.stringify(payload)};\n  const loggedIn = ${targetFn(payload.loggedIn)};\n  const opener = ${targetFn(payload.open)};\n${HELPERS}${STAGES[stage]}}\n`;
}

/**
 * Login stage `stage`'s body, verbatim as loginCode wraps it (HELPERS, then the stage), for the smoke suite's
 * support file (spec §19.5), which runs it as a function of `page`, `P`, `loggedIn` and `opener`.
 */
export function loginStageSource(stage) {
  if (!Object.hasOwn(STAGES, stage)) throw new Error(`failed: no login stage ${stage}`);
  return `${HELPERS}${STAGES[stage]}`;
}
