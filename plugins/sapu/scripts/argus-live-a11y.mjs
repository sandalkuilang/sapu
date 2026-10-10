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
  const hard = live.find((v) => v.hard && !v.manual);
  if (hard) throw new Error("accessibility: " + say(hard) + ": the test ends here"); // a state-changing submit: the path's later steps no longer start from its state
  return live;
}

/** Installs the page-side helpers (window[Symbol.for("argus.a11y")]): names, roles, colours and the Tab walk's probes. Run in every document. */
export function a11yPageHelpers() {
  const old = window[Symbol.for("argus.a11y")];
  if (old && old.doc === document) return;
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
  const H = { doc: document, first: null, prev: null, armed: null, roleOf, nameOf, desc, parse, over, ratio, background };
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
  const shown = (e) => { const r = e.getBoundingClientRect(), c = cs(e); return r.width > 0 && r.height > 0 && c.visibility !== "hidden" && c.display !== "none"; };
  H.shown = shown;
  H.form = (b) => {
    const f = b.form || b.closest("form");
    if (!f || !b.matches("button:not([type]), button[type=submit], input[type=submit], input[type=image]")) return null;
    const text = (e) => e.tagName === "TEXTAREA" || (e.tagName === "INPUT" && !/^(hidden|submit|button|reset|image|file|checkbox|radio|range|color)$/.test(e.type));
    return { fields: [...f.elements].map((e, index) => ({ e, index })).filter(({ e }) => text(e) && !e.disabled && !e.readOnly && shown(e)).map(({ e, index }) => ({ index, key: desc(e), type: e.tagName === "TEXTAREA" ? "textarea" : e.type, required: e.required, minLength: e.minLength > 0 ? e.minLength : null, maxLength: e.maxLength >= 0 ? e.maxLength : null, pattern: e.getAttribute("pattern") })) };
  };
  H.formState = (e) => {
    const flagged = e.getAttribute("aria-invalid") === "true", a = document.activeElement;
    const ids = ((e.getAttribute("aria-errormessage") || "") + " " + (e.getAttribute("aria-describedby") || "")).split(/\s+/).filter(Boolean);
    return {
      noValidate: e.form.noValidate,
      invalid: e.form.noValidate ? flagged : !e.validity.valid,
      told: e.form.noValidate ? ids.some((i) => { const n = document.getElementById(i); return Boolean(n) && shown(n) && n.textContent.trim() !== ""; }) : e.validationMessage !== "",
      focused: a === e || Boolean(a && a.tagName === "A" && e.id && a.getAttribute("href") === "#" + e.id),
    };
  };
  H.modal = () => {
    for (const d of document.querySelectorAll("dialog, [role=dialog], [role=alertdialog]")) {
      let modal = d.getAttribute("aria-modal") === "true";
      try { modal = modal || d.matches(":modal"); } catch (e) { /* no :modal here */ }
      if (modal && shown(d)) return d;
    }
    return null;
  };
  H.dname = (d) => {
    const by = (d.getAttribute("aria-labelledby") || "").split(/\s+/).map((i) => document.getElementById(i)).filter(Boolean).map((n) => n.textContent).join(" ");
    const h = d.querySelector("h1, h2, h3, h4, h5, h6");
    return roleOf(d) + ' "' + String(d.getAttribute("aria-label") || by || (h && h.textContent) || "").replace(/\s+/g, " ").trim().slice(0, 60).replace(/\d+/g, "#") + '"';
  };
  H.stops = (d) => [...d.querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex]")].filter((e) => !e.disabled && e.getAttribute("tabindex") !== "-1" && shown(e)).length;
  H.leaked = (d) => {
    const a = document.activeElement;
    if (a && d.contains(a)) return null;
    const out = !a || a === document.body || a === document.documentElement;
    let native = false;
    try { native = d.matches(":modal"); } catch (e) { /* no :modal here */ }
    return out ? (native ? null : "the page") : desc(a);
  };
  H.outside = (d) => {
    const r = d.getBoundingClientRect(), w = innerWidth, h = innerHeight;
    return [[2, 2], [w - 3, 2], [2, h - 3], [w - 3, h - 3], [w / 2, 2], [w / 2, h - 3]].map(([x, y]) => ({ x, y })).find((p) => p.x < r.left - 1 || p.x > r.right + 1 || p.y < r.top - 1 || p.y > r.bottom + 1) || null;
  };
  H.where = (inv) => {
    const a = document.activeElement;
    return !a || a === document.body || a === document.documentElement ? "body" : a === inv || inv.contains(a) ? "invoker" : desc(a);
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

const ARIA = String.raw`
/** The element an ARIA snapshot is taken of: main, else the body. */
export async function a11yAriaRoot(page) {
  const main = page.getByRole("main");
  return (await main.count()) > 0 ? main.first() : page.locator("body");
}

/** Why toMatchAriaSnapshot failed at a screen: no adopted baseline file (the runner compares it as empty), or the changed lines. */
export function a11yAriaFailure(info, e, step) {
  const name = step + ".aria.yml";
  let there = false;
  // ARIA_EXPECT's directory is the runner's {testFileBaseName}: the spec file's name without its last extension (<id>.spec).
  try { there = require("node:fs").existsSync(require("node:path").join(__dirname, "__aria__", require("node:path").parse(info.file).name, name)); } catch (x) { there = false; }
  if (!there) return { check: "aria-snapshot", step, key: "baseline-missing", detail: "no adopted " + name + ": a baseline run writes it and a reviewed pull request adopts it" };
  const diff = String(e && e.message).replace(/\u001b\[[0-9;]*m/g, "").split("\n").filter((l) => /^[-+] /.test(l) && !/^[-+] (Expected|Received)\b/.test(l));
  return { check: "aria-snapshot", step, key: "changed", detail: "the screen differs from " + name + ": " + diff.join(" | ").slice(0, 400) };
}
`;

const MODAL = String.raw`
/** Records the modal dialog open before a click, so the check after it sees only one that click opened. */
export async function a11yModalArm(page) {
  await page.evaluate(a11yPageHelpers);
  await page.evaluate(() => { const h = window[Symbol.for("argus.a11y")]; h.armed = h.modal(); });
}

/**
 * The checks of a modal dialog the click of the invoker opened (APG dialog and alertdialog, 2.1.2; none for a non-modal one):
 * Tab stays inside it; a click outside it behaves as in the journey's other modals; Escape closes it; focus then
 * returns to the invoker (exempt when it is gone, a fail when lost to the page, manual when elsewhere). It leaves
 * the dialog open as it found it, reopening it with the invoker; without that control it only checks Tab.
 */
export async function a11yModal(page, invoker, step, info) {
  const out = [];
  await page.evaluate(a11yPageHelpers);
  const current = async () => (await page.evaluateHandle(() => window[Symbol.for("argus.a11y")].modal())).asElement();
  let dlg = (await page.evaluateHandle(() => { const h = window[Symbol.for("argus.a11y")], m = h.modal(); return m && m !== h.armed ? m : null; })).asElement();
  if (!dlg) return out;
  const key = await page.evaluate((d) => window[Symbol.for("argus.a11y")].dname(d), dlg);
  const bad = (check, detail, manual) => out.push({ check, step, key, detail, ...(manual ? { manual: true } : {}) });
  const inv = a11yLocate(page, invoker);
  const gone = async (d, ms) => { try { await d.waitForElementState("hidden", { timeout: ms }); return true; } catch (e) { return false; } };
  const reopen = async () => {
    if ((await inv.count()) !== 1) return null;
    await inv.click();
    try { await page.waitForFunction(() => Boolean(window[Symbol.for("argus.a11y")].modal()), null, { timeout: SETTLE }); } catch (e) { return null; }
    return current();
  };
  const rounds = 2 + Math.min(60, await page.evaluate((d) => window[Symbol.for("argus.a11y")].stops(d), dlg));
  let left = null;
  for (let i = 0; i < rounds && !left; i++) {
    await page.keyboard.press("Tab");
    left = await page.evaluate((d) => window[Symbol.for("argus.a11y")].leaked(d), dlg);
  }
  if (left) bad("modal-focus-escape", "Tab moved focus out of the modal dialog to " + left + " (APG modal dialog)");
  if ((await inv.count()) !== 1) return [...out, { check: "modal-escape", step, key, detail: "not tested: the control that opened the dialog is gone, so the path could not reopen it", manual: true }];
  const lost = (what) => { bad("modal-reopen", "the control that opened the dialog does not reopen it after " + what + ": the path's later steps may fail", true); return out; };
  const spot = await page.evaluate((d) => window[Symbol.for("argus.a11y")].outside(d), dlg);
  if (spot) {
    await page.mouse.click(spot.x, spot.y);
    const closes = await gone(dlg, Math.min(SETTLE, 1000));
    const mine = closes ? "closes" : "stays";
    const other = info.annotations.filter((a) => a.type === "a11y-backdrop").map((a) => a.description.split("|")).find((p) => p[1] !== mine);
    if (other) bad("modal-backdrop", "a click outside it " + mine + " it, but outside " + other[0] + " it " + other[1] + ": modal dialogs of one journey behave alike");
    info.annotations.push({ type: "a11y-backdrop", description: key + "|" + mine });
    if (closes && !(dlg = await reopen())) return lost("a click outside");
  }
  await page.keyboard.press("Escape");
  if (!(await gone(dlg, SETTLE))) return [...out, { check: "modal-escape", step, key, detail: "Escape does not close the modal dialog (APG dialog pattern; 2.1.2 allows a trap only where Escape leaves)" }];
  if ((await inv.count()) === 1) {
    const where = await page.evaluate((i) => window[Symbol.for("argus.a11y")].where(i), await inv.elementHandle());
    if (where === "body") bad("modal-focus-return", "focus was lost to the page when the dialog closed: it returns to the control that opened it (APG)");
    else if (where !== "invoker") bad("modal-focus-return", "focus went to " + where + " instead of the control that opened the dialog; only a workflow that makes it a more logical choice allows that (APG)", true);
  }
  return (await reopen()) ? out : lost("Escape");
}
`;

const AXE = String.raw`
/** Whether the page holds a main landmark (axe is then scoped to it). */
export async function a11yHasMain(page) {
  return (await page.getByRole("main").count()) > 0;
}

/** axe's results for one screen → violations {check: "axe:<rule>", key: its target joined}; incomplete nodes are manual. */
export function a11yAxeResults(results, step) {
  const out = [], seen = new Set();
  const joined = (t) => t.map((x) => (Array.isArray(x) ? x.join(" >> ") : x)).join(" | ");
  const criteria = (tags) => tags.filter((t) => /^wcag\d{3,4}$/.test(t)).map((t) => t.slice(4, 5) + "." + t.slice(5, 6) + "." + t.slice(6));
  for (const [list, manual] of [[results.violations || [], false], [results.incomplete || [], true]]) {
    for (const rule of list) {
      for (const node of rule.nodes || []) {
        const key = joined(node.target || []), id = manual + rule.id + "|" + key;
        if (seen.has(id)) continue;
        seen.add(id);
        const sc = criteria(rule.tags || []);
        out.push({ check: "axe:" + rule.id, step, key, detail: rule.help + (sc.length ? " (WCAG " + sc.join(", ") + ")" : "") + (manual ? ": axe could not decide, needs a human" : ""), ...(manual ? { manual: true } : {}) });
      }
    }
  }
  return out;
}
`;

const TOKENS = String.raw`
/** The values of a token source: a CSS file's custom properties (a reference to another token is no value of its own), or a JSON file's string leaves ($value included). */
export function a11yTokenValues(kind, text) {
  const out = [];
  if (kind === "css") {
    for (const m of String(text).replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/--[\w-]+\s*:\s*([^;}]+)/g)) if (m[1].trim() && !/var\(/.test(m[1])) out.push(m[1].trim());
    return out;
  }
  const walk = (n) => {
    if (typeof n === "string") out.push(n.trim());
    else if (n && typeof n === "object") for (const [k, v] of Object.entries(n)) if (!/^(\$type|\$description|\$extensions|type|description)$/.test(k)) walk(v);
  };
  try { walk(JSON.parse(text)); } catch (e) { return []; }
  return out.filter(Boolean);
}

/**
 * Design tokens (live.json's tokens: a tracked CSS or JSON file, read from the repo's root): each visible control's computed
 * color, non-transparent background-color, first font-family and font-size must be one of the tokens, normalized in the
 * page by setting each on a probe. A kind of property the file holds no value for is not checked. Tokens are never inferred:
 * without a source the page says so once.
 */
export async function a11yTokens(page, step, info) {
  const note = (why) => {
    if (!info.annotations.some((a) => a.type === "a11y-note")) info.annotations.push({ type: "a11y-note", description: "design tokens: not checked (" + why + ")" });
    return [];
  };
  const path = require("node:path");
  let src = null;
  try { src = JSON.parse(require("node:fs").readFileSync(path.join(REPO, ".argus", "live.json"), "utf8")).tokens; } catch (e) { src = null; }
  const kind = src && typeof src.css === "string" ? "css" : src && typeof src.json === "string" ? "json" : null;
  if (!kind) return note("no token source");
  const file = path.resolve(REPO, src[kind]);
  if (path.relative(REPO, file).startsWith("..")) return note("the token source is outside the repo");
  let values = [];
  try { values = a11yTokenValues(kind, require("node:fs").readFileSync(file, "utf8")); } catch (e) { values = []; }
  if (!values.length) return note("the token source holds no values");
  await page.evaluate(a11yPageHelpers);
  const off = await page.evaluate((tokens) => {
    const H = window[Symbol.for("argus.a11y")];
    const first = (v) => v.split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase();
    const props = { color: new Set(), "background-color": new Set(), "font-family": new Set(), "font-size": new Set() };
    for (const prop of Object.keys(props)) {
      for (const v of tokens) {
        const probe = document.createElement("span");
        probe.style.setProperty(prop, v);
        if (!probe.style.getPropertyValue(prop)) continue;
        document.body.append(probe);
        const got = getComputedStyle(probe).getPropertyValue(prop);
        probe.remove();
        props[prop].add(prop === "font-family" ? first(got) : got);
      }
    }
    const found = new Map();
    for (const e of document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=switch]")) {
      if (!H.shown(e) || e.closest("[aria-hidden=true], [inert]")) continue;
      const c = getComputedStyle(e), bg = H.parse(c.backgroundColor);
      const mine = { color: c.color, "background-color": bg && bg[3] === 0 || c.backgroundColor === "transparent" ? null : c.backgroundColor, "font-family": first(c.fontFamily), "font-size": c.fontSize };
      for (const [prop, v] of Object.entries(mine)) if (v !== null && props[prop].size && !props[prop].has(v)) found.set(prop + " " + H.desc(e), prop + " " + v);
    }
    return [...found].slice(0, 25);
  }, values);
  return off.map(([key, what]) => ({ check: "design-token", step, key, detail: what + " is not one of the design tokens" }));
}
`;

const FORMS = String.raw`
/**
 * The cases a form's fields give (spec 19.7), at most max: from each field's own required (empty), type=email
 * ("not-an-email"), maxlength (one character too many), minlength (one too few, from 2) and pattern (the first of a
 * fixed list of values the pattern refuses). No other constraint gives a case, and no business rule is invented.
 */
export function a11yCasesOf(fields, max) {
  const refused = ["!", "~", " ", "@", "0", "a", "A", "-", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"];
  const out = [];
  for (const f of fields) {
    const add = (kind, value, limit) => out.push({ kind, index: f.index, key: f.key, value, limit });
    if (f.required) add("required", "");
    if (f.type === "email") add("email", "not-an-email");
    if (f.maxLength > 0 && f.maxLength <= 1000) add("maxlength", "x".repeat(f.maxLength + 1), f.maxLength);
    if (f.minLength > 1) add("minlength", "x".repeat(f.minLength - 1));
    if (f.pattern) {
      let re = null;
      for (const flags of ["v", "u"]) if (!re) try { re = new RegExp("^(?:" + f.pattern + ")$", flags); } catch (e) { re = null; }
      const bad = re ? refused.find((v) => !re.test(v)) : undefined;
      if (bad !== undefined) add("pattern", bad);
    }
  }
  return out.slice(0, Math.max(0, max));
}

/**
 * The negative cases of the form a path's submit click belongs to (3.3.1): each case fills one field with a value its
 * own constraint refuses, the others holding the path's values, and clicks the path's submit. It holds when no
 * non-GET request got a 2xx, the field is invalid (validity natively, aria-invalid under novalidate), an error is
 * associated (validationMessage, else aria-describedby or aria-errormessage naming visible text) and focus is on the
 * field or on a link to it. A browser that caps the input at maxlength holds. The first case that submits ends the
 * run with a hard violation (the report ends the test). Values are put back after each case.
 */
export async function a11yFormCases(page, submit, step, max) {
  const loc = a11yLocate(page, submit);
  if ((await loc.count()) !== 1) return [];
  await page.evaluate(a11yPageHelpers);
  const btn = await loc.elementHandle();
  const form = await page.evaluate((b) => window[Symbol.for("argus.a11y")].form(b), btn);
  if (!form) return [];
  const owner = await btn.evaluateHandle((b) => b.form || b.closest("form"));
  const out = [], posted = [];
  const seen = (r) => { if (r.request().method() !== "GET" && r.status() >= 200 && r.status() < 300) posted.push(r.status() + " " + r.request().method() + " " + new URL(r.url()).pathname); };
  page.on("response", seen);
  try {
    for (const c of a11yCasesOf(form.fields, max)) {
      const field = (await page.evaluateHandle(([f, i]) => f.elements[i], [owner, c.index])).asElement();
      const original = await field.inputValue();
      await field.fill(c.value);
      const key = c.key + " " + c.kind;
      const bad = (check, detail) => out.push({ check, step, key, detail: "after a " + c.kind + " value: " + detail });
      if (c.kind === "maxlength" && (await field.inputValue()).length <= c.limit) {
        await field.fill(original);
        continue;
      }
      const blocked = await page.evaluate((f) => !f.noValidate && !f.checkValidity(), owner);
      posted.length = 0;
      await btn.click();
      if (!blocked) {
        try { await page.waitForResponse((r) => r.request().method() !== "GET", { timeout: Math.min(SETTLE, 800) }); } catch (e) { /* no request */ }
      }
      let state = null;
      try {
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        state = await page.evaluate(([f, i]) => window[Symbol.for("argus.a11y")].formState(f.elements[i]), [owner, c.index]);
      } catch (e) { state = null; }
      if (posted.length || !state) return [...out, { check: "form-accepts-invalid", step, key, hard: true, detail: "the form was submitted with a " + c.kind + " value (" + (posted.join(", ") || "the page navigated") + "): the server accepted what the field refuses" }];
      if (!state.invalid) bad("form-case-invalid", state.noValidate ? "the field is not marked aria-invalid" : "the browser does not find the field invalid");
      if (!state.told) bad("form-case-error", "no error message is associated with the field (validationMessage, or aria-describedby or aria-errormessage naming visible text; 3.3.1)");
      if (!state.focused) bad("form-case-focus", "focus is neither on the field nor on a link to it");
      await field.fill(original);
    }
  } finally {
    page.off("response", seen);
  }
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

/** The page variable of account `as`: the generator's own (`ctx.pages`, argus-live-codegen's pageVars). */
const pageVar = (as, ctx) => ctx.pages.get(as).v;

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

/** Pre-action emitter: for each step that follows the step's group and `pick`s, the line `line(step, pageVariable, ctx)`. */
const before = (pick, line) => (step, ctx) => gated(upcoming(step, ctx).filter((s) => s.as !== "system" && s.target && pick(s, ctx)).map((s) => line(s, pageVar(s.as, ctx), ctx)));
const reported = (call) => (s, p, ctx) => report(call(s, p), ctx);

/** Whether step `s` ends one of the path's screens: the generator's one list (`ctx.screens`, argus-live-codegen's screensOf), which the screenshots use too. */
const isScreen = (s, ctx) => ctx.screens.includes(s.n);
/** Post-step emitter: for a step that ends a screen (or is a click), the lines `line(step, pageVariable, ctx)` makes. */
const after = (pick, line) => (step, ctx) => (step.as !== "system" && pick(step, ctx) ? gated(line(step, pageVar(step.as, ctx), ctx)) : []);

/**
 * The `expect.toMatchAriaSnapshot` config the specs need (the generator's `playwright.config.ts`): a baseline per test
 * and screen under __aria__/. Matching is already partial by default [pw-aria]; `children: "contain"` is not set on
 * purpose: probed, it makes a missing or empty baseline match, so the run passes with nothing adopted.
 */
export const ARIA_EXPECT = { pathTemplate: "{testDir}/__aria__/{testFileBaseName}/{arg}{ext}" };

/** The click steps right after the fills of a form: the submits whose form has cases to run. */
const submits = (s, ctx) => {
  const i = ctx.steps.findIndex((x) => x.n === s.n);
  let j = i - 1;
  while (j >= 0 && ctx.steps[j].as === s.as && ["fill", "select", "check", "uncheck"].includes(ctx.steps[j].do)) j--;
  return s.do === "click" && j < i - 1;
};
const casesMax = (ctx) => (Number.isInteger((ctx.smoke || {}).form_cases_max) ? ctx.smoke.form_cases_max : 6);
const WCAG_TAGS = '["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]';

export const CHECKS = [
  { name: "a11y-core", project: "a11y", when: "never: the shared helpers", source: CORE, emit: () => [] },
  {
    name: "a11y-keyboard",
    project: "a11y",
    when: "before each click, check, uncheck, select and fill of the path",
    source: KEYBOARD,
    emit: before((s) => BEFORE.has(s.do), reported((s, p) => `a11y.a11yKeyboard(${p}, ${targetLit(s.target)}, ${s.n})`)),
  },
  {
    name: "a11y-names",
    project: "a11y",
    when: "before each action on a target",
    source: NAMES,
    emit: before((s) => ACTIONS.has(s.do), reported((s, p) => `a11y.a11yNames(expect, ${p}, ${targetLit(s.target)}, ${s.n})`)),
  },
  {
    name: "a11y-aria",
    project: "a11y",
    when: "at each screen of the path",
    source: ARIA,
    emit: after(isScreen, (s, p, ctx) => [
      `const root = await a11y.a11yAriaRoot(${p});`,
      "const found = [];",
      `try { await expect(root).toMatchAriaSnapshot({ name: "${s.n}.aria.yml", timeout: SETTLE }); } catch (e) { found.push(a11y.a11yAriaFailure(test.info(), e, ${s.n})); }`,
      `a11y.a11yReport(expect, test.info(), found, ${JSON.stringify(ctx.id)}, ${allowOf(ctx)});`,
    ]),
  },
  {
    name: "a11y-axe",
    project: "a11y",
    when: "at each screen of the path",
    source: AXE,
    emit: after(isScreen, (s, p, ctx) => [
      'const { AxeBuilder } = require("@axe-core/playwright");',
      `const base = new AxeBuilder({ page: ${p} }).withTags(${WCAG_TAGS}).disableRules(["target-size"]);`,
      `const builder = (await a11y.a11yHasMain(${p})) ? base.include("main") : base;`,
      report(`a11y.a11yAxeResults(await builder.analyze(), ${s.n})`, ctx),
    ]),
  },
  {
    name: "a11y-tokens",
    project: "a11y",
    when: "at each screen of the path, with live.json's tokens",
    source: TOKENS,
    emit: after(isScreen, (s, p, ctx) => [report(`a11y.a11yTokens(${p}, ${s.n}, test.info())`, ctx)]),
  },
  {
    name: "a11y-forms",
    project: "a11y",
    when: "before a click that submits the form the path just filled",
    source: FORMS,
    emit: (step, ctx) => (casesMax(ctx) > 0 ? before(submits, reported((s, p) => `a11y.a11yFormCases(${p}, ${targetLit(s.target)}, ${s.n}, ${casesMax(ctx)})`))(step, ctx) : []),
  },
  {
    name: "a11y-modals",
    project: "a11y",
    when: "after each click that opens a modal dialog",
    source: MODAL,
    emit: (step, ctx) => [
      ...before((s) => s.do === "click", (s, p) => `await a11y.a11yModalArm(${p});`)(step, ctx),
      ...after((s) => s.do === "click" && s.target, (s, p) => [report(`a11y.a11yModal(${p}, ${targetLit(s.target)}, ${s.n}, test.info())`, ctx)])(step, ctx),
    ],
  },
];
