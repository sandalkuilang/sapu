# ARGUS aesthetics — the Curator lane

The visual lane for argus (SKILL.md in this skill's directory). Read §1–§3 whenever the charter touches a rendered surface; §4–§6 on a full sweep. The repo's UI rules, token source, themes, product halves, heavy content and last-verified marks: profile §Curator: … sections (the profile index says which file).

`kept:` (reference.md §10) — it supplies an oracle class nothing else in ARGUS does: without it, a defect that lives in the pixels rather than the response (a money figure that reads wrong, a destructive button styled as the safe one, four card paddings on one screen) has no admissible oracle and never files.

---

## §1 The law — taste is the sensor, measurement is the evidence

An eye for layout is what makes you *look at the right pixel*. It is never what you file.

> **Taste selects the target. A number files the finding.**

This is not a softening of §0, it is §0 applied to a surface where the temptation is worst. "The spacing feels off" is provenance `none` — and `none` can never carry `bug`. But "the four cards in this row have `padding: 16px / 20px / 16px / 24px`, and `20px` and `24px` are not in the token set" is a measured T1 observation of the product contradicting its own token set, and it files.

So the lane's whole job is **converting a perception into a measurement**. If you cannot, you have a taste item: it goes to the `[polish]` roll-up (§7), never to a `bug`.

**Rendered evidence tiers, and the second clause.** A screenshot is **not** T1 (SKILL.md §0). T1 on a rendered surface means a value you *computed from the live DOM*: `getComputedStyle`, `getBoundingClientRect`, a contrast ratio you calculated, a census you ran. Screenshots corroborate a measurement; they never replace one. But a number is not automatically evidence either: **a number is evidence only once the instrument has been tripwired on the surface you are measuring** — inject the case that must fail, show the detector fired, and only then trust its silence (why: an untripwired instrument produces confident, false measurements).

**RULE: no visual finding in `mode=static`.** You cannot measure a pixel from source. A grep for a class name is T3 and proves the class exists, never that it renders, wins the cascade, or is reachable. In static mode the Curator runs the §4 tell sweep only, files nothing above S4, and appends every measurement it wanted to `.argus/live-debt.json`.

---

## §2 What makes a pixel filable — the four routes

| Route | Provenance | The finding is | Files as |
|---|---|---|---|
| **Standard** | `specified` | a WCAG 2.2 SC fails, measured | `bug` + `ux` (Class B(b) if the repo has no rule of its own → `[no rule exists]` prefix, cap S2) |
| **Self-contradiction** | `derived` (differential) | two producers of the same visual decision disagree | `bug` + `ux`. **No rule citation needed** — reference.md §5.2 already establishes that a system contradicting itself is the bug |
| **Broken on its face** | `implicit` | clipped text, overlap, a horizontal scrollbar, an invisible focus ring, a control rendered offscreen, layout shift on hover | `bug` |
| **Taste** | `none` | you don't like it | **never `bug`** → §7 roll-up |

The second route is the one that unlocks this lane, and it is underused everywhere else. It needs no external authority and no internal invariant, because the contradiction *is* the evidence.

**The repo's own rules that are already UI rules** — cite these as `specified`, they are not new policy. The list lives in profile §Curator: UI rules (its design-system doc, the UI-component rules in CLAUDE.md and their gates, mutation-control gating, enum labels, money rendering, redaction). Two checks apply to every such list: a rendered surface that escapes a rule — gated or not — is a finding against it, and *"the gate passes"* is not evidence the UI is right (reference.md §4.3). A redaction rule covers the DOM too: check `document.documentElement.innerHTML`, not just the wire — a field filtered from the response and re-derived client-side lands in the markup anyway.

**External authorities:** WCAG 2.2 SC IDs with their verified levels are in standards.md § Accessibility. Fetch the SC's own page and quote it before it enters an issue — the same rot rule as a `path:line`. **Never quote an SC's level from a summarized fetch** (why: summaries misstate levels — SC 2.5.8, for one, is Level AA, new in 2.2).

---

## §3 The instrument — the census

Perfectionism is not a mood here, it is an enumeration. Open the route, run these through the session's browser-automation tool (a JS-evaluate call), paste the output into the journal. Both return JSON; both are T1.

**Settle first.** Wait out any theme or entrance transition and confirm with a screenshot before censusing; a census read mid-transition returns interpolated colours and manufactures contrast failures that vanish once the transition settles.

### §3.1 Token census — what values does this screen actually use?

```js
(() => {
  const seen = {};
  const bump = (k, v, el) => {
    (seen[k] ??= {}); (seen[k][v] ??= { n: 0, eg: [] });
    seen[k][v].n++;
    if (seen[k][v].eg.length < 3) seen[k][v].eg.push(
      el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''));
  };
  const real = v => v && v !== '0px' && v !== 'none' && v !== 'normal';
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;               // skip what does not render
    const s = getComputedStyle(el);
    if (!el.children.length && el.textContent.trim()) {
      bump('type', `${s.fontSize}/${s.lineHeight} w${s.fontWeight}`, el);
      bump('ink', s.color, el);
    }
    if (real(s.borderRadius)) bump('radius', s.borderRadius, el);
    if (real(s.boxShadow))    bump('elevation', s.boxShadow.slice(0, 48), el);
    if (real(s.gap))          bump('gap', s.gap, el);
    if (real(s.paddingTop))   bump('padY', s.paddingTop, el);
  }
  return Object.fromEntries(Object.entries(seen).map(([k, vs]) => [k, {
    distinct: Object.keys(vs).length,
    values: Object.entries(vs).sort((a, b) => b[1].n - a[1].n)
      .map(([v, d]) => `${v} ×${d.n} (${d.eg[0]})`)
  }]));
})()
```

**A distinct count is not a finding.** "14 type styles" is a number with no oracle behind it. It becomes one only against a comparison, and there are exactly three (the repo's commands and selectors: profile §Curator: instruments):

1. **Against the token set** — print it with the command the profile gives. A value on screen that is not derivable from a token is off-system. Enumerate them with their selectors; that list is the issue body.
2. **Route against route** — run the census on two routes rendering the *same component* (a list table, a detail card). Divergence is a differential finding: one component, two producers, disagreeing.
3. **Light against dark** — wherever the app themes, run the census under both. (A surface that is single-theme by design is exempt from this comparison — the profile names any; such a surface that *does* change under dark is itself the finding.) A token that collapses in one theme (a border that goes invisible, ink that drops below 4.5:1) is a real defect in half the product, and it is the half nobody screenshots.

### §3.2 Geometry & contrast probe — the implicit oracles

**Never parse a colour string yourself.** `getComputedStyle` returns whatever colour space the app authored in — often `oklch()` and `oklab()` — and a `match(/[\d.]+/g)` parser reads `oklch(0.145 0 0)` as `rgb(0.145,0,0)` and scores **every element on the page at 1.00:1**. That failure is silent and fails *open*: it manufactures a wall of plausible findings. Resolve through a 1×1 canvas instead — the browser does the conversion, in any colour space, forever.

```js
(() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const cache = new Map();
  const toRGB = css => { if (cache.has(css)) return cache.get(css);
    ctx.clearRect(0,0,1,1); ctx.fillStyle = 'black'; ctx.fillStyle = css; ctx.fillRect(0,0,1,1);
    const d = ctx.getImageData(0,0,1,1).data;
    const v = { r:d[0], g:d[1], b:d[2], a:d[3]/255 }; cache.set(css, v); return v; };
  const lum = ({r,g,b}) => { const f = v => (v /= 255) <= 0.04045 ? v/12.92 : ((v+0.055)/1.055)**2.4;
    return 0.2126*f(r) + 0.7152*f(g) + 0.0722*f(b); };
  // walks ancestors AND composites semi-transparent layers — no contrastUNKNOWN bucket needed
  const bgOf = el => { const st = [];
    for (let n = el; n; n = n.parentElement) {
      const c = toRGB(getComputedStyle(n).backgroundColor);
      if (c.a === 0) continue; st.push(c); if (c.a === 1) break; }
    if (!st.length) return toRGB('white');
    let o = st[st.length-1];
    for (let i = st.length-2; i >= 0; i--) { const t = st[i], a = t.a;
      o = { r:t.r*a+o.r*(1-a), g:t.g*a+o.g*(1-a), b:t.b*a+o.b*(1-a), a:1 }; }
    return o; };
  const out = { docOverflowsX: document.documentElement.scrollWidth > innerWidth,
    smallTargets: [], lowContrast: [], clipped: [], offscreen: [] };
  for (const el of document.querySelectorAll('a,button,[role="button"],input,select,textarea,[tabindex]')) {
    const r = el.getBoundingClientRect();
    if (r.width && r.height && (r.width < 24 || r.height < 24))
      out.smallTargets.push(`${Math.round(r.width)}×${Math.round(r.height)} ${el.tagName}[${
        (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24)}]`);
  }
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length || !el.textContent.trim()) continue;
    const s = getComputedStyle(el), size = parseFloat(s.fontSize);
    if (s.visibility === 'hidden' || parseFloat(s.opacity) === 0) continue;
    if (!el.getBoundingClientRect().width) continue;
    const large = size >= 24 || (size >= 18.66 && parseInt(s.fontWeight) >= 700);
    const txt = el.textContent.trim().slice(0, 30);
    const bg = bgOf(el), f0 = toRGB(s.color);
    const fg = f0.a < 1                       // composite translucent ink over its own bg
      ? { r:f0.r*f0.a+bg.r*(1-f0.a), g:f0.g*f0.a+bg.g*(1-f0.a), b:f0.b*f0.a+bg.b*(1-f0.a) } : f0;
    const a = lum(fg), b = lum(bg);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio < (large ? 3 : 4.5))
      out.lowContrast.push(`${ratio.toFixed(2)}:1 "${txt}" rgb(${fg.r|0},${fg.g|0},${fg.b|0}) on rgb(${bg.r|0},${bg.g|0},${bg.b|0}) @${size}px w${s.fontWeight}`);
    const p = el.parentElement, pr = p.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (r.right > pr.right + 1 && getComputedStyle(p).overflowX === 'visible') out.clipped.push(txt);
  }
  // Viewport-escape oracle: a *floating* panel (position absolute/fixed) whose
  // visible rect leaves the viewport is "a control rendered offscreen" (§2).
  // clipped above is parent-relative and a panel escapes its parent by design,
  // so it never fires for this. The position filter is load-bearing — a tall
  // in-flow table below the fold is page scroll, not a bug. A closed overlay is
  // inert/height:0 and drops out here, so this reads [] until §3.3 opens them.
  for (const el of document.querySelectorAll(
    '[role="listbox"],[role="menu"],[role="dialog"],[role="tooltip"],[popover]')) {
    const s = getComputedStyle(el);
    if (s.position !== 'absolute' && s.position !== 'fixed') continue;
    if (el.hasAttribute('inert') || el.getAttribute('aria-hidden') === 'true') continue;
    if (s.visibility === 'hidden' || parseFloat(s.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const esc = [];
    if (r.bottom > innerHeight + 1) esc.push(`bottom +${Math.round(r.bottom - innerHeight)}px`);
    if (r.top < -1) esc.push(`top ${Math.round(r.top)}px`);
    if (r.right > innerWidth + 1) esc.push(`right +${Math.round(r.right - innerWidth)}px`);
    if (r.left < -1) esc.push(`left ${Math.round(r.left)}px`);
    if (esc.length) out.offscreen.push(`${el.getAttribute('role') || 'popover'} h=${
      Math.round(r.height)} escapes [${esc.join(', ')}] vp=${innerWidth}×${innerHeight}`);
  }
  return out;
})()
```

**Its limits are part of its output — report them, never let them read as a pass.** It composites alpha on both ink and surface. One limit remains and has no bucket: **text over an image, gradient or video** resolves to the nearest opaque *colour* layer and will report optimistically. Eyeball those by hand and say you did. Any empty bucket reported without a tripwire is a control that asserted nothing (SKILL.md §4). `offscreen` sees only *open* `position:absolute|fixed` overlays, so `offscreen: []` on the resting page is a probe that hasn't run yet — it becomes an assertion only after §3.3 has driven each overlay open.

`last-verified:` per repo — profile §Curator: instruments (each instrument's tripwire, on that repo's tokens).

### §3.3 The probes a script alone cannot run — they drive state first, then measure

- **Reflow (SC 1.4.10, AA)** — resize the viewport to 320px wide, reload, re-run §3.2. `docOverflowsX: true` is the finding.
- **Text spacing (SC 1.4.12, AA)** — inject `* { line-height:1.5 !important; letter-spacing:.12em !important; word-spacing:.16em !important }`, then re-run §3.2 and look for new `clipped` entries. Nothing may be lost or cut off.
- **Focus (SC 2.4.7 AA, 2.4.11 AA)** — Tab the whole page. Every stop shows a ring you can see against its background at ≥3:1 (SC 1.4.11), and no stop lands behind the sticky header or an open drawer. Screenshot the two worst stops.
- **Hover stability** — `getBoundingClientRect` before and after `hover`. A changed rect on a non-absolutely-positioned element is measured layout shift, not a nice effect.
- **Worst-case content (the defect the seed data hides)** — the census on seed data is a census of *one* content state, and the layout defects live in the states seed magnitude never reaches. Before crediting a surface, drive it to its heaviest realistic content and re-run §3.2 **and §3.4**: the largest real money figure (money is never abbreviated), the longest locale's strings, the longest counterparty name, a populated feed/list, a `0`-length list (the repo's real values: profile §Curator: instruments). A figure that wraps with its currency symbol orphaned, a KPI label that truncates to lose its object, or a card that grows a dead band only at the real height, is a real defect — and its `Viewport:` line owes the **content state** alongside width × theme × locale, because the reproduction is worthless without it.
- **Overlays that open (the defect the resting DOM hides)** — a floating panel escapes its parent by design, so §3.2's `clipped` (parent-relative) is blind to it leaving the *viewport*, and the resting-page census never opened it to look. Click every overlay trigger — `[aria-haspopup]` selects / comboboxes / menus, `role="menu"`/`dialog`/`tooltip`, date & time pickers — **at worst-case option count**, not seed: drive the select to real magnitude (the repo's heaviest selects: profile §Curator: instruments). Then re-run §3.2 and read `offscreen`. A panel that leaves the viewport instead of capping to the available room and scrolling internally is the finding, and its `Viewport:` line owes width × height (a panel fits a tall window and runs off a short one). (why: an open panel can run far past the screen bottom while every closed-DOM oracle reads clean.)

### §3.4 Intra-card dead space — the void the clip probe cannot see

§3.2's `clipped` catches content spilling **past** its container. The opposite defect — a bordered card measurably **taller than the content inside it**, so its own border encloses a dead band — has no oracle, and it is the single most common "why is there so much empty space" complaint on a dense ops tool. It is a computed number (T1), so it files.

The instrument reports the largest vertical gap inside each card as a **lead, not a verdict** (§1: taste selects, the number files). A gap in a `justify-content: space-between|around|evenly` column is author-intended rhythm and is tagged `[distributed]` so it triages in a glance; an equally large gap in a `justify-start`/`justify-end`/`center` column or a block card is the suspicious kind — a figure pinned to the bottom of an over-tall row (the `justify-end` shape, which leaves a dead band above a hero figure), or a card stretched by a taller grid sibling with no `h-full` to fill it (a dead band under the card's chart). (Tailwind spellings shown; translate to the repo's styling system.)

```js
(() => {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    if (r.height < 160 || r.width < 120) continue;                       // card-sized only
    const bordered = parseFloat(s.borderTopWidth) > 0 || s.boxShadow !== 'none';
    if (!bordered || parseFloat(s.borderTopLeftRadius) < 6) continue;    // looks like a card
    const kids = [...el.children].map(k => k.getBoundingClientRect())
      .filter(k => k.width && k.height).sort((a, b) => a.top - b.top);
    if (!kids.length) continue;
    const top = r.top + parseFloat(s.borderTopWidth) + parseFloat(s.paddingTop);
    const bot = r.bottom - parseFloat(s.borderBottomWidth) - parseFloat(s.paddingBottom);
    let maxGap = 0, where = 'top', cur = top;
    for (let i = 0; i < kids.length; i++) {
      const g = kids[i].top - cur;
      if (g > maxGap) { maxGap = g; where = i === 0 ? 'above first child' : 'between children'; }
      cur = Math.max(cur, kids[i].bottom);
    }
    if (bot - cur > maxGap) { maxGap = bot - cur; where = 'below last child'; }
    const distributed = /space-(between|around|evenly)/.test(s.justifyContent);
    if (maxGap >= 64)
      out.push(`${Math.round(maxGap)}px ${where}${distributed ? ' [distributed]' : ''} — ` +
        `${Math.round(r.width)}×${Math.round(r.height)} card, content fills ${Math.round((r.height - maxGap) / r.height * 100)}%`);
  }
  return out;
})()
```

An untagged entry ≥ 64px is a lead to judge, never an auto-find: a hero card that deliberately breathes is coherent, a KPI tile with 90px of nothing under a one-line number is not — and the difference is taste, filed with the measured gap and the `content fills N%` it printed. Run it at every viewport §3.3 uses **and** at the worst-case content state above; a card fills at seed magnitude and gaps open at the real one, or the reverse. Report `[]` only after a tripwire: mount any card with a forced `min-height: 600px` and confirm the probe lists it, exactly as §3.2 owes a tripwire before its silence is trusted.

---

## §4 Slop — a definition that can be wrong

Vibes cannot be tested, so define it so it can fail:

> **Slop is design that carries no information about this product.**
>
> **The substitution test:** swap the product noun. If this screen would be equally correct for a CRM, a crypto dashboard, or a recipe app, then nothing on it was decided by this product — it was decided by a template. State the verdict per screen: *substitutable / partly / no*.

That is a judgement, so by §1 it never files alone. Its use is to aim §3: a screen that substitutes freely is where the census finds off-token values, and a screen that could only be this product is where you stop looking.

**The tell sweep — cheap, and expected to return mostly zero on a codebase that already declines the obvious ones** (the repo's last re-measured baseline: profile §Curator: slop). **A tell list that always returns zero is itself slop** — generic, carrying no information about this product. So run it as a two-minute grep, expect nothing, and treat a hit as a lead to measure, never as a finding:

emoji used as an icon · a second icon set appearing beside the repo's one · gradient text on a heading · `text-*-400` as body ink · `min-h-screen items-center justify-center` on a data route · a full-page spinner where a skeleton component exists · placeholder residue (`Lorem`, `John Doe`, stock avatars) · `shadow-lg rounded-2xl border` applied uniformly so elevation encodes nothing · a marketing hero's vertical rhythm on an ops table. (Tailwind spellings shown; translate to the repo's styling system.)

**Where the real yield is.** Not the tells — the census, and these product-shaped questions:

- **Loading treatment coherence.** How many route files reference a skeleton is not itself a defect (many are layouts and index routes). The question to *measure* is whether two routes of the same kind (two list views, two detail views) load differently, which is a §3 differential.
- **Semantic colour.** The token set defines semantic colours (success, warning, error — the repo's names: profile §Curator: slop). Assert one enum value maps to one colour everywhere it renders. Two different badge colours for the same status on two screens is a differential finding and a SC 3.2.4 failure at once.
- **Field/column order of the same entity across sibling views.** When one entity is presented as a row or key-value block on two surfaces — a master grid and its expandable detail grid, a list column set and the entity's detail card, the same object in two tables — the columns/fields must appear in the **same order**. Same object, two producers, opposite order, so the eye re-learns the layout mid-page (the repo's instances: profile §Curator: slop). A **self-contradiction** finding (§2, `derived`): `bug` + `ux`, no external rule needed. Measure it: read the ordered header cells (`[...table.querySelectorAll('thead th')].map(th => th.textContent.trim())`) on both surfaces and diff the shared labels' index; a shared field at a different position is the finding. **Capped S3** (a scan cost, not a wrong number) unless the reordered field is money or a status badge — then §7 S1/S2. Same rule for a detail card whose field order contradicts the list it was opened from. It only surfaces by reading the pair — the content-order sibling of §3.1's route-against-route census.

---

## §5 Layout quality — what a perfectionist sees, and how it becomes a number

Each line is a perception on the left and its measurement on the right. Without the right half, it is a §7 polish item.

| The perception | The measurement that files it |
|---|---|
| "the edges don't line up" | distinct `getBoundingClientRect().left` values among siblings in one container. Off by ≥4px reads as intent; **1–3px reads as broken** — that band is the finding |
| "the rhythm is lumpy" | vertical gaps between sibling sections: how many distinct values, and are they on the spacing scale |
| "everything is the same weight" | §3.1 `type.distinct` vs how many levels of hierarchy the screen actually has. One heading style for three nesting levels is unresolvable structure, not minimalism |
| "the card is floating for no reason" | count distinct `elevation` values against the number of *layers* (page → card → popover → modal). More shadows than layers means elevation encodes nothing |
| "it's cramped / it's empty" | padding on the densest element vs the sparsest, on one screen. On a dense ops tool the failure is usually marketing-scale whitespace on a table, not crowding (which surfaces are ops: profile §Curator: product) |
| "the line is too long to read" | `getBoundingClientRect().width / parseFloat(fontSize)` ≈ characters per line. Prose past ~90ch is measurable |
| "the primary action isn't obvious" | count elements carrying primary styling in one view. More than one primary per view, or a destructive action carrying it, is structural — and if the destructive one is the visual default, jump to §6 |
| "the table is hard to scan" | column alignment by type: money right-aligned and tabular-figured, text left. A right-aligned label or a left-aligned money column is a defect you can point at |

**Never credit a visual control on one screen** (SKILL.md §4): before crediting a token, a badge mapping, or a focus ring as holding, render the case that must break it — §3.3's worst-case content, plus a 500-row table — and show the observable held.

---

## §6 Product fit, and the design-system reference frame

**One codebase can carry products that want opposite things** (which surfaces are which: profile §Curator: product).

- **Internal ops surfaces** are read all day by people who already know the domain. Their quality criterion is Capability and Reliability: density, scannability, keyboard reach, no motion between me and the number. Charisma spent here is a cost.
- **An external-facing portal** is the **Image** surface in FEW HICCUPPS terms — an external business counterparty's whole impression of the company. Charisma is a real criterion here, and it is the one place a bare, unresolved screen is a business finding rather than a taste note.

Filing against the wrong half is the most likely way this lane goes wrong: **an ops screen is not underdesigned for being plain, and a portal screen is not overdesigned for being finished.** State which half you are on in the charter.

**The reference frame (optional).** If the repo names a design-reference tool (profile §Curator: product gives the tool and its exact command), generate an outside frame with it before a full sweep — output to `.argus/tmp/design-frame.md` — and diff against it rather than against your own preferences; without one, skip this step with one journal line.

**Its output is a recommender, not a standard — provenance `derived` at absolute best, and usually `none`.** Disagreeing with it is not a defect and never files: the repo's own design system (profile §Curator: product) is a deliberate owner choice, and a generated palette suggestion has no authority over it. Two things it *is* good for:

1. **Naming what you are looking at.** It supplies vocabulary (hierarchy, density, elevation, pairing) that turns "off" into a measurable property.
2. **The anti-pattern list**, which usually overlaps §4's tells — useful as sweep input, still subject to §4's rule that a hit is a lead, not a finding.

One calibration to carry: design tools and guides often give 44×44 for touch targets. That is the Apple HIG / WCAG **2.5.5 Target Size (Enhanced), Level AAA** number. The bar actually measured against is **2.5.8 Target Size (Minimum), Level AA — 24×24 CSS pixels** (verified verbatim, standards.md). File against 24; mention 44 as the enhanced bar, never as the requirement.

---

## §7 Severity — when a pixel is not cosmetic

The default assumption that visual defects are S4 is what kept them unfiled. Rate by **what the user does because of what they saw**, not by how it looks.

| Sev | The pixel changed an action or blocked one |
|---|---|
| **S1/S2** | It changes a money or stock decision: a money figure that renders truncated, rounded, or differently on two screens (the repo's lossless-money rule) · a status badge contradicting the enum behind it · a destructive or irreversible action carrying the primary/default styling, or sitting where the safe one sits on the sibling screen · a control that looks disabled but fires (or looks live and is inert) on a money/stock flow · a form that blocks submit with **no visible message** on a money/stock flow — no path forward (reference.md §4.2) |
| **S3** | A core flow is completable but badly degraded, or a WCAG A/AA SC fails on a core flow: unreachable by keyboard, focus invisible or obscured, body ink under 4.5:1, content lost at 320px, a target under 24×24 that has no larger equivalent |
| **S4** | Coherence without an action consequence: off-token values, rhythm breaks, elevation that encodes nothing, 1–3px misalignment, an inconsistent empty state |

SKILL.md §5 applies unchanged — above S3 still owes **`Max <currency> per occurrence:` with arithmetic** (for a visual money defect: the misread figure × how often the screen is trusted), else cap S3.

**The `[polish]` roll-up — one issue per cycle, and it is not the cycle's find.** Taste-level items are real and would otherwise evaporate into a journal nobody re-reads. File them as **one** issue, `[polish] cycle <id> — N coherence items`, `severity:s4`, `priority:p3`, `ux`, each line carrying *current value → expected value → the selector*. Rules: every line is measured (a line with no number does not go in); it never carries `bug` for a taste item; and per SKILL.md §8 it **does not count as the cycle's finding** — a cycle whose only output is a polish roll-up still writes `## Nothing filed because …`.

---

## §8 What the Curator owes

Added to SKILL.md §4's council, the 🎨 Curator owes an output, not an opinion:

1. The **census output** for the target route, plus which of the three comparisons (§3.1) it was read against — a census with no comparison is not evidence.
2. The **substitution-test verdict** per screen, and which half of §6 the screen belongs to.
3. **One measured divergence**, or an explicit statement that the screen is coherent *and the comparison that establishes it* — never "looks fine".
4. Its **disposition of §3.2's blind spot** — text over an image, gradient or video: each instance checked by hand, or carried forward as debt.
5. Which §3.3 probes were run, and which were not.

Filing follows reference.md §7's template unchanged, with three additions: **`Viewport:`** (width × theme × locale — a defect that only exists at 320px dark in the second locale is still a defect, but the reproduction is worthless without them), **`Measured:`** the before/after numbers, and a screenshot attached *after* the numbers, never instead of them.

**Rails.** SKILL.md §7 — you measure, you never fix: no CSS or token edits, no "while I was in there".
