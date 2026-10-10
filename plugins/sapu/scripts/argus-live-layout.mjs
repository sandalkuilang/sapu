// argus-live-layout.mjs — the layout, locale, link and dynamic-state checks (spec §19.7): each an in-page
// source embedded verbatim in the generated suite's support.ts and run by the lane through run-code, each
// reporting violations as {check, step, key, detail} with a key stable across runs. A leaf module.
//
// One in-page function (PAGE_FN) answers every check by `kind`; the registry's first entry carries it and the
// shared helpers (project gating, known and allowed violations, annotations), and each later entry carries its
// own wrapper over them, so the entries stay together. What the path or a page supplies reaches the generated
// code as a JSON literal, and every in-page answer is data the wrapper compares or annotates, never code.

/** Violation kinds the in-page layout pass can report: its `only` option names any of these. */
export const LAYOUT_KINDS = ["page-scroll", "clipped", "covered", "target-size"];

/**
 * The in-page function: `(arg: {kind, opts}) → answer`, plain script with no outer reference, so it runs as
 * the support file's `page.evaluate` source and as the exploratory lane's `run-code` source alike. Kinds:
 * `layout` ({only?}) → [{check, key, detail}]; `format` ({locale}); `lang`; `text` ({exclude}) → visible text
 * units; `links` ({origin}) → same-origin hrefs; `loading`; `empty`; `toast-arm`, `toast-take` ({next}) and
 * `toast-state` ({ids}) → fixed elements that appeared after an action.
 */
export const PAGE_FN = String.raw`(arg) => {
  const kind = arg.kind;
  const o = arg.opts || {};
  const doc = document;
  const win = window;
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const digits = (s) => s.replace(/[0-9]+/g, "#");
  const cs = (el) => win.getComputedStyle(el);
  const tagOf = (el) => el.tagName.toLowerCase();
  const rectOf = (el) => el.getBoundingClientRect();
  const dedupe = (list) => {
    const seen = new Set();
    return list.filter((f) => !seen.has(f.check + "|" + f.key) && seen.add(f.check + "|" + f.key));
  };

  // Invisible: display none, opacity 0, aria-hidden, inert, zero size, or clipped to a pixel (the visually-hidden pattern).
  const memo = new Map();
  const hid = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (memo.has(el)) return memo.get(el);
    const s = cs(el);
    let r = s.display === "none" || Number(s.opacity) === 0 || el.getAttribute("aria-hidden") === "true" || el.hasAttribute("inert");
    if (!r && s.display !== "contents") {
      const b = rectOf(el);
      r = b.width <= 1 && b.height <= 1 && (s.overflowX !== "visible" || s.overflowY !== "visible" || s.clipPath !== "none" || s.clip !== "auto");
    }
    r = r || hid(el.parentElement);
    memo.set(el, r);
    return r;
  };
  const hiddenEl = (el) => {
    const b = rectOf(el);
    return hid(el) || cs(el).visibility !== "visible" || (cs(el).display !== "contents" && b.width === 0 && b.height === 0);
  };
  // While a modal dialog is open, everything outside it is excluded.
  const isModal = (m) => {
    try {
      return m.getAttribute("aria-modal") === "true" || m.matches(":modal");
    } catch (e) {
      return false;
    }
  };
  let modalMemo;
  const modal = () => {
    if (modalMemo === undefined) modalMemo = [...doc.querySelectorAll("dialog, [role=dialog], [role=alertdialog]")].filter((m) => isModal(m) && !hiddenEl(m)).pop() || null;
    return modalMemo;
  };
  const inScope = (el) => !modal() || modal().contains(el);
  // Against the ancestors that clip it: wholly outside one (a collapsed panel, a scrolled-off row), or partly (whole).
  const clipped = (el, r, whole) => {
    if (cs(el).position === "fixed") return false;
    for (let a = el.parentElement; a && a !== doc.documentElement; a = a.parentElement) {
      const s = cs(a);
      if (s.overflowX === "visible" && s.overflowY === "visible") continue;
      const b = rectOf(a);
      if (whole ? r.left < b.left || r.right > b.right || r.top < b.top || r.bottom > b.bottom : r.right <= b.left || r.left >= b.right || r.bottom <= b.top || r.top >= b.bottom) return true;
    }
    return false;
  };
  const ok = (el) => !hiddenEl(el) && inScope(el) && !clipped(el, rectOf(el), false);

  const INPUT_ROLES = { checkbox: "checkbox", radio: "radio", range: "slider", button: "button", submit: "button", reset: "button", image: "button" };
  const TAG_ROLES = { a: "link", button: "button", summary: "button", select: "combobox", textarea: "textbox" };
  const roleOf = (el) => norm(el.getAttribute("role")).split(" ")[0] || (tagOf(el) === "input" ? INPUT_ROLES[(el.getAttribute("type") || "text").toLowerCase()] || "textbox" : TAG_ROLES[tagOf(el)] || "");
  const explicitName = (el) => {
    const by = norm((el.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => (doc.getElementById(id) || {}).textContent || "").join(" "));
    return by || norm(el.getAttribute("aria-label")) || norm(el.getAttribute("title"));
  };
  const nameOf = (el) => {
    const labels = el.labels && el.labels.length ? norm([...el.labels].map((l) => l.textContent).join(" ")) : "";
    const value = tagOf(el) === "input" ? norm(el.getAttribute("value") || el.value) : "";
    const button = ["button", "submit", "reset"].indexOf((el.getAttribute("type") || "").toLowerCase()) >= 0;
    return explicitName(el) || labels || (button && value) || norm(el.getAttribute("alt")) || norm(el.innerText != null ? el.innerText : el.textContent) || norm(el.getAttribute("placeholder"));
  };
  const keyOf = (el) => [roleOf(el), digits(nameOf(el)).slice(0, 60), tagOf(el)].join("|");
  const describe = (el) => tagOf(el) + (roleOf(el) && roleOf(el) !== tagOf(el) ? "[" + roleOf(el) + "]" : "") + (nameOf(el) ? ' "' + nameOf(el).slice(0, 30) + '"' : "");

  const CONTROL = "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=tab], [role=option], [role=slider], [role=spinbutton], [role=combobox], [role=textbox], [role=searchbox]";
  const controls = () => [...doc.querySelectorAll(CONTROL)].filter((el) => el.getAttribute("aria-disabled") !== "true" && !el.matches(":disabled") && ok(el));

  // ------------------------------------------------------------------------------------ layout
  const pageScroll = () => {
    const se = doc.scrollingElement || doc.documentElement;
    if (se.scrollWidth <= win.innerWidth + 1) return [];
    const EX = "table, pre, code, canvas, svg, video, iframe, [role=grid], [role=application]";
    const contained = (el) => {
      for (let a = el.parentElement; a && a !== doc.documentElement; a = a.parentElement) if (cs(a).overflowX !== "visible" && rectOf(a).right <= win.innerWidth + 1) return true;
      return false;
    };
    const past = [...doc.body.querySelectorAll("*")].slice(0, 20000).filter((el) => rectOf(el).right > win.innerWidth + 1 && !el.closest(EX) && ok(el) && !contained(el));
    if (past.length === 0 && [...doc.body.querySelectorAll(EX)].some((el) => rectOf(el).right > win.innerWidth + 1)) return [];
    const reflow = win.innerWidth <= 320 ? " (WCAG 1.4.10 reflow)" : "";
    return [{ check: "page-scroll", key: "page-scroll", detail: "scrollWidth " + se.scrollWidth + " > innerWidth " + win.innerWidth + reflow + (past.length ? ", first past the edge: " + describe(past[0]) : "") }];
  };
  const clippedText = () => {
    const out = [];
    const SKIP = ["input", "textarea", "select", "option", "script", "style", "noscript", "svg", "canvas", "iframe", "video", "img", "html", "body"];
    for (const el of doc.body.querySelectorAll("*")) {
      if (SKIP.indexOf(tagOf(el)) >= 0) continue;
      const own = norm([...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join(""));
      if (!own) continue;
      const s = cs(el);
      const clipX = s.overflowX === "hidden" || s.overflowX === "clip" || (s.textOverflow === "ellipsis" && s.overflowX !== "visible");
      const clipY = s.overflowY === "hidden" || s.overflowY === "clip";
      const wide = clipX && el.scrollWidth > el.clientWidth + 1;
      if (!wide && !(clipY && el.scrollHeight > el.clientHeight + 1)) continue;
      let scrolls = false;
      for (let a = el.parentElement; a && a !== doc.documentElement; a = a.parentElement) scrolls = scrolls || /auto|scroll/.test(cs(a).overflowX + " " + cs(a).overflowY);
      if (scrolls || !ok(el) || explicitName(el).indexOf(norm(el.textContent)) >= 0 && explicitName(el)) continue;
      out.push({ check: "clipped", key: [roleOf(el), digits(own).slice(0, 60), tagOf(el)].join("|"), detail: wide ? "scrollWidth " + el.scrollWidth + " > clientWidth " + el.clientWidth : "scrollHeight " + el.scrollHeight + " > clientHeight " + el.clientHeight });
    }
    return out;
  };
  const covered = () => {
    const out = [];
    for (const el of controls()) {
      const r = rectOf(el);
      if (r.width < 1 || r.height < 1 || r.left < 0 || r.top < 0 || r.right > win.innerWidth || r.bottom > win.innerHeight) continue;
      if (el.getClientRects().length > 1 || cs(el).pointerEvents === "none" || clipped(el, r, true)) continue;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      let hit = doc.elementFromPoint(x, y);
      while (hit && hit.shadowRoot && hit.shadowRoot.elementFromPoint(x, y) && hit.shadowRoot.elementFromPoint(x, y) !== hit) hit = hit.shadowRoot.elementFromPoint(x, y);
      if (!hit || hit === el || el.contains(hit)) continue;
      const wrap = hit.closest("label");
      if ((el.labels && [...el.labels].some((l) => l.contains(hit))) || (wrap && wrap.control === el)) continue;
      // A coverer that is fixed or sticky is a scroll-position artifact (the keyboard pass checks 2.4.11 instead).
      let pinned = false;
      for (let n = hit; n && n.nodeType === 1 && !n.contains(el); n = n.parentElement) pinned = pinned || cs(n).position === "fixed" || cs(n).position === "sticky";
      if (!pinned) out.push({ check: "covered", key: keyOf(el), detail: "covered by " + describe(hit) });
    }
    return out;
  };
  // 2.5.8's exceptions: a native checkbox, radio or range the author did not size, and a link inline in a text block.
  const uaSized = (el) => {
    const ty = (el.getAttribute("type") || "").toLowerCase();
    if (tagOf(el) !== "input" || ["checkbox", "radio", "range"].indexOf(ty) < 0) return false;
    const probe = doc.createElement("input");
    probe.type = ty;
    probe.style.cssText = "position:absolute;visibility:hidden";
    doc.body.appendChild(probe);
    const same = cs(probe).width === cs(el).width && cs(probe).height === cs(el).height;
    probe.remove();
    return same;
  };
  const inlineLink = (el) => {
    if (tagOf(el) !== "a" || cs(el).display !== "inline") return false;
    let p = el.parentElement;
    while (p && cs(p).display.indexOf("inline") === 0) p = p.parentElement;
    return Boolean(p) && norm(p.textContent).replace(norm(el.textContent), "").length > 0;
  };
  const dist = (r, x, y) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
  const targetSize = () => {
    const list = controls().map((el) => ({ el: el, r: rectOf(el) })).filter((t) => t.r.width > 0 && t.r.height > 0);
    const small = (t) => t.r.width < 24 || t.r.height < 24;
    const mid = (t) => [t.r.left + t.r.width / 2, t.r.top + t.r.height / 2];
    const out = [];
    for (const u of list.filter((t) => small(t) && !inlineLink(t.el) && !uaSized(t.el))) {
      const v = list.find((w) => w !== u && !u.el.contains(w.el) && !w.el.contains(u.el) && (dist(w.r, mid(u)[0], mid(u)[1]) < 12 || (small(w) && Math.hypot(mid(u)[0] - mid(w)[0], mid(u)[1] - mid(w)[1]) < 24)));
      if (v) out.push({ check: "target-size", key: keyOf(u.el), detail: Math.round(u.r.width) + "x" + Math.round(u.r.height) + " px, its 24 px circle meets " + describe(v.el) + " (WCAG 2.5.8)" });
    }
    return out;
  };

  // ------------------------------------------------------------------------------------ text
  const units = () => {
    const out = [];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && out.length < 4000; n = walker.nextNode()) {
      const p = n.parentElement;
      if (!norm(n.nodeValue) || !p || p.closest("input, textarea, select, option, script, style, noscript, code, pre, kbd, samp, [translate=no], [contenteditable]") || !ok(p)) continue;
      out.push(n.nodeValue);
    }
    return out;
  };
  const formatCheck = (locale) => {
    let np;
    let dp;
    try {
      const nf = new Intl.NumberFormat(locale);
      if (nf.resolvedOptions().numberingSystem !== "latn") return [];
      np = nf.formatToParts(1234567.891);
      dp = new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC", numberingSystem: "latn" }).formatToParts(new Date(Date.UTC(2026, 0, 31)));
    } catch (e) {
      return [];
    }
    const part = (type) => (np.find((p) => p.type === type) || {}).value;
    const [group, decimal] = [part("group") || "", part("decimal") || "."];
    const order = dp.filter((p) => p.type !== "literal").map((p) => p.type);
    const sep = ((dp.find((p) => p.type === "literal") || { value: "" }).value.trim()).charAt(0);
    const out = [];
    for (const raw of units()) {
      const t = raw.replace(/(?:https?:\/\/|www\.)\S+/gi, " ").replace(/\S+@\S+/g, " ");
      for (const m of t.matchAll(/(?<![\d.,])\d{1,3}(?:[.,]\d{3})+[.,]\d+(?!\d)/g)) {
        const seps = [...m[0].matchAll(/[.,]/g)].map((x) => x[0]);
        const [g, d] = [seps[0], seps[seps.length - 1]];
        if (g === d || seps.slice(0, -1).some((x) => x !== g) || (group === g && decimal === d)) continue;
        out.push({ check: "format", key: "number|" + digits(m[0]), detail: JSON.stringify(m[0]) + " under " + locale + ": the group separator is " + JSON.stringify(group) + " and the decimal " + JSON.stringify(decimal) });
      }
      for (const m of t.matchAll(/(?<![\d./-])(\d{1,2})([./-])(\d{1,2})\2(\d{4})(?!\d|[./-]\d)/g)) {
        const dayFirst = order.indexOf("day") < order.indexOf("month");
        const [a, b] = [Number(m[1]), Number(m[3])];
        const why = order[0] === "year" || (a > 12 && a <= 31 && !dayFirst) || (b > 12 && b <= 31 && dayFirst) ? "order" : sep && "./-".indexOf(sep) >= 0 && m[2] !== sep ? "separator" : "";
        if (why) out.push({ check: "format", key: "date|" + digits(m[0]) + "|" + why, detail: JSON.stringify(m[0]) + " under " + locale + ": day order " + order.join("-") + ", separator " + JSON.stringify(sep) });
      }
    }
    return dedupe(out);
  };

  // ------------------------------------------------------------------------------------ dynamic states
  const loading = () => dedupe([...doc.querySelectorAll('[aria-busy="true"], [role=progressbar], progress')]
    .filter((el) => el.getAttribute("aria-busy") === "true" || !el.hasAttribute(tagOf(el) === "progress" ? "value" : "aria-valuenow"))
    .filter(ok).map((el) => ({ check: "loading", key: keyOf(el), detail: describe(el) + " is still loading" })));
  const empty = () => {
    const out = [];
    const HEAD = "h1, h2, h3, h4, h5, h6, [role=heading], caption, legend, script, style, noscript";
    for (const el of doc.querySelectorAll("table, [role=table], [role=grid], ul, ol, [role=list], [role=listbox], [role=feed]")) {
      if (el.getAttribute("aria-busy") === "true" || !ok(el)) continue;
      const headed = (r) => Boolean(r.closest("thead")) || (Boolean(r.querySelector("th, [role=columnheader]")) && !r.querySelector("td, [role=cell], [role=gridcell]"));
      const rows = [...el.querySelectorAll("tr, [role=row]")];
      const grid = tagOf(el) === "table" || /^(table|grid)$/.test(el.getAttribute("role") || "");
      if (grid ? !rows.some(headed) || rows.some((r) => !headed(r)) : el.querySelectorAll("li, [role=listitem], [role=option], [role=article], article").length > 0) continue;
      const box = el.closest("section, article, main, aside, form, [role=region], [role=main], [role=complementary], [role=form], [role=search]") || el.parentElement;
      const walker = doc.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      let text = false;
      for (let n = walker.nextNode(); n && !text; n = walker.nextNode()) text = Boolean(n.parentElement) && !el.contains(n.parentElement) && !n.parentElement.closest(HEAD) && /\p{L}/u.test(n.nodeValue) && ok(n.parentElement);
      const label = explicitName(el) || norm((el.querySelector("caption, th, [role=columnheader]") || {}).textContent) || tagOf(el);
      if (!text) out.push({ check: "empty", key: [roleOf(el) || tagOf(el), digits(label).slice(0, 60), tagOf(el)].join("|"), detail: "empty " + tagOf(el) + " with no text near it" });
    }
    return dedupe(out);
  };
  const links = () => {
    const urls = [];
    for (const a of doc.querySelectorAll("a[href]")) {
      if ((a.getAttribute("href") || "").charAt(0) === "#" || !ok(a)) continue;
      let u;
      try {
        u = new URL(a.href);
      } catch (e) {
        continue;
      }
      u.hash = "";
      if ((u.protocol === "http:" || u.protocol === "https:") && u.origin === o.origin && urls.indexOf(u.href) < 0) urls.push(u.href);
    }
    return urls;
  };

  // A fixed element that appears after an action: recorded by a mutation observer, read by the next step.
  const toastArm = () => {
    if (doc.__argusToast) return true;
    const st = (doc.__argusToast = { recs: [], seq: 0 });
    const SKIP = "[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [role=tooltip], [role=navigation], [role=banner], dialog, nav, header, footer, [aria-modal=true], [popover]";
    const LIVE = "[role=status], [role=alert], [role=log], [aria-live]:not([aria-live=off])";
    const record = (e, own) => {
      const text = norm(e.innerText);
      const b = rectOf(e);
      if (!e.isConnected || e.closest(SKIP) || !text || b.width < 1 || b.height < 1) return;
      st.recs.push({ id: st.seq++, el: e, own: own, text: text.slice(0, 120), live: Boolean(e.closest(LIVE) || e.querySelector(LIVE)), dismissible: Boolean(e.querySelector("button, a[href], [role=button], input[type=button]")), rect: { left: b.left, top: b.top, right: b.right, bottom: b.bottom }, taken: false });
    };
    const added = (root, element) => {
      const fixed = [root].concat(element ? [...root.querySelectorAll("*")].slice(0, 200) : []).filter((e) => cs(e).position === "fixed");
      for (const e of fixed) if (!fixed.some((f) => f !== e && f.contains(e))) record(e, element);
      // Text or a child added inside a fixed region that was already there: a status update, not a new toast.
      let region = root.parentElement;
      while (region && cs(region).position !== "fixed") region = region.parentElement;
      if (!fixed.length && region) record(root, false);
    };
    new MutationObserver((muts) => {
      const nodes = muts.flatMap((m) => [...m.addedNodes]).filter((n) => n.nodeType === 1 || (n.nodeType === 3 && n.parentElement));
      for (const n of nodes.slice(0, 50)) added(n.nodeType === 1 ? n : n.parentElement, n.nodeType === 1);
    }).observe(doc, { childList: true, subtree: true });
    return true;
  };
  const toastTake = () => {
    const st = doc.__argusToast;
    const hints = (o.next || []).map((h) => String(h).toLowerCase());
    const ctl = hints.length ? controls() : [];
    return (st ? st.recs : []).filter((r) => !r.taken).map((r) => {
      r.taken = true;
      const present = r.el.isConnected && !hiddenEl(r.el);
      const box = present ? rectOf(r.el) : r.rect;
      const covers = ctl.filter((c) => !r.el.contains(c) && (hints.indexOf(nameOf(c).toLowerCase()) >= 0 || [...c.attributes].some((a) => a.name.indexOf("data-") === 0 && hints.indexOf(a.value.toLowerCase()) >= 0)))
        .filter((c) => { const b = rectOf(c); const x = b.left + b.width / 2; const y = b.top + b.height / 2; return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom; }).map(describe);
      return { id: r.id, key: [r.el.getAttribute("role") || "toast", digits(r.text).slice(0, 60), tagOf(r.el)].join("|"), text: r.text, live: r.live, dismissible: r.dismissible, own: r.own, present: present, covers: covers };
    });
  };

  switch (kind) {
    case "layout": {
      const want = (k) => !Array.isArray(o.only) || o.only.indexOf(k) >= 0;
      const found = [].concat(want("page-scroll") ? pageScroll() : [], want("clipped") ? clippedText() : [], want("covered") ? covered() : [], want("target-size") ? targetSize() : []);
      return dedupe(found).sort((a, b) => (a.check + a.key < b.check + b.key ? -1 : 1));
    }
    case "format":
      return formatCheck(String(o.locale));
    case "lang":
      return doc.documentElement.getAttribute("lang") || "";
    case "text": {
      const ex = (o.exclude || []).map(String).filter((e) => e.length > 0);
      return [...new Set(units().map(norm).filter((t) => /\p{L}/u.test(t) && !ex.some((e) => t.indexOf(e) >= 0)))];
    }
    case "links":
      return links();
    case "loading":
      return loading();
    case "empty":
      return empty();
    case "toast-arm":
      return toastArm();
    case "toast-take":
      return toastTake();
    case "toast-state":
      return doc.__argusToast ? doc.__argusToast.recs.filter((r) => (o.ids || []).indexOf(r.id) >= 0 && r.el.isConnected && !hiddenEl(r.el)).map((r) => r.id) : [];
    default:
      throw new Error("argus layout: no check " + kind);
  }
}`;

/** An expression that runs PAGE_FN on `kind` and `opts` (JSON-encoded): for `page.evaluate` and `run-code` alike. */
export const pageExpression = (kind, opts = {}) => `(${PAGE_FN})(${JSON.stringify({ kind, opts })})`;

// ---------------------------------------------------------------------------------------------------
// The support file's sources (TypeScript). Names are prefixed per check family so two lanes' sources never collide.

/** The shared core: the in-page function, project gating, known and allowed violations, annotations. */
const CORE_SOURCE = String.raw`const layoutPage = ${PAGE_FN};

type LayoutFound = { check: string; key: string; detail: string };
type LayoutViolation = LayoutFound & { step: number };
type LayoutRule = { check: string; key: string };

/** The suite project running: the layout, link and dynamic-state checks run in every browser project but a11y and i18n. */
function layoutKind(): "viewport" | "a11y" | "i18n" {
  const name = test.info().project.name;
  return name === "a11y" ? "a11y" : name === "i18n" ? "i18n" : "viewport";
}

/** Account i's first page (accounts are numbered in the order they first act, as the context list is). */
function layoutPageOf(opened: BrowserContext[], i: number): Page | null {
  return opened[i] ? opened[i].pages()[0] ?? null : null;
}

async function layoutRun(page: Page, kind: string, opts: Record<string, unknown>): Promise<any> {
  return page.evaluate("(" + String(layoutPage) + ")(" + JSON.stringify({ kind, opts }) + ")");
}

/** The violations a step found less the journey's allowed and the adopted known ones (known/<id>.json: {check, key} rows), each annotated for the report. */
async function layoutJudge(id: string, step: number, found: LayoutFound[], allow: LayoutRule[]): Promise<LayoutViolation[]> {
  const fs = await import("node:fs");
  const file = path.join(__dirname, "known", id + ".json");
  const known = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  const skip: LayoutRule[] = [...allow, ...(Array.isArray(known) ? known : [])];
  const kept = found.filter((f) => !skip.some((s) => s.check === f.check && s.key === f.key)).map((f) => ({ check: f.check, step, key: f.key, detail: f.detail }));
  for (const v of kept) test.info().annotations.push({ type: "argus-violation", description: JSON.stringify(v) });
  return kept;
}

/** A finding that is the owner's to judge (never a failure). */
function layoutManual(step: number, check: string, key: string, detail: string): void {
  test.info().annotations.push({ type: "argus-manual", description: JSON.stringify({ check, step, key, detail }) });
}

/** A line the report prints as it is. */
function layoutInfo(line: string): void {
  test.info().annotations.push({ type: "argus-info", description: line });
}

/** The layout oracle after a step (spec 19.7): page-scroll, clipped, covered and target-size, in the viewport projects. */
export async function layoutStep(opened: BrowserContext[], i: number, step: number, id: string, allow: LayoutRule[]): Promise<LayoutViolation[]> {
  const page = layoutPageOf(opened, i);
  return page && layoutKind() === "viewport" ? layoutJudge(id, step, await layoutRun(page, "layout", {}), allow) : [];
}
`;

const LOCALE_SOURCE = String.raw`type LocaleState = { seen: Set<string>; said: boolean; unchanged: Map<string, Set<string>> };
const localeStates = new WeakMap<object, LocaleState>();

/** The codes live.json lists (the committed file; a missing or unreadable one lists none). */
async function localeConfig(): Promise<{ locales: string[]; pseudo: string[]; locale: string; timezone: string }> {
  const fs = await import("node:fs");
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  try {
    const live = JSON.parse(fs.readFileSync(path.join(REPO, ".argus", "live.json"), "utf8"));
    return { locales: list(live.locales), pseudo: list(live.pseudo_locales), locale: typeof live.locale === "string" ? live.locale : "en-US", timezone: typeof live.timezone === "string" ? live.timezone : "UTC" };
  } catch (e) {
    return { locales: [], pseudo: [], locale: "en-US", timezone: "UTC" };
  }
}

/**
 * The locale checks after a step (spec 19.7), in the i18n project: a sibling context in each listed locale opens
 * the step's URL (with the account's signed-in state when it has one) and runs page-scroll and clipped; a real
 * locale also its number and date formats (a page whose lang is not the locale's language is not localized, and
 * its formats are not judged); a pseudo-locale counts the text its page shares with the default locale's.
 */
export async function localeStep(browser: Browser, opened: BrowserContext[], i: number, account: string, step: number, id: string, baseURL: string | undefined, viewport: { width: number; height: number } | null, allow: LayoutRule[], exclude: string[], mutates: boolean, last: boolean): Promise<LayoutViolation[]> {
  const page = layoutPageOf(opened, i);
  if (!page || layoutKind() !== "i18n") return [];
  const cfg = await localeConfig();
  const st = localeStates.get(opened) ?? { seen: new Set<string>(), said: false, unchanged: new Map<string, Set<string>>() };
  localeStates.set(opened, st);
  if (!st.said) {
    st.said = true;
    layoutInfo("locale: only URL-addressable states are checked");
    if (cfg.pseudo.length === 0) layoutInfo("pseudo-localization: not done (no pseudo-locale listed)");
  }
  const url = page.url();
  const found: LayoutFound[] = [];
  if (/^https?:/.test(url) && !(st.seen.has(account + " " + url) && !mutates)) {
    st.seen.add(account + " " + url);
    const fs = await import("node:fs");
    const file = path.join(__dirname, ".auth", account + ".json");
    const visit = async <T>(code: string, work: (p: Page) => Promise<T>): Promise<T> => {
      const context = await browser.newContext({ baseURL, viewport: viewport ?? undefined, locale: code, timezoneId: cfg.timezone, ...(fs.existsSync(file) ? { storageState: file } : {}) });
      try {
        const p = await context.newPage();
        await p.goto(url);
        await p.waitForLoadState("load");
        return await work(p);
      } finally {
        await context.close();
      }
    };
    let base: Set<string> | null = null;
    for (const code of [...cfg.locales, ...cfg.pseudo]) {
      await visit(code, async (p) => {
        for (const f of await layoutRun(p, "layout", { only: ["page-scroll", "clipped"] })) found.push({ check: "locale-" + f.check, key: code + "|" + f.key, detail: f.detail });
        if (cfg.pseudo.includes(code)) {
          base = base ?? new Set<string>(await visit(cfg.locale, (d) => layoutRun(d, "text", { exclude })));
          const same = st.unchanged.get(code) ?? new Set<string>();
          for (const t of await layoutRun(p, "text", { exclude })) if (base.has(t)) same.add(t);
          st.unchanged.set(code, same);
          return;
        }
        const lang = String((await layoutRun(p, "lang", {})) || "");
        if (!lang.toLowerCase().startsWith(code.split("-")[0].toLowerCase())) layoutManual(step, "locale", code + "|not localized", "not localized: <html lang> is " + JSON.stringify(lang) + " under " + code);
        else for (const f of await layoutRun(p, "format", { locale: code })) found.push({ check: "locale-format", key: code + "|" + f.key, detail: f.detail });
      });
    }
  }
  if (last) for (const code of cfg.pseudo) layoutInfo("pseudo-localization: " + (st.unchanged.get(code)?.size ?? 0) + " text unchanged under " + code + " (hard-coded?)");
  return layoutJudge(id, step, found, allow);
}
`;

const LINKS_SOURCE = String.raw`type LinksState = { hrefs: Map<string, number>; visited: Set<string>[] };
const linksStates = new WeakMap<object, LinksState>();
const linksOf = (opened: BrowserContext[]): LinksState => linksStates.get(opened) ?? (linksStates.set(opened, { hrefs: new Map(), visited: [] }), linksStates.get(opened)!);

/** A final status: ok, fail (404, 410, 5xx) or manual (any other 4xx: 401 and 403 are a link offered to a role that cannot open it, 429 a rate limit, never waited out). */
function linksClassify(status: number): "ok" | "fail" | "manual" {
  if (status === 404 || status === 410 || status >= 500) return "fail";
  return status >= 400 ? "manual" : "ok";
}

/** A route (parameters as :id, [id], {id} or *) matches a pathname segment by segment. */
function linksRouteMatches(route: string, pathname: string): boolean {
  const segs = (s: string): string[] => s.replace(/[?#].*$/, "").split("/").filter(Boolean);
  const [r, p] = [segs(route), segs(pathname)];
  return r.length === p.length && r.every((x, k) => /^(:[^/]+|\[[^\]]+\]|\{[^}]+\}|\*)$/.test(x) || x === p[k]);
}

/** One GET, no redirect followed by the client; redirects are followed by hand within the link's own origin only (at most 5): another origin is never requested. */
async function linksProbe(request: BrowserContext["request"], start: string): Promise<{ status: number | null; detail: string }> {
  let url = start;
  for (let hop = 0; hop <= 5; hop++) {
    const res = await request.get(url, { maxRedirects: 0, failOnStatusCode: false });
    const status = res.status();
    const at = status + " " + new URL(url).pathname;
    if (status < 300 || status >= 400) return { status, detail: at };
    const to = res.headers()["location"];
    if (!to) return { status, detail: at + " with no location" };
    const next = new URL(to, url);
    if (next.origin !== new URL(start).origin) return { status, detail: at + " leaves the origin (not requested)" };
    url = next.href;
  }
  return { status: null, detail: "more than 5 redirects from " + new URL(start).pathname };
}

/** After a step: the same-origin links of the account's page (kept for the final step) and the pathname it is on. */
export async function linksStep(opened: BrowserContext[], i: number, baseURL: string | undefined): Promise<void> {
  const page = layoutPageOf(opened, i);
  if (!page || layoutKind() !== "viewport" || !baseURL) return;
  const st = linksOf(opened);
  while (st.visited.length <= i) st.visited.push(new Set());
  st.visited[i].add(new URL(page.url(), baseURL).pathname);
  for (const href of await layoutRun(page, "links", { origin: new URL(baseURL).origin })) if (!st.hrefs.has(href)) st.hrefs.set(href, i);
}

/** After the final step: each link seen (at most cap, one at a time, by the account that saw it) and each map route a role of the path acts as, which the path must have visited. */
export async function linksFinal(opened: BrowserContext[], step: number, id: string, cap: number, allow: LayoutRule[], routes: { role: string; route: string }[], accounts: string[]): Promise<LayoutViolation[]> {
  if (layoutKind() !== "viewport") return [];
  const st = linksOf(opened);
  const found: LayoutFound[] = [];
  for (const [url, i] of [...st.hrefs.entries()].slice(0, Math.max(0, cap))) {
    if (!opened[i]) continue;
    const key = "link|" + new URL(url).pathname.replace(/[0-9]+/g, "#");
    try {
      const res = await linksProbe(opened[i].request, url);
      const kind = res.status === null ? "fail" : linksClassify(res.status);
      if (kind === "fail") found.push({ check: "link", key, detail: res.detail });
      else if (kind === "manual") layoutManual(step, "link", key, res.detail);
    } catch (e) {
      layoutManual(step, "link", key, "the request failed: " + String((e as Error).message).slice(0, 120));
    }
  }
  for (const r of routes) {
    const seen = accounts.some((a, i) => a.split(".")[0] === r.role && [...(st.visited[i] ?? [])].some((p) => linksRouteMatches(r.route, p)));
    if (!seen) found.push({ check: "cta-route", key: r.role + "|" + r.route, detail: "the path never reached " + r.route + " as " + r.role });
  }
  return layoutJudge(id, step, found, allow);
}
`;

const LOADING_SOURCE = String.raw`/** After a step: no aria-busy or indeterminate progressbar stays visible past SETTLE (ARIA-marked loaders only). */
export async function loadingStep(opened: BrowserContext[], i: number, step: number, id: string, allow: LayoutRule[], settle: number = SETTLE): Promise<LayoutViolation[]> {
  const page = layoutPageOf(opened, i);
  if (!page || layoutKind() !== "viewport") return [];
  try {
    await page.waitForFunction("(" + String(layoutPage) + ")(" + JSON.stringify({ kind: "loading", opts: {} }) + ").length === 0", undefined, { timeout: settle });
    return [];
  } catch (e) {
    return layoutJudge(id, step, await layoutRun(page, "loading", {}), allow);
  }
}
`;

const EMPTY_SOURCE = String.raw`/** After a step: an empty table, grid or list needs an empty-state message near it. */
export async function emptyStep(opened: BrowserContext[], i: number, step: number, id: string, allow: LayoutRule[]): Promise<LayoutViolation[]> {
  const page = layoutPageOf(opened, i);
  return page && layoutKind() === "viewport" ? layoutJudge(id, step, await layoutRun(page, "empty", {}), allow) : [];
}
`;

const TOAST_SOURCE = String.raw`const toastArmed = new WeakSet<object>();

/**
 * After a step: the toasts that appeared since the previous step (the first step only arms the recorder). One
 * that goes by itself within SETTLE must be in a live region (4.1.3); a live one must not cover the next target
 * and, if it stays, must be dismissible.
 */
export async function toastStep(opened: BrowserContext[], i: number, step: number, id: string, allow: LayoutRule[], next: string[], settle: number = SETTLE): Promise<LayoutViolation[]> {
  const page = layoutPageOf(opened, i);
  if (!page || layoutKind() !== "viewport") return [];
  if (!toastArmed.has(opened[i])) {
    toastArmed.add(opened[i]);
    await opened[i].addInitScript("(" + String(layoutPage) + ")(" + JSON.stringify({ kind: "toast-arm", opts: {} }) + ")");
  }
  const recs: { id: number; key: string; live: boolean; dismissible: boolean; own: boolean; present: boolean; covers: string[] }[] = await layoutRun(page, "toast-take", { next });
  await layoutRun(page, "toast-arm", {});
  const found: LayoutFound[] = [];
  for (const r of recs) {
    let stays = r.present;
    if (stays) {
      try {
        await page.waitForFunction("(" + String(layoutPage) + ")(" + JSON.stringify({ kind: "toast-state", opts: { ids: [r.id] } }) + ").length === 0", undefined, { timeout: settle });
        stays = false;
      } catch (e) {
        stays = true;
      }
    }
    if (!stays && !r.live) found.push({ check: "toast", key: r.key, detail: "a message that goes by itself is in no live region (WCAG 4.1.3)" });
    if (r.live && r.covers.length) found.push({ check: "toast", key: r.key + "|covers", detail: "covers the next target: " + r.covers.join(", ") });
    if (stays && r.live && r.own && !r.dismissible) found.push({ check: "toast", key: r.key + "|persistent", detail: "stays past SETTLE and has no control to dismiss it" });
  }
  return layoutJudge(id, step, found, allow);
}
`;

// ---------------------------------------------------------------------------------------------------
// The registry's emitters.

const J = JSON.stringify;
/** The accounts a path acts as, in the order they first act: the order the test opens their contexts in. */
const accountsOf = (steps) => [...new Set(steps.filter((s) => s.as !== "system").map((s) => s.as))];
const allowOf = (ctx) => {
  const j = ctx.smoke && ctx.smoke.journeys && ctx.smoke.journeys[ctx.id];
  return j && Array.isArray(j.allow) ? j.allow.map((a) => ({ check: a.check, key: a.key })) : [];
};
const lastAccountStep = (ctx) => [...ctx.steps].reverse().find((s) => s.as !== "system") || ctx.steps[ctx.steps.length - 1];
const soft = (fn, args, what) => `expect.soft(await (await import("./support")).${fn}(${args.join(", ")}), ${J(what)}).toEqual([]);`;
/** The common emitter: one soft check on what `fn` returns after each step of an account; `more(step, ctx)` adds arguments. */
const perStep = (fn, what, more = () => []) => (step, ctx) =>
  step.as === "system" ? [] : [soft(fn, ["opened", accountsOf(ctx.steps).indexOf(step.as), step.n, J(ctx.id), J(allowOf(ctx)), ...more(step, ctx)], `${what}: step ${step.n}`)];
/** Steps that may change what a sibling context sees of the same URL. */
const MUTATING = ["click", "dblclick", "press", "reload", "login", "go-back"];

/** A repro string as an expression of the test's variables, or null when it names a value not read before step `n`. */
function valueExpr(s, steps, n) {
  const saved = new Set(steps.filter((x) => x.save && x.n < n && x.do === "read").map((x) => x.save));
  const out = [];
  for (const p of String(s).split(/(\{\{[a-z][a-z0-9_]*\}\})/).filter((x) => x !== "")) {
    const name = /^\{\{([a-z][a-z0-9_]*)\}\}$/.exec(p);
    if (!name) out.push(J(p));
    else if (name[1] === "marker" || saved.has(name[1])) out.push(name[1] === "marker" ? "marker" : `saved_${name[1]}`);
    else return null;
  }
  return out.length ? out.join(" + ") : null;
}

/** The text a step typed or compared up to step `n`: what a pseudo-locale render is not expected to translate. */
const typedValues = (steps, n) =>
  steps.filter((s) => s.n <= n && typeof s.value === "string" && (s.do === "fill" || s.do === "select" || ["value-equals", "text-equals", "text-contains"].includes(s.expect))).map((s) => valueExpr(s.value, steps, n)).filter(Boolean);

/** What the next action of the same account names (its target's name or value, when it holds no placeholder), for the toast-over-target rule. */
function nextHints(step, steps) {
  const next = steps.slice(steps.findIndex((s) => s.n === step.n) + 1).find((s) => s.do && s.as === step.as && s.target);
  return next ? ["name", "value"].map((k) => next.target[k]).filter((v) => typeof v === "string" && !v.includes("{{")) : [];
}

/**
 * The check registry the generator loops over: `[{name, project, when, source, emit(step, ctx) → string[]}]`
 * — `project` the suite project that runs it, `when` the steps it follows, `source` the TypeScript embedded in
 * support.ts, `emit` the suite lines one path step adds (each a soft assertion on what the support's function
 * returns). `ctx.routes` (optional: the journey's map routes, `[{role, route}]`) feeds the CTA-route check.
 */
export const CHECKS = [
  { name: "layout", project: "viewport", when: "every step", source: CORE_SOURCE, emit: perStep("layoutStep", "layout") },
  {
    name: "locale",
    project: "i18n",
    when: "every step",
    source: LOCALE_SOURCE,
    emit: (step, ctx) =>
      step.as === "system"
        ? []
        : [soft("localeStep", ["browser", "opened", accountsOf(ctx.steps).indexOf(step.as), J(step.as), step.n, J(ctx.id), "baseURL", "viewport", J(allowOf(ctx)), `[${typedValues(ctx.steps, step.n).join(", ")}]`, J(MUTATING.includes(step.do)), J(step.n === lastAccountStep(ctx).n)], `locale: step ${step.n}`)],
  },
  {
    name: "links",
    project: "viewport",
    when: "every step, judged after the final step",
    source: LINKS_SOURCE,
    emit(step, ctx) {
      const accounts = accountsOf(ctx.steps);
      const lines = step.as === "system" ? [] : [`await (await import("./support")).linksStep(opened, ${accounts.indexOf(step.as)}, baseURL);`];
      if (step.n !== ctx.steps[ctx.steps.length - 1].n) return lines;
      const routes = (Array.isArray(ctx.routes) ? ctx.routes : []).filter((r) => r && accounts.some((a) => a.split(".")[0] === r.role)).map((r) => ({ role: r.role, route: r.route }));
      const cap = Number.isInteger(ctx.smoke && ctx.smoke.link_cap) ? ctx.smoke.link_cap : 50;
      return [...lines, soft("linksFinal", ["opened", step.n, J(ctx.id), cap, J(allowOf(ctx)), J(routes), J(accounts)], "links and routes")];
    },
  },
  { name: "loading", project: "viewport", when: "every step", source: LOADING_SOURCE, emit: perStep("loadingStep", "loading") },
  { name: "empty", project: "viewport", when: "every step", source: EMPTY_SOURCE, emit: perStep("emptyStep", "empty state") },
  { name: "toast", project: "viewport", when: "every step", source: TOAST_SOURCE, emit: perStep("toastStep", "toast", (step, ctx) => [J(nextHints(step, ctx.steps))]) },
];
