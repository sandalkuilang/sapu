// argus-live-a11y.mjs — the accessibility checks (spec §19.7): keyboard reach and order, visible focus,
// names, ARIA snapshots, modals, axe's WCAG rules, design tokens and form cases, each an in-page source embedded
// verbatim in the generated suite's support.ts, called by the lines its emitter adds to the specs. A leaf module.
//
// A source is plain JavaScript (the suite's TypeScript is never type-checked) of `a11y`-prefixed functions, so
// no two lanes' sources can clash; a function the specs call is `export`ed, and a test strips the keyword to
// evaluate the text. It reports violations as `{check, step, key, detail, manual?}`: `key` is stable across
// runs (role, accessible name with digit runs written `#`), `manual` marks what only a human can judge. The
// emitted lines run in the `a11y` project only (`test.info().project.name`), call the support through
// `require("./support")` (the spec's import line is the generator's), and report through `a11yReport`, which
// soft-fails every violation not listed in `known/<id>.json` (adopted) or in smoke.json's `allow`.

/** The names a smoke test declares itself (argus-live-codegen's `OWN`): a page variable never takes one. */
const OWN = ["SETTLE", "marker", "opened", "open", "login", "trigger", "fact", "mail", "readValue", "collectErrors", "newMarker", "browser", "baseURL", "viewport", "test", "expect", "a11y"];
const GATE = 'if (test.info().project.name === "a11y") {';

const CORE = String.raw`
/** A parsed target (the path DSL's, as JSON) → its locator, the way the generator spells it. */
export function a11yLocate(page, t) {
  const root = t.within ? a11yLocate(page, t.within) : page;
  const method = { role: "getByRole", text: "getByText", label: "getByLabel", placeholder: "getByPlaceholder", testId: "getByTestId", title: "getByTitle", altText: "getByAltText" }[t.by];
  const opts = {};
  if (t.name !== undefined) opts.name = t.name;
  if (t.exact !== undefined) opts.exact = t.exact;
  const l = root[method](t.by === "role" ? t.role : t.value, opts);
  return t.nth === undefined ? l : t.nth === 0 ? l.first() : t.nth === -1 ? l.last() : l.nth(t.nth);
}

/** The violations adopted for journey id (known/<id>.json: a JSON list of {check, key}); none when the file is absent or unreadable. */
export function a11yKnown(id) {
  try {
    const j = JSON.parse(require("node:fs").readFileSync(require("node:path").join(__dirname, "known", id + ".json"), "utf8"));
    return Array.isArray(j) ? j.filter((k) => k && typeof k.check === "string" && typeof k.key === "string") : [];
  } catch (e) {
    return [];
  }
}

/** Reports found violations: manual ones as annotations, the rest as one soft failure; known and allowed ones are dropped. Returns what was reported. */
export function a11yReport(expect, info, found, id, allow) {
  const listed = (list, v) => list.some((k) => k.check === v.check && k.key === v.key);
  const known = a11yKnown(id);
  const live = found.filter((v) => !listed(known, v) && !listed(allow || [], v));
  const say = (v) => v.check + " (step " + v.step + ") " + v.key + ": " + v.detail;
  for (const v of live) if (v.manual) info.annotations.push({ type: "a11y-manual", description: say(v) });
  expect.soft(live.filter((v) => !v.manual).map(say), "accessibility violations").toEqual([]);
  return live;
}

/** Installs the page-side helpers (window[Symbol.for("argus.a11y")]): names, roles, colours and the Tab walk's probes. Run in every document. */
export function a11yPageHelpers() {
  const cs = (e) => getComputedStyle(e);
  const ROLE = { button: "button", select: "combobox", textarea: "textbox", img: "img", h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading", nav: "navigation", main: "main", dialog: "dialog", table: "table", ul: "list", ol: "list" };
  const roleOf = (e) => {
    const r = e.getAttribute("role");
    if (r) return r.split(" ")[0];
    const t = e.tagName.toLowerCase(), ty = (e.getAttribute("type") || "text").toLowerCase();
    if (t === "a") return e.hasAttribute("href") ? "link" : "generic";
    if (t === "input") return ty === "checkbox" ? "checkbox" : ty === "radio" ? "radio" : ["button", "submit", "reset", "image"].includes(ty) ? "button" : ty === "range" ? "slider" : "textbox";
    return ROLE[t] || t;
  };
  const nameOf = (e) => {
    const by = (e.getAttribute("aria-labelledby") || "").split(/\s+/).map((i) => document.getElementById(i)).filter(Boolean).map((n) => n.textContent);
    const raw = e.getAttribute("aria-label") || by.join(" ") || [...(e.labels || [])].map((l) => l.textContent).join(" ") || e.getAttribute("alt") || e.getAttribute("title") || (/^(input|select|textarea)$/i.test(e.tagName) ? "" : e.textContent) || e.value || "";
    return String(raw).replace(/\s+/g, " ").trim().slice(0, 60);
  };
  const desc = (e) => roleOf(e) + ' "' + nameOf(e).replace(/\d+/g, "#") + '"';
  const COMPOSITE = "[role=radiogroup],[role=tablist],[role=menu],[role=menubar],[role=listbox],[role=grid],[role=tree],[role=toolbar]";
  const ITEM = /^(radio|tab|menuitem|menuitemradio|menuitemcheckbox|option|gridcell|row|treeitem)$/;
  const parse = (s) => {
    const m = String(s).match(/^(?:rgba?\(|color\(srgb )([^)]+)\)$/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    const unit = s.startsWith("color(") ? 255 : 1;
    return p.length >= 3 && p.every((x) => !Number.isNaN(x)) ? [p[0] * unit, p[1] * unit, p[2] * unit, p.length > 3 ? p[3] : 1] : null;
  };
  const over = (top, bottom) => [0, 1, 2].map((i) => top[3] * top[i] + (1 - top[3]) * bottom[i]).concat(1);
  const lum = (c) => c.slice(0, 3).map((v) => (v /= 255) <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const background = (e) => {
    const layers = [];
    for (let n = e; n; n = n.parentElement) {
      const c = parse(cs(n).backgroundColor);
      if (c && c[3] > 0) layers.push(c);
      if (c && c[3] === 1) break;
    }
    return layers.reduceRight((under, top) => over(top, under), [255, 255, 255, 1]);
  };
  const H = { first: null, prev: null, roleOf, nameOf, desc, parse, over, ratio, background };
  H.reset = () => {
    const s = document.createElement("span");
    s.tabIndex = -1;
    document.body.prepend(s);
    s.focus(); // the sequential-focus starting point moves to the start of the document
    s.remove();
    H.first = H.prev = null;
    H.out = false;
  };
  H.stop = (t) => {
    const a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement) {
      // Focus left the page: the end of a lap. Before the first stop it is the walk's own start (Shift+Tab may land on the last stop), once.
      if (H.first || H.out) return { cycled: true };
      H.out = true;
      return {};
    }
    H.out = false;
    if (a === H.first) return { cycled: true };
    if (!H.first) H.first = a;
    const widget = ITEM.test(roleOf(t)) && t.hasAttribute("role") ? t.closest(COMPOSITE) : null;
    const hit = a === t || t.contains(a) || Boolean(widget && widget.contains(a)) || (t.type === "radio" && a.type === "radio" && Boolean(a.name) && a.name === t.name && a.form === t.form);
    const back = H.prev && a.compareDocumentPosition(H.prev) & Node.DOCUMENT_POSITION_FOLLOWING ? desc(H.prev) + " -> " + desc(a) : null;
    H.prev = a;
    return { hit, back };
  };
  H.facts = () => {
    const a = document.activeElement, r = a.getBoundingClientRect(), c = cs(a), hidden = r.width <= 2 || r.height <= 2;
    const box = hidden ? (a.labels && a.labels[0]) || a.closest("label") || a.parentElement || a : a;
    const b = box.getBoundingClientRect();
    const x = Math.max(0, b.left - 8), y = Math.max(0, b.top - 8);
    const clip = { x, y, width: Math.min(innerWidth - x, b.width + 16), height: Math.min(innerHeight - y, b.height + 16) };
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const top = !hidden && cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight ? document.elementFromPoint(cx, cy) : null;
    const mine = top && (top === a || a.contains(top) || [...(a.labels || [])].some((l) => l.contains(top)));
    const ink = parse(c.outlineColor), under = background(parseFloat(c.outlineOffset) < 0 ? a : a.parentElement || a);
    return { hidden, clip: clip.width > 0 && clip.height > 0 ? clip : null, style: c.outlineStyle, width: parseFloat(c.outlineWidth) || 0, ratio: ink ? ratio(over(ink, under), under) : null, obscured: Boolean(top) && !mine, by: top ? desc(top) : "" };
  };
  window[Symbol.for("argus.a11y")] = H;
}
`;

const KEYBOARD = String.raw`
/**
 * The keyboard pass for one action target (2.1.1, 2.4.3, 2.4.7, 1.4.11, 2.4.11): Tab from the page's start until
 * focus reaches the target or its composite widget (a pass), or cycles back (a fail), or max (500) presses pass
 * (undetermined: manual). A backward jump in DOM order is manual (F44 needs a human). At the target: a screenshot
 * focused must differ from one blurred; a solid outline needs 3:1, any other indicator is manual; its centre must
 * not sit under author content. A target the page does not hold once is left to the path. Focus ends blurred.
 */
export async function a11yKeyboard(page, target, step, max) {
  const out = [];
  const loc = a11yLocate(page, target);
  if ((await loc.count()) !== 1) return out;
  const el = await loc.elementHandle();
  await page.evaluate(a11yPageHelpers);
  const key = await page.evaluate((e) => window[Symbol.for("argus.a11y")].desc(e), el);
  await page.evaluate(() => window[Symbol.for("argus.a11y")].reset());
  await page.keyboard.press("Shift+Tab"); // out of the page: the next Tab is the first stop of the true order (positive tabindex first)
  const seen = new Set();
  let hit = false;
  for (let i = 0; i < (max || 500) && !hit; i++) {
    await page.keyboard.press("Tab");
    const s = await page.evaluate((a) => window[Symbol.for("argus.a11y")].stop(a), el);
    if (s.back && !seen.has(s.back)) {
      seen.add(s.back);
      out.push({ check: "tab-order", step, key: s.back, detail: "Tab jumps back in DOM order here; whether the order keeps meaning is a human call (2.4.3, F44)", manual: true });
    }
    if (s.cycled) return [...out, { check: "keyboard-reach", step, key, detail: "not in the tab order: Tab cycled back without reaching it (2.1.1)" }];
    hit = Boolean(s.hit);
  }
  if (!hit) return [...out, { check: "keyboard-reach", step, key, detail: "undetermined: not reached within " + (max || 500) + " Tab presses", manual: true }];
  const f = await page.evaluate(() => window[Symbol.for("argus.a11y")].facts());
  let shown = true;
  if (f.clip && !f.obscured) {
    await page.mouse.move(-1, -1);
    const on = await page.screenshot({ clip: f.clip, animations: "disabled", caret: "hide" });
    await page.evaluate(() => document.activeElement.blur());
    const off = await page.screenshot({ clip: f.clip, animations: "disabled", caret: "hide" });
    shown = !on.equals(off);
    if (!shown) out.push({ check: "focus-visible", step, key, detail: "focus shows no indicator: the focused and blurred states look the same (2.4.7)" });
  }
  if (shown && !f.hidden && !f.obscured && f.style !== "auto") {
    if (f.style === "solid" && f.width > 0 && f.ratio !== null) {
      if (f.ratio < 3) out.push({ check: "focus-contrast", step, key, detail: "the outline has " + f.ratio.toFixed(2) + ":1 against its background, under 3:1 (1.4.11)" });
    } else out.push({ check: "focus-contrast", step, key, detail: "the focus indicator is not a solid outline: its 3:1 contrast needs a human (1.4.11)", manual: true });
  }
  if (f.obscured) out.push({ check: "focus-not-obscured", step, key, detail: "the focused control's centre is under " + f.by + " (2.4.11)" });
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  return out;
}

`;

const NAMES = String.raw`
/** Every action target has an accessible name (4.1.2): toHaveAccessibleName(/\S/). A target the page does not hold once is left to the path. */
export async function a11yNames(expect, page, target, step) {
  const loc = a11yLocate(page, target);
  if ((await loc.count()) !== 1) return [];
  try {
    await expect(loc).toHaveAccessibleName(/\S/, { timeout: SETTLE });
    return [];
  } catch (e) {
    return [{ check: "name", step, key: await a11yDesc(page, loc), detail: "has no accessible name (4.1.2)" }];
  }
}

/** A locator's element as the reports key it: its role and accessible name, digit runs written #. */
async function a11yDesc(page, loc) {
  await page.evaluate(a11yPageHelpers);
  return page.evaluate((e) => window[Symbol.for("argus.a11y")].desc(e), await loc.elementHandle());
}
`;

// ---------------------------------------------------------------------------------------------------
// The emitters' helpers.

/** A repro string as code, as the generator's `str` writes it: JSON literals and a placeholder's variable. */
const strCode = (s) => {
  const parts = String(s)
    .split(/(\{\{[a-z][a-z0-9_]*\}\})/)
    .filter((p) => p !== "")
    .map((p) => (/^\{\{[a-z][a-z0-9_]*\}\}$/.test(p) ? (p === "{{marker}}" ? "marker" : `saved_${p.slice(2, -2)}`) : JSON.stringify(p)));
  return parts.length ? parts.join(" + ") : '""';
};
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** A parsed target as an object literal, every string through strCode. */
const targetLit = (t) => `{${Object.entries(t).map(([k, v]) => `${JSON.stringify(k)}: ${isObj(v) ? targetLit(v) : typeof v === "string" ? strCode(v) : JSON.stringify(v)}`).join(", ")}}`;

/** The page variable of account `as` among `steps`, spelled as the generator spells it (a name already taken gets `_`). */
function pageVar(as, steps, ctx) {
  if (ctx.pages && ctx.pages.get(as)) return ctx.pages.get(as).v;
  const taken = new Set([...OWN, ...steps.filter((s) => s.save).map((s) => (s.save === "marker" ? "marker" : `saved_${s.save}`))]);
  for (const a of new Set(steps.map((s) => s.as).filter((a) => a !== "system"))) {
    const [role, k] = a.split(".");
    let v = `${/^[A-Za-z_]/.test(role) ? "" : "_"}${role.replace(/[^A-Za-z0-9_]/g, "_")}${k}`;
    while (taken.has(v)) v += "_";
    taken.add(v);
    if (a === as) return v;
  }
  return "page";
}

/** The steps that run right after `step`'s group, when `step` is the last of its group (the checks that must see the page before an action). */
function upcoming(step, ctx) {
  const i = ctx.steps.findIndex((s) => s.n === step.n);
  const next = ctx.steps[i + 1];
  if (!next || (step.group && next.group === step.group)) return [];
  return next.group ? ctx.steps.filter((s) => s.group === next.group) : [next];
}

const BEFORE = new Set(["click", "check", "uncheck", "select", "fill"]);
const ACTIONS = new Set(["click", "dblclick", "hover", "check", "uncheck", "fill", "select", "press"]);
/** The lines of the checks that run in the a11y project: `body` inside its gate. */
const gated = (body) => (body.length ? [GATE, 'const a11y = require("./support");', ...body, "}"] : []);
const allowOf = (ctx) => JSON.stringify((((ctx.smoke || {}).journeys || {})[ctx.id] || {}).allow || []);
const report = (call, ctx) => `a11y.a11yReport(expect, test.info(), await ${call}, ${JSON.stringify(ctx.id)}, ${allowOf(ctx)});`;

/** Pre-action emitter: for each step that follows `step`'s group and `pick`s, one report of `call(step, pageVar)`. */
const before = (pick, call) => (step, ctx) =>
  gated(upcoming(step, ctx).filter((s) => s.as !== "system" && s.target && pick(s)).map((s) => report(call(s, pageVar(s.as, ctx.steps, ctx)), ctx)));

export const CHECKS = [
  { name: "a11y-core", project: "a11y", when: "never: the shared helpers", source: CORE, emit: () => [] },
  {
    name: "a11y-keyboard",
    project: "a11y",
    when: "before each click, check, uncheck, select and fill of the path",
    source: KEYBOARD,
    emit: before((s) => BEFORE.has(s.do), (s, p) => `a11y.a11yKeyboard(${p}, ${targetLit(s.target)}, ${s.n})`),
  },
  {
    name: "a11y-names",
    project: "a11y",
    when: "before each action on a target",
    source: NAMES,
    emit: before((s) => ACTIONS.has(s.do), (s, p) => `a11y.a11yNames(expect, ${p}, ${targetLit(s.target)}, ${s.n})`),
  },
];
