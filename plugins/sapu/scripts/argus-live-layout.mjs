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
 * `layout` ({only?}) → [{check, key, detail}].
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

  switch (kind) {
    case "layout": {
      const want = (k) => !Array.isArray(o.only) || o.only.indexOf(k) >= 0;
      const found = [].concat(want("page-scroll") ? pageScroll() : [], want("clipped") ? clippedText() : [], want("covered") ? covered() : [], want("target-size") ? targetSize() : []);
      return dedupe(found).sort((a, b) => (a.check + a.key < b.check + b.key ? -1 : 1));
    }
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

// ---------------------------------------------------------------------------------------------------
// The registry's emitters.

const J = JSON.stringify;
/** The accounts a path acts as, in the order they first act: the order the test opens their contexts in. */
const accountsOf = (steps) => [...new Set(steps.filter((s) => s.as !== "system").map((s) => s.as))];
const allowOf = (ctx) => {
  const j = ctx.smoke && ctx.smoke.journeys && ctx.smoke.journeys[ctx.id];
  return j && Array.isArray(j.allow) ? j.allow.map((a) => ({ check: a.check, key: a.key })) : [];
};
const soft = (fn, args, what) => `expect.soft(await (await import("./support")).${fn}(${args.join(", ")}), ${J(what)}).toEqual([]);`;
/** The common emitter: one soft check on what `fn` returns after each step of an account; `more(step, ctx)` adds arguments. */
const perStep = (fn, what, more = () => []) => (step, ctx) =>
  step.as === "system" ? [] : [soft(fn, ["opened", accountsOf(ctx.steps).indexOf(step.as), step.n, J(ctx.id), J(allowOf(ctx)), ...more(step, ctx)], `${what}: step ${step.n}`)];
/**
 * The check registry the generator loops over: `[{name, project, when, source, emit(step, ctx) → string[]}]`
 * — `project` the suite project that runs it, `when` the steps it follows, `source` the TypeScript embedded in
 * support.ts, `emit` the suite lines one path step adds (each a soft assertion on what the support's function
 * returns).
 */
export const CHECKS = [
  { name: "layout", project: "viewport", when: "every step", source: CORE_SOURCE, emit: perStep("layoutStep", "layout") },
];
