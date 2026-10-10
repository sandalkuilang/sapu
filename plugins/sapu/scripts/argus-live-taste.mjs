// argus-live-taste.mjs — the visual probes of the taste pass (spec §20.2: scale and restraint, hierarchy and
// rhythm, colour roles and dark parity, contrast headroom, motion, density), as in-page sources the suite embeds
// verbatim and the lane runs through the session hook. A leaf module: it reads the plugin's bar file as data, and
// imports no other argus-live module.
//
// Three parts, each measured, never guessed (aesthetics.md §1: taste proposes, measurement decides):
// - TASTE_SOURCE, the in-page census: what one screen uses (spacing, type, colours resolved through a canvas,
//   radii, shadows) and the geometry the hierarchy rules read. It measures; it never judges.
// - rulesFor, the judge of one screen: a pure, self-contained function (its source runs in a page as it runs here),
//   reading the census against the bar's thresholds and the owner's scale. A count rule whose threshold is the
//   app's own best peer (`threshold.peer`) is one measurement row (`expected: "peer"`): the lane's judge compares it.
// - censusOf, the media pass around the census, and ruleExpression, one rule as a page expression.
import fs from "node:fs";

/** The bar as shipped (`plugins/sapu/data/taste-bar.json`), read as data: argus-live-tastecfg.mjs validates it. */
const BAR = JSON.parse(fs.readFileSync(new URL("../data/taste-bar.json", import.meta.url), "utf8"));
/** The rule families this module measures (argus-live-tastecfg.mjs FAMILIES, probe `taste`). */
const OURS = ["scale", "hierarchy", "colour", "contrast", "motion", "density"];

/**
 * The in-page census: the source of one self-contained function `(arg) => census`, run as `(${TASTE_SOURCE})(arg)`.
 * It reads the page in the media it answers now. Colours are resolved by the browser through a 1x1 canvas, never
 * parsed (an oklch() page measures as its sRGB twin); lengths come from the Typed OM where the browser has it, so an
 * `auto` or percentage margin is never read as a spacing value. Every element key is `<tag>|<label>` (the accessible
 * label or own text, at most 60 characters), digit runs written `#`.
 */
export const TASTE_SOURCE = String.raw`(arg) => {
  const o = arg || {};
  const doc = document;
  const win = window;
  const MAX = 3000;
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const cs = (el) => win.getComputedStyle(el);
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const half = (n) => Math.round(n * 2) / 2;
  const own = (el) => { let t = ""; for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue; return norm(t); };
  const label = (el) => norm(el.getAttribute("aria-label") || own(el) || el.getAttribute("alt") || el.textContent).slice(0, 60);
  const keyOf = (el) => el.tagName.toLowerCase() + "|" + label(el).replace(/[0-9]+/g, "#");
  const media = { dark: win.matchMedia("(prefers-color-scheme: dark)").matches, reduce: win.matchMedia("(prefers-reduced-motion: reduce)").matches };

  // Colours: the browser converts any colour space; a premultiplied read loses little for a translucent colour.
  const cv = doc.createElement("canvas");
  cv.width = cv.height = 1;
  const g = cv.getContext("2d", { willReadFrequently: true });
  const memo = new Map();
  const rgba = (css) => {
    if (memo.has(css)) return memo.get(css);
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = "black";
    g.fillStyle = css;
    g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    const v = { r: d[0], g: d[1], b: d[2], a: Math.round((d[3] / 255) * 100) / 100 };
    memo.set(css, v);
    return v;
  };
  const str = (c) => (c.a >= 1 ? "rgb(" + c.r + ", " + c.g + ", " + c.b + ")" : "rgba(" + c.r + ", " + c.g + ", " + c.b + ", " + c.a + ")");
  const over = (t, u) => ({ r: Math.round(t.r * t.a + u.r * (1 - t.a)), g: Math.round(t.g * t.a + u.g * (1 - t.a)), b: Math.round(t.b * t.a + u.b * (1 - t.a)), a: 1 });
  const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100; };
  // OKLCH chroma: a colour at 0.05 or more is a colour, below it a neutral (tinted greys included).
  const chroma = (c) => {
    const R = lin(c.r), G = lin(c.g), B = lin(c.b);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B), m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B), s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    return Math.hypot(1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s);
  };
  const rootScheme = norm(cs(doc.documentElement).colorScheme + " " + ((doc.querySelector('meta[name="color-scheme"]') || {}).content || ""));
  const canvasBg = /dark/.test(rootScheme) && (!/light/.test(rootScheme) || media.dark) ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  // The colour behind an element's content, composited up its ancestors; null over an image or a gradient (unknown).
  const surface = (el) => {
    const stack = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = cs(n);
      if (s.backgroundImage && s.backgroundImage !== "none") return null;
      const c = rgba(s.backgroundColor);
      if (c.a > 0) { stack.push(c); if (c.a >= 1) break; }
    }
    let out = canvasBg;
    for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
    return out;
  };

  // What renders: a box of some size, visible, not hidden from everyone (the visually-hidden pattern is 1x1).
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if ((r.width <= 1 && r.height <= 1) || r.width === 0 || r.height === 0) return false;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true })) return false;
    return !el.closest('[aria-hidden="true"], [inert]');
  };
  const SKIP = /^(script|style|template|noscript|svg|math|head|title|meta|link)$/i;
  const all = [];
  for (const el of [doc.body, ...doc.body.querySelectorAll("*")]) {
    if (SKIP.test(el.tagName) || el.closest("svg, math")) continue;
    if (shown(el)) all.push(el);
    if (all.length >= MAX) break;
  }
  const isShown = new Set(all);
  const modal = all.find((el) => el.matches("dialog:modal, [aria-modal='true']"));
  const typed = (el, prop) => {
    try {
      const v = el.computedStyleMap ? el.computedStyleMap().get(prop) : null;
      if (v) return v.unit === "px" ? v.value : null;
    } catch (e) {}
    const s = cs(el).getPropertyValue(prop);
    return /px$/.test(s) ? num(s) : null;
  };
  const SIDES = ["top", "right", "bottom", "left"];
  const CORNERS = ["top-left", "top-right", "bottom-right", "bottom-left"];
  // A corner's radius: px, "full" for a circle or a pill, 0 for none.
  const radius = (el, s, corner) => {
    const v = s.getPropertyValue("border-" + corner + "-radius");
    if (!v || v === "0px") return 0;
    const r = el.getBoundingClientRect();
    const px = /%/.test(v) ? (num(v) / 100) * Math.min(r.width, r.height) : num(v);
    return px >= Math.min(r.width, r.height) / 2 - 0.5 ? "full" : half(px);
  };
  const visibleBorder = (s) => SIDES.some((d) => num(s.getPropertyValue("border-" + d + "-width")) >= 1 && !/none|hidden/.test(s.getPropertyValue("border-" + d + "-style")) && rgba(s.getPropertyValue("border-" + d + "-color")).a > 0);
  // A box the eye sees: a border, or a fill that differs from what is behind it.
  const boxed = (el, s) => {
    if (visibleBorder(s)) return true;
    const f = rgba(s.backgroundColor);
    if (f.a === 0) return false;
    const behind = el.parentElement ? surface(el.parentElement) : canvasBg;
    if (!behind) return true;
    const c = over(f, behind);
    return Math.abs(c.r - behind.r) + Math.abs(c.g - behind.g) + Math.abs(c.b - behind.b) > 6;
  };
  // Fluid type: a font-size the stylesheets or an inline style set with clamp(), min(), max() or a viewport unit.
  const FLUID = /clamp\(|min\(|max\(|\d(vw|vh|vi|vb|vmin|vmax|cqw|cqh|cqi|cqb)\b/;
  const fluidRules = [];
  const walk = (rules) => {
    for (const r of rules) {
      if (r.selectorText && r.style && FLUID.test(r.style.getPropertyValue("font-size"))) fluidRules.push(r.selectorText);
      else if (!r.selectorText && r.cssRules) walk(r.cssRules);
    }
  };
  for (const sheet of doc.styleSheets) { try { walk(sheet.cssRules); } catch (e) {} }
  const fluid = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (FLUID.test(n.style.fontSize)) return true;
      if (fluidRules.some((sel) => { try { return n.matches(sel); } catch (e) { return false; } })) return true;
    }
    return false;
  };
  const isButton = (el) => el.matches("button, input[type=submit], input[type=button], input[type=reset], [role=button]");
  const INTERACTIVE = "a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=radio], [role=switch]";
  const NOT_SURFACE = INTERACTIVE + ", img, video, canvas, iframe, picture, embed, object";

  const spacing = new Set(), types = new Map(), weights = new Set(), colours = new Set(), palette = new Set(), radii = new Set(), radiusValues = new Set(), shadows = new Map();
  const headings = [], buttons = [], nested = [], text = [], borders = [], surfaces = [], roles = [];
  const surfaceKeys = new Map();
  const addColour = (c) => {
    if (c.a === 0) return;
    palette.add(str(c));
    if (chroma(c) >= 0.05) colours.add(str(c));
  };
  const layerOf = (el, s) => (el.matches("dialog:modal, [aria-modal='true'], [role=dialog], [role=alertdialog]") ? "modal" : s.position === "fixed" || s.position === "absolute" || el.matches(":popover-open, [role=menu], [role=listbox], [role=tooltip]") ? "overlay" : "raised");
  const shadowOf = (v) => {
    // The computed value lists each layer as "<colour> <x> <y> <blur> <spread>[ inset]": a ring (no offset, no blur) and an inset are not elevation.
    const layers = String(v).split(/,(?![^(]*\))/).map((l) => l.trim()).filter((l) => l && !/\binset\b/.test(l));
    const lifted = layers.filter((l) => { const n = l.replace(/^[a-z]+\([^)]*\)\s*/i, "").split(/\s+/).map(num); return n[0] !== 0 || n[1] !== 0 || n[2] !== 0; });
    return lifted.length ? lifted.map((l) => l.replace(/^[a-z]+\([^)]*\)/i, (c) => str(rgba(c)))).join(", ") : null;
  };
  for (const el of all) {
    const s = cs(el);
    for (const d of SIDES) {
      const p = typed(el, "padding-" + d);
      if (p) spacing.add(half(p));
      const m = typed(el, "margin-" + d);
      if (m) spacing.add(half(Math.abs(m)));
    }
    for (const p of ["row-gap", "column-gap"]) { const v = typed(el, p); if (v) spacing.add(half(v)); }
    const words = own(el), box = el.getBoundingClientRect();
    if (words) {
      const px = half(num(s.fontSize)), w = Math.round(num(s.fontWeight));
      if (!types.has(px + "/" + w)) types.set(px + "/" + w, { px, w, fluid: fluid(el) });
      weights.add(w);
      addColour(rgba(s.color));
    }
    addColour(rgba(s.backgroundColor));
    for (const d of SIDES) if (num(s.getPropertyValue("border-" + d + "-width")) >= 1 && !/none|hidden/.test(s.getPropertyValue("border-" + d + "-style"))) addColour(rgba(s.getPropertyValue("border-" + d + "-color")));
    const corners = CORNERS.map((c) => radius(el, s, c));
    for (const r of corners) if (r) { radii.add(r); if (r !== "full") radiusValues.add(r); }
    if (s.boxShadow && s.boxShadow !== "none") {
      const v = shadowOf(s.boxShadow);
      if (v) { if (!shadows.has(v)) shadows.set(v, new Set()); shadows.get(v).add(layerOf(el, s)); }
    }
    // Text contrast against its composited surface (none over an image or a gradient); a disabled control is exempt.
    if (words && text.length < 400 && !el.closest(":disabled, [aria-disabled='true']")) {
      const sf = surface(el);
      if (sf) {
        const ink0 = rgba(s.color), ink = ink0.a < 1 ? over(ink0, sf) : ink0, size = num(s.fontSize);
        text.push({ key: keyOf(el), ratio: ratio(ink, sf), large: size >= 24 || (size >= 18.66 && num(s.fontWeight) >= 700), ink: str(ink), surface: str(sf) });
      }
    }
    // An edge: the strongest of the border and the fill against what is behind the element.
    const side = SIDES.find((d) => num(s.getPropertyValue("border-" + d + "-width")) >= 1 && !/none|hidden/.test(s.getPropertyValue("border-" + d + "-style")) && rgba(s.getPropertyValue("border-" + d + "-color")).a > 0);
    const outer = el.parentElement ? surface(el.parentElement) : null;
    if (side && outer && s.backgroundImage === "none" && borders.length < 300) {
      const f = rgba(s.backgroundColor), fill = f.a > 0 ? over(f, outer) : outer;
      borders.push({ key: keyOf(el), edge: Math.max(ratio(over(rgba(s.getPropertyValue("border-" + side + "-color")), outer), outer), ratio(fill, outer)) });
    }
    // A surface: a card-sized box with its own opaque fill, never a control or media; "in" names its nearest surface ancestor.
    if (box.width >= 100 && box.height >= 40 && s.backgroundImage === "none" && !el.matches(NOT_SURFACE) && surfaces.length < 300) {
      const f = rgba(s.backgroundColor);
      if (f.a >= 0.9) {
        const c = f.a < 1 ? over(f, outer || canvasBg) : f;
        let up = el.parentElement;
        while (up && !surfaceKeys.has(up)) up = up.parentElement;
        surfaceKeys.set(el, keyOf(el));
        surfaces.push({ key: keyOf(el), rgb: str(c), lum: Math.round(lum(c) * 1000) / 1000, in: up ? surfaceKeys.get(up) : null });
      }
    }
    // A status badge: short text on its own fill, rounded or padded, no control. Its role is its text; its value the fill and ink.
    if (words && words.length <= 24 && words.split(" ").length <= 3 && box.height <= 40 && !el.closest(INTERACTIVE) && rgba(s.backgroundColor).a > 0 && boxed(el, s) && (radius(el, s, "top-left") || num(s.paddingLeft) >= 2)) {
      const fill = over(rgba(s.backgroundColor), outer || canvasBg);
      roles.push({ text: words.toLowerCase().replace(/[0-9]+/g, "#"), sig: str(fill) + " / " + str(over(rgba(s.color), fill)) });
    }
    if (/^h[1-6]$/i.test(el.tagName) || el.getAttribute("role") === "heading") {
      const level = /^h[1-6]$/i.test(el.tagName) ? Number(el.tagName[1]) : Number(el.getAttribute("aria-level")) || 2;
      headings.push({ level, px: half(num(s.fontSize)), key: keyOf(el) });
    }
    if (isButton(el) && !el.matches(":disabled, [aria-disabled='true']") && (!modal || modal.contains(el))) {
      const fill = rgba(s.backgroundColor), behind = el.parentElement ? surface(el.parentElement) : canvasBg;
      if (fill.a >= 0.5 && behind) {
        const c = over(fill, behind);
        buttons.push({ name: norm(label(el)).toLowerCase().replace(/[0-9]+/g, "#"), sig: str(c) + " / " + str(over(rgba(s.color), c)), loud: ratio(c, behind) });
      }
    }
    // A corner a child shares with its nearest boxed ancestor (it sits inside that corner's curve), more rounded than it.
    if (corners.some((r) => r && r !== "full") && boxed(el, s)) {
      let p = el.parentElement;
      while (p && p !== doc.body && p !== doc.documentElement && !boxed(p, cs(p))) p = p.parentElement;
      if (p && p !== doc.body && p !== doc.documentElement) {
        const ps = cs(p), a = el.getBoundingClientRect(), b = p.getBoundingClientRect();
        const gaps = [[a.left - b.left, a.top - b.top], [b.right - a.right, a.top - b.top], [b.right - a.right, b.bottom - a.bottom], [a.left - b.left, b.bottom - a.bottom]];
        for (let i = 0; i < 4; i++) {
          const cr = corners[i], pr = radius(p, ps, CORNERS[i]);
          if (!cr || cr === "full" || pr === "full" || cr <= (pr || 0) + 0.5) continue;
          if (gaps[i][0] >= -0.5 && gaps[i][1] >= -0.5 && gaps[i][0] <= (pr || 0) + 0.5 && gaps[i][1] <= (pr || 0) + 0.5) {
            nested.push({ key: keyOf(el), child: cr, parent: pr || 0 });
            break;
          }
        }
      }
    }
  }

  // Siblings stacked in one column, judged by their left edges: a container's in-flow block children, none centred or
  // pushed right by an auto margin; a container that centres or ends its items, or lays them side by side, is skipped.
  const BLOCK = /^(block|flex|grid|table|list-item|flow-root)$/;
  const stacked = (p) => {
    const ps = cs(p);
    if (/flex|grid/.test(ps.display) && /center|end/.test(ps.alignItems + " " + ps.justifyItems)) return [];
    const kids = [...p.children].filter((k) => isShown.has(k) && BLOCK.test(cs(k).display) && /^(static|relative|sticky)$/.test(cs(k).position) && cs(k).float === "none" && typed(k, "margin-left") !== null);
    const rects = kids.map((k) => ({ k, r: k.getBoundingClientRect() })).sort((x, y) => x.r.top - y.r.top);
    for (let i = 1; i < rects.length; i++) if (rects[i].r.top < rects[i - 1].r.bottom - 1) return [];
    return rects;
  };
  const alignment = [];
  for (const p of new Set(all.map((el) => el.parentElement).filter(Boolean))) {
    const rects = stacked(p);
    if (rects.length < 2) continue;
    const count = new Map();
    for (const { r } of rects) count.set(Math.round(r.left), (count.get(Math.round(r.left)) || 0) + 1);
    const ref = [...count].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0][0];
    const at = rects.find((x) => Math.round(x.r.left) === ref).r;
    for (const { k, r } of rects) {
      const dx = Math.round(Math.abs(r.left - at.left) * 10) / 10;
      if (dx >= 0.5 && dx <= 8 && Math.abs(r.left + r.width / 2 - (at.left + at.width / 2)) > 0.5) alignment.push({ key: keyOf(k), dx });
    }
  }
  // Section gaps: the vertical gaps between the main region's stacked children.
  const region = doc.querySelector("main") || doc.body;
  const gaps = new Map();
  const sections = stacked(region);
  for (let i = 1; i < sections.length; i++) {
    const gap = half(sections[i].r.top - sections[i - 1].r.bottom);
    if (gap >= 1 && !gaps.has(gap)) gaps.set(gap, keyOf(sections[i].k));
  }

  const root = surface(doc.body) || canvasBg;
  return {
    media,
    vw: win.innerWidth,
    truncated: all.length >= MAX,
    counts: { spacing: spacing.size, type: types.size, weights: weights.size, colours: colours.size, radii: radii.size, shadows: shadows.size },
    values: { spacing: [...spacing], type: [...types.values()], radius: [...radiusValues], gaps: [...gaps.keys()] },
    palette: [...palette].sort(),
    headings,
    primary: { scope: modal ? "dialog" : "view", buttons },
    alignment,
    nested,
    shadows: [...shadows].map(([value, layers]) => ({ value, layers: [...layers].sort() })),
    text,
    borders,
    surfaces,
    roles,
    root: { rgb: str(root), lum: Math.round(lum(root) * 1000) / 1000 },
  };
}`;

/**
 * The motion recorder of the session hook's init payload (argus-live-browser.mjs PAGE_INIT): self-contained
 * script text run once a document after the taste buffer, recording `transition` and `animation` events through
 * `document.__argusTastePush` (argus-live-tastecfg.mjs TASTE_EVENTS). Empty until built: nothing is installed.
 */
export const TASTE_INIT = "";


/**
 * The per-screen rows `[{rule, key, measured, expected}]` of `screen` against `bar` and `cfg`. `screen` is censusOf's
 * result, or a recorded screen holding it as `taste`. `cfg` is loadTaste's value: `off` silences a rule, `frame` names
 * the bar's frame for the off-scale rules, and `tokens` (`{spacing?, radius?, type?}`, px numbers: the owner's tokens,
 * resolved by the caller) outranks the frame. A rule whose threshold is `peer` gives one row `{key: "screen",
 * measured: <count>, expected: "peer"}` a screen: the judge's to compare with the app's best peer and the band.
 * Self-contained (no outer reference): its source runs in a page, as ruleExpression and the suite run it.
 */
export function rulesFor(screen, bar, cfg) {
  const s = screen && screen.taste ? screen.taste : screen || {};
  const c = cfg || {};
  const scheme = s.media && s.media.colorScheme === "dark" ? "dark" : "light";
  const base = s[scheme] || s.light || s.dark;
  if (!base) return [];
  const FAMILIES = ["scale", "hierarchy", "colour", "contrast", "motion", "density"];
  const off = new Set(Array.isArray(c.off) ? c.off : []);
  const rules = (bar && Array.isArray(bar.rules) ? bar.rules : []).filter((r) => FAMILIES.includes(r.family) && !off.has(r.id));
  const frame = c.frame && bar && bar.frames ? bar.frames[c.frame] : null;
  const scaleOf = (m) => {
    if (c.tokens && Array.isArray(c.tokens[m])) return { from: "token", values: c.tokens[m] };
    const f = frame && frame[m];
    return f ? { from: c.frame, values: f.values, range: f.range, step: f.step } : null;
  };
  const onScale = (sc, v) => {
    if (sc.values) return sc.values.some((x) => Math.abs(x - v) < 0.5);
    if (v < sc.range[0] - 0.25 || v > sc.range[1] + 0.25) return false;
    if (!sc.step) return true;
    const k = (v - sc.range[0]) / sc.step;
    return Math.abs(k - Math.round(k)) * sc.step < 0.5;
  };
  const fires = (t, v) => (t.max !== undefined && v > t.max) || (t.min !== undefined && v < t.min) || (t.range !== undefined && (v < t.range[0] || v > t.range[1])) || (t.within !== undefined && v >= t.within[0] && v <= t.within[1]);
  const out = [];
  const each = (rule, list, row) => {
    if (list.length && fires(rule.threshold, list.length)) for (const x of list.slice(0, 50)) out.push({ rule: rule.id, ...row(x) });
  };
  const offScale = (rule, metrics, values) => {
    const list = [];
    for (const m of metrics) {
      const sc = scaleOf(m);
      if (sc) for (const v of values(m)) if (!onScale(sc, v)) list.push({ key: (m === "gaps" ? "gap" : m) + ":" + v + "px", measured: v, expected: "on the " + sc.from + " " + m + " scale" });
    }
    each(rule, list, (x) => x);
  };
  for (const rule of rules) {
    const t = rule.threshold;
    const id = rule.id;
    if (t.peer) {
      const count = base.counts && base.counts[String(rule.metric).replace(/^distinct_/, "")];
      if (typeof count === "number") out.push({ rule: id, key: "screen", measured: count, expected: "peer" });
    } else if (id === "scale.off-scale") {
      offScale(rule, ["spacing", "radius", "type"], (m) => (m === "type" ? base.values.type.filter((x) => !x.fluid).map((x) => x.px) : base.values[m]).slice().sort((a, b) => a - b));
    } else if (id === "hierarchy.section-gaps") {
      const sc = scaleOf("spacing");
      if (sc) each(rule, base.values.gaps.filter((v) => !onScale(sc, v)).sort((a, b) => a - b), (v) => ({ key: "gap:" + v + "px", measured: v, expected: "on the " + sc.from + " spacing scale" }));
    } else if (id === "hierarchy.primary-actions") {
      const groups = new Map();
      for (const b of base.primary.buttons) if (b.loud >= 2) (groups.get(b.sig) || groups.set(b.sig, { loud: b.loud, names: new Set() }).get(b.sig)).names.add(b.name);
      const loudest = [...groups.values()].sort((a, b) => b.loud - a.loud)[0];
      const n = loudest ? loudest.names.size : 0;
      if (fires(t, n)) out.push({ rule: id, key: base.primary.scope, measured: n, expected: t.max });
    } else if (id === "hierarchy.heading-order") {
      // Each heading against the one it sits under in the outline (the nearest earlier heading of a higher level).
      const list = base.headings.map((h, i) => ({ h, parent: base.headings.slice(0, i).reverse().find((g) => g.level < h.level) })).filter((x) => x.parent && x.h.px > x.parent.px + 0.5);
      each(rule, list, (x) => ({ key: x.h.key, measured: x.h.px, expected: "at most " + x.parent.px + " (its parent heading)" }));
    } else if (id === "hierarchy.alignment") {
      for (const a of base.alignment) if (fires(t, a.dx)) out.push({ rule: id, key: a.key, measured: a.dx, expected: "aligned, or at least " + (t.within[1] + 1) + " px apart" });
    } else if (id === "hierarchy.shadow-layers") {
      const layers = [...new Set(base.shadows.flatMap((x) => x.layers))].sort();
      if (fires(t, base.shadows.length - layers.length)) out.push({ rule: id, key: "view", measured: base.shadows.length, expected: "at most " + layers.length + " (layers: " + layers.join(", ") + ")" });
    } else if (id === "hierarchy.nested-radius") {
      each(rule, base.nested, (x) => ({ key: x.key, measured: x.child, expected: "at most " + x.parent + " (its parent's)" }));
    } else if (id === "colour.role") {
      // One role (a badge's text), one value: the judge joins several screens' roles to compare across them.
      const by = new Map();
      for (const x of base.roles) (by.get(x.text) || by.set(x.text, new Set()).get(x.text)).add(x.sig);
      for (const [text, sigs] of by) if (fires(t, sigs.size)) out.push({ rule: id, key: text, measured: (sigs.size + " values: " + [...sigs].join(" | ")).slice(0, 200), expected: t.max === 1 ? "one value" : "at most " + t.max + " values" });
    } else if (id === "contrast.headroom") {
      // Body text that passes AA (4.5:1) yet sits under the headroom; under 4.5:1 is axe's failure, not this.
      const pairs = new Map();
      for (const x of base.text) if (!x.large && x.ratio >= 4.5 && fires(t, x.ratio) && !(pairs.get(x.ink + " on " + x.surface) <= x.ratio)) pairs.set(x.ink + " on " + x.surface, x.ratio);
      for (const [key, v] of [...pairs].slice(0, 10)) out.push({ rule: id, key, measured: v, expected: t.min });
    } else if (id.startsWith("colour.dark-") && s.light && s.dark) {
      // Dark parity, element by element: what held in light and broke in dark (a failure in both is not dark's).
      const L = s.light, D = s.dark;
      const lightOf = (list) => new Map(list.map((x) => [x.key, x]));
      if (id === "colour.dark-contrast") {
        const light = lightOf(L.text);
        const need = (x) => (x.large ? 3 : 4.5);
        each(rule, D.text.filter((d) => light.has(d.key) && d.ratio < need(d) && light.get(d.key).ratio >= need(light.get(d.key))), (d) => ({ key: d.key, measured: d.ratio, expected: "at least " + need(d) + ":1, as in light (" + light.get(d.key).ratio + ":1)" }));
      } else if (id === "colour.dark-border") {
        const light = lightOf(L.borders);
        each(rule, D.borders.filter((d) => light.has(d.key) && light.get(d.key).edge >= 1.2 && d.edge < 1.1), (d) => ({ key: d.key, measured: d.edge, expected: "an edge of at least 1.1:1, as in light (" + light.get(d.key).edge + ":1)" }));
      } else if (id === "colour.dark-surface" && D.root.lum <= 0.1) {
        // A light surface the dark theme left as it was in light; one inside another such surface is that one's.
        const light = lightOf(L.surfaces), left = new Set(), list = [];
        for (const d of D.surfaces) {
          if (d.lum < 0.4 || !light.has(d.key) || light.get(d.key).rgb !== d.rgb) continue;
          if (!left.has(d.in)) list.push(d);
          left.add(d.key);
        }
        each(rule, list, (d) => ({ key: d.key, measured: d.rgb + " on " + D.root.rgb, expected: "a dark surface, as the page is" }));
      }
    }
  }
  return out.map((r) => ({ ...r, key: String(r.key).replace(/[\r\n]+/g, " ").slice(0, 300) }));
}

/**
 * Quiet while the media is switched (an adopted sheet, so no DOM mutation for the feedback clock): no transition
 * runs, so a theme switch never interpolates colours mid-census nor records motion the user did not cause.
 */
const QUIET = `(on) => {
  const d = document;
  if (on && !d.__argusTasteQuietSheet) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("*, *::before, *::after { transition: none !important; }");
    d.__argusTasteQuietSheet = sheet;
    d.adoptedStyleSheets = [...d.adoptedStyleSheets, sheet];
  } else if (!on && d.__argusTasteQuietSheet) {
    const sheet = d.__argusTasteQuietSheet;
    d.adoptedStyleSheets = d.adoptedStyleSheets.filter((x) => x !== sheet);
    d.__argusTasteQuietSheet = null;
  }
  d.__argusTasteQuiet = on;
}`;

/**
 * The census of `page` (a Playwright Page) → `{media, light, dark, reduce, themes}`. The page's own media is read
 * first (explicit values) and censused; then, quiet, the other colour scheme; then the media is put back as read,
 * never by null (null hands the choice to the OS: Task 0.1). `themes` is `single` when both schemes render the same
 * colours (the app does not answer prefers-color-scheme: dark parity is not judged, and the other census is dropped),
 * else `dual`. Self-contained: `String(censusOf)` runs in the lane's run-code and the suite as it runs here.
 */
export const censusOf = new Function(`return async (page) => {
  const SOURCE = ${JSON.stringify(TASTE_SOURCE)};
  const run = (arg) => page.evaluate("(" + SOURCE + ")(" + JSON.stringify(arg) + ")");
  const quiet = (on) => page.evaluate("(" + ${JSON.stringify(QUIET)} + ")(" + on + ")");
  const media = await page.evaluate('({ colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light", reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduce" : "no-preference" })');
  const other = media.colorScheme === "dark" ? "light" : "dark";
  const out = { media, light: null, dark: null, reduce: null, themes: null };
  out[media.colorScheme] = await run({});
  await quiet(true);
  try {
    await page.emulateMedia({ colorScheme: other, reducedMotion: media.reducedMotion });
    out[other] = await run({});
  } finally {
    await page.emulateMedia({ colorScheme: media.colorScheme, reducedMotion: media.reducedMotion });
    await quiet(false);
  }
  out.themes = JSON.stringify(out.light.palette) === JSON.stringify(out.dark.palette) ? "single" : "dual";
  if (out.themes === "single") out[other] = null;
  return out;
}`)();

/**
 * One screen rule of this module's families as a page expression → its rows on the current page (the `taste`
 * final's re-measure, argus-live-steps.mjs). `cfg` as rulesFor's. With no scale (neither `tokens` nor `frame`), an
 * off-scale rule lists every value it measured, so a replay re-measures a row by its key (`spacing:13px`).
 */
export function ruleExpression(rule, cfg = null) {
  const r = BAR.rules.find((x) => x.id === rule);
  if (!r || !OURS.includes(r.family)) throw new Error(`failed: ruleExpression: ${rule} is not a screen rule of the taste probe`);
  const c = { ...(cfg || {}) };
  if (!c.tokens && !c.frame && (rule === "scale.off-scale" || rule === "hierarchy.section-gaps")) c.tokens = { spacing: [], radius: [], type: [] };
  const bar = { rules: [r], frames: BAR.frames };
  return `(() => {
  const census = (${TASTE_SOURCE})({});
  const screen = { media: { colorScheme: census.media.dark ? "dark" : "light" }, light: null, dark: null };
  screen[screen.media.colorScheme] = census;
  return (${String(rulesFor)})(screen, ${JSON.stringify(bar)}, ${JSON.stringify(c)});
})()`;
}

// ---------------------------------------------------------------------------------------------------
// The suite's check (spec §20.4): support.ts embeds this source; the generator adds one soft line a step.

const SUITE_BAR = { version: BAR.version, rules: BAR.rules.filter((r) => OURS.includes(r.family)), frames: BAR.frames };
const SUITE_SOURCE = String.raw`const tasteCensus: (page: Page) => Promise<any> = ${String(censusOf)};
const tasteRules: (screen: any, bar: any, cfg: any) => { rule: string; key: string; measured: unknown; expected: unknown }[] = ${String(rulesFor)};
const TASTE_BAR: { version: number; rules: { id: string; info?: boolean }[]; frames: Record<string, unknown> } = ${JSON.stringify(SUITE_BAR)};
const TASTE_INIT_SCRIPT: string = ${JSON.stringify(TASTE_INIT)};
type TasteViolation = { check: string; step: number; key: string; detail: string };
const tasteArmed = new WeakSet<object>();
const tasteSaid = new WeakMap<object, Set<string>>();

/** .argus/taste.json as the suite reads it: the owner's gate, off and frame (a missing or unreadable file: every default). */
async function tasteConfig(): Promise<{ gate: string[]; off: string[]; frame: string | null }> {
  const fs = await import("node:fs");
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
  try {
    const t = JSON.parse(fs.readFileSync(path.join(REPO, ".argus", "taste.json"), "utf8"));
    return { gate: list(t.gate), off: list(t.off), frame: typeof t.frame === "string" ? t.frame : null };
  } catch (e) {
    return { gate: [], off: [], frame: null };
  }
}

/**
 * The taste checks after a step (spec 20.4), in the taste project: the screen censused in its own media and the
 * other colour scheme, each per-screen row annotated once a test — argus-taste ({rule, step, key, measured,
 * expected}), an information rule's argus-info, a rule the owner gates argus-violation (less the adopted
 * known/<id>.json rows) and returned, so the soft check fails. A count rule's peer row is the lane's to judge.
 */
export async function tasteStep(opened: BrowserContext[], i: number, step: number, id: string): Promise<TasteViolation[]> {
  const context = opened[i];
  const page = context ? context.pages()[0] ?? null : null;
  if (!page) return [];
  if (!tasteArmed.has(context)) {
    tasteArmed.add(context);
    if (TASTE_INIT_SCRIPT) {
      await context.addInitScript({ content: TASTE_INIT_SCRIPT });
      await page.evaluate(TASTE_INIT_SCRIPT);
    }
  }
  const cfg = await tasteConfig();
  const screen = await tasteCensus(page);
  const info = test.info();
  const said = tasteSaid.get(opened) ?? new Set<string>();
  tasteSaid.set(opened, said);
  const note = (type: string, description: string) => info.annotations.push({ type, description });
  if (screen.themes === "single" && !said.has("single theme")) {
    said.add("single theme");
    note("argus-info", "taste: single theme (the app does not answer prefers-color-scheme): dark parity not judged");
  }
  const fs = await import("node:fs");
  const file = path.join(__dirname, "known", id + ".json");
  const known = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  const out: TasteViolation[] = [];
  for (const r of tasteRules(screen, TASTE_BAR, cfg)) {
    if (r.expected === "peer" || said.has(r.rule + "|" + r.key)) continue;
    said.add(r.rule + "|" + r.key);
    const rule = TASTE_BAR.rules.find((x) => x.id === r.rule);
    if (rule && rule.info) note("argus-info", "taste " + r.rule + " " + JSON.stringify(r.key) + ": " + String(r.measured) + " (expected " + String(r.expected) + ")");
    else if (cfg.gate.includes(r.rule)) {
      if (Array.isArray(known) && known.some((k) => k && k.check === r.rule && k.key === r.key)) continue;
      const v = { check: r.rule, step, key: r.key, detail: String(r.measured) + " → expected " + String(r.expected) };
      note("argus-violation", JSON.stringify(v));
      out.push(v);
    } else note("argus-taste", JSON.stringify({ rule: r.rule, step, key: r.key, measured: r.measured, expected: r.expected }));
  }
  return out;
}
`;

const J = JSON.stringify;
/** The accounts a path acts as, in the order they first act: the order the test opens their contexts in. */
const accountsOf = (steps) => [...new Set(steps.filter((s) => s.as !== "system").map((s) => s.as))];

/**
 * The suite's taste checks, as argus-live-layout.mjs registers its own: `{name, project, when, source, emit}`. The
 * `taste` project (lane S adds it to the suite) runs `tasteStep` after each step of an account: advisory unless the
 * owner gates a rule in .argus/taste.json.
 */
export const CHECKS = [
  {
    name: "taste",
    project: "taste",
    when: "every step",
    source: SUITE_SOURCE,
    emit: (step, ctx) => (step.as === "system" ? [] : [`expect.soft(await (await import("./support")).tasteStep(opened, ${accountsOf(ctx.steps).indexOf(step.as)}, ${step.n}, ${J(ctx.id)}), ${J(`taste: step ${step.n}`)}).toEqual([]);`]),
  },
];
