// argus-live-tastesink.mjs — the taste confirmation's sink (spec §20.4): the in-daemon code a confirmation replay runs
// around each step of the path in slot r, which measures the row's screen once the replay reached it (in the media the
// rule needs, through the routed fault or the AI drive), and hands the measurement back to argus-live-tastejudge.mjs
// tasteConfirm. Split from the judge, which decides with what this measures.
import { AIUX_DRIVE, driveArg, faultArm } from "./argus-live-aiux.mjs";
import { EASE_SOURCE, FAULT_SOURCE, RECOVERY_SOURCE, ruleExpression as easeExpression } from "./argus-live-ease.mjs";
import { routeTemplate } from "./argus-live-session.mjs";
import { censusOf, rulesFor as tasteRules, ruleExpression as tasteExpression } from "./argus-live-taste.mjs";
import { FAMILIES, loadBar, MEDIA_READ } from "./argus-live-tastecfg.mjs";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The in-daemon code the replay arms before its first navigation for a `states.error` row (decision 12, Task 0.1): the
 * ease probe's FAULT_SOURCE, held to the row's screen: the first same-origin JSON GET made while the page is at the
 * row's route template is answered 500; every other request goes on.
 */
function faultCode(S) {
  return `async page => {
  const S = ${JSON.stringify(S)};
  const routeOf = ${routeTemplate.toString()};
  const F = ${FAULT_SOURCE};
  await F(page, null, (q) => routeOf(new URL(q.frame().page().url()).pathname, S.routes) === S.route);
  return { armed: true };
}
`;
}

/**
 * The rules a page expression cannot re-measure (decision 6, decision 9): it cannot switch the media, so a `taste`
 * final would read them held. The confirmation measures them itself: the probe's census (censusOf: the page's own
 * scheme, the other one and reduced motion, the media restored as read, never null), then its rulesFor for the rule.
 */
export const MEDIA_RULES = Object.freeze(["colour.dark-contrast", "colour.dark-border", "colour.dark-surface", "motion.reduced"]);

/** The rules the replay measures first (the walk never can): dark parity and reduced motion, a refused form, a failed load. */
export const FIRST_RULES = Object.freeze([...MEDIA_RULES, "states.recovery", "states.error"]);

/**
 * The replay's sink for the rows `rows` of one screen (the session driver's, slot `r`, while confirming): `arm` (the
 * routed fault of a `states.error` row, the AI probe's marked fault of an `ai.error` row, else null); `wrap(text)` a
 * step's code followed, at the first step after which the page is at the rows' route template and width, once the
 * network settled, by their measurement — the MEDIA_RULES rows through the taste probe's censusOf and rulesFor (their
 * sources, self-contained, with `bar`'s rules and frames and the owner's frame), an AI row through the AI probe's drive
 * (AIUX_DRIVE: it sends its own prompt on the surface and measures what follows), a `states.recovery` row through the
 * form case, any other through its probe's ruleExpression; `take(answer)` keeps that measurement (`measured`: `{rows}`,
 * at most 50 a rule, or `{rows: null}` when it failed) and removes it from the step's answer.
 *
 * With `probe` `{at, screens, skip, target}` the replay also measures first what the walk never measures (FIRST_RULES):
 * at each step whose screen key (route template, width, the page's own scheme) is one of `screens` (the journey's
 * recorded screens) and not in `skip` (measured already), the census of both schemes and reduced motion and the media
 * rules' rows (`probes`: `[{key, themes, rows}]`, rows null when the census failed); and at the target screen `at` (the
 * rows' screen, or with no rows the probe's own), after the rows' measurement and only once, `target.recovery`'s form
 * case (each empty text field filled first; never a form whose submit `prohibited` names) and `target.error`'s routed
 * fault (armed, the page reloaded, the first same-origin JSON GET answered 500, its error state read; the route taken off
 * again) → `first` `{key, rows, ran: [what ran whole]}`. With no rows, reaching `at` is the measurement (`{rows: []}`).
 */
export function confirmSink(rows, { routes, settleMs, bar = loadBar(), cfg = null, prohibited = [], probe = null }) {
  const group = Array.isArray(rows) ? rows : [rows];
  const row = group[0] ?? null;
  const [route, width] = (row ? row.screen : probe.at).split("|");
  const family = row ? row.rule.split(".")[0] : null;
  const frame = cfg ? { frame: cfg.frame ?? null, tokens: cfg.tokens ?? null } : {};
  const exprOf = (id) => (FAMILIES[id.split(".")[0]].probe === "ease" ? easeExpression : tasteExpression)(id, frame);
  const ids = [...new Set(group.map((r) => r.rule))];
  const mediaIds = ids.filter((id) => MEDIA_RULES.includes(id));
  const media = mediaIds.length > 0;
  const ai = family === "ai";
  const off = new Set(cfg && Array.isArray(cfg.off) ? cfg.off : []);
  const firstMedia = probe ? MEDIA_RULES.filter((id) => !off.has(id)) : [];
  const needCensus = media || firstMedia.length > 0;
  // A group (rows of one screen): the media rules through one census, every other rule through its expression.
  const more = group.length > 1 ? { ids, exprs: ids.filter((id) => !MEDIA_RULES.includes(id) && (media || id !== row.rule)).map(exprOf) } : {};
  const mode = !row ? {} : media ? {} : ai ? { drive: AIUX_DRIVE, driveArg: driveArg(row.rule, prohibited) } : row.rule === "states.recovery" ? {} : { expr: exprOf(row.rule) };
  const target = probe && probe.target ? { recovery: Boolean(probe.target.recovery) && !off.has("states.recovery"), error: Boolean(probe.target.error) && !off.has("states.error") } : null;
  const P = probe ? { screens: probe.screens, media: MEDIA_READ, target, errorExpr: target && target.error ? easeExpression("states.error") : null, fault: target && target.error ? FAULT_SOURCE : null, prohibited: (Array.isArray(prohibited) ? prohibited : []).filter((x) => typeof x === "string" && x.trim() !== "").map((x) => x.toLowerCase()).slice(0, 50) } : null;
  const S = { rule: row ? row.rule : null, route, width: Number(width), routes, settleMs, media, ...(needCensus ? { census: String(censusOf), rules: String(tasteRules), bar: { version: bar.version, rules: bar.rules.filter((r) => mediaIds.includes(r.id) || firstMedia.includes(r.id)), frames: bar.frames }, cfg: frame, mediaIds, firstMedia } : {}), ...((row && row.rule === "states.recovery") || (target && target.recovery) ? { recover: RECOVERY_SOURCE, ease: EASE_SOURCE } : {}), ...mode, ...more, probe: P };
  if (row && row.rule === "states.recovery") S.recovering = true;
  const sink = {
    measured: null,
    probes: [],
    first: null,
    arm: row && row.rule === "states.error" ? faultCode(S) : row && row.rule === "ai.error" ? faultArm() : null,
    wrap: (text) =>
      sink.measured
        ? text
        : `async page => {
  const answer = await (${text.trimEnd()})(page);
  const S = ${JSON.stringify({ ...S, probe: S.probe ? { ...S.probe, skip: [...(probe.skip ?? []), ...sink.probes.map((x) => x.key)] } : null })};
  const fn = (src) => new Function("return " + src)();
  const routeOf = ${routeTemplate.toString()};
  try {
    const vp = page.viewportSize();
    const width = vp && vp.width ? vp.width : await page.evaluate("innerWidth");
    const at = width === S.width && routeOf(new URL(page.url()).pathname, S.routes) === S.route;
    const P = S.probe;
    const key = P ? routeOf(new URL(page.url()).pathname, S.routes) + "|" + width + "|" + (await page.evaluate(P.media)).colorScheme : null;
    const firstHere = Boolean(P) && P.screens.includes(key) && !P.skip.includes(key);
    if (at || firstHere) await page.waitForLoadState("networkidle", { timeout: S.settleMs }).catch(() => {});
    // The form case (RECOVERY_SOURCE) on the screen's first form with a submit: each field the refusal lost.
    const SUBMIT = "button:not([type]), button[type=submit], input[type=submit]";
    const recover = async () => {
      const submit = page.locator("form").filter({ has: page.locator(SUBMIT) }).first().locator(SUBMIT).first();
      if (P && P.prohibited.length && (await submit.count()) === 1) {
        const name = String(await submit.evaluate((b) => b.getAttribute("aria-label") || b.value || b.innerText || "")).replace(/\\s+/g, " ").trim().toLowerCase();
        if (name && P.prohibited.some((q) => q.includes(name) || name.includes(q))) return null;
      }
      const lost = await fn(S.recover)(page, submit, fn(S.ease), true);
      return Array.isArray(lost) ? lost.map((x) => ({ rule: "states.recovery", key: x.key, measured: "lost", expected: "the value typed before the rejected submit" })) : null;
    };
    let census = null;
    const censusNow = async () => census || (census = await fn(S.census)(page));
    if (at && S.rule) {
      let rows = null;
      try {
        rows = S.media ? fn(S.rules)(await censusNow(), S.bar, S.cfg).filter((r) => S.mediaIds.includes(r.rule)) : S.drive ? await fn(S.drive)(page, S.driveArg) : S.recovering ? await recover() : await page.evaluate(S.expr);
        for (const e of S.exprs || []) if (Array.isArray(rows)) rows = rows.concat(await page.evaluate(e));
      } catch (e) {
        rows = null;
      }
      const ours = (r) => r && (S.ids ? S.ids.includes(r.rule) : r.rule === S.rule);
      answer.__taste = { rows: Array.isArray(rows) ? rows.filter(ours).slice(0, S.ids ? 50 * S.ids.length : 50).map((r) => (S.ids ? { rule: r.rule, key: String(r.key).slice(0, 300), measured: r.measured } : { key: String(r.key).slice(0, 300), measured: r.measured })) : null };
    } else if (at) answer.__taste = { rows: [] };
    // First measurements: the other scheme and reduced motion at a recorded screen not measured yet.
    if (firstHere) {
      let rows = null, themes = null;
      try {
        const c = await censusNow();
        themes = c.themes;
        rows = fn(S.rules)(c, S.bar, S.cfg).filter((r) => r && S.firstMedia.includes(r.rule));
      } catch (e) {
        rows = null;
      }
      const cut = (r) => ({ rule: r.rule, key: String(r.key).slice(0, 300), measured: typeof r.measured === "number" ? r.measured : String(r.measured).slice(0, 200), expected: r.expected == null ? null : typeof r.expected === "number" ? r.expected : String(r.expected).slice(0, 200) });
      answer.__probe = { key, themes, rows: rows ? rows.slice(0, 50).map(cut) : null };
    }
    // And at the target, last (they act on the page): the refused form, then the failed load.
    if (at && P && P.target) {
      const rows = [], ran = [];
      if (P.target.recovery) {
        try {
          const lost = await recover();
          if (Array.isArray(lost)) rows.push(...lost);
          ran.push("states.recovery");
        } catch (e) {}
      }
      if (P.target.error && routeOf(new URL(page.url()).pathname, S.routes) === S.route) {
        try {
          const f = await fn(P.fault)(page, null, (q) => { try { return routeOf(new URL(q.frame().page().url()).pathname, S.routes) === S.route; } catch (e) { return false; } });
          try {
            await page.reload({ timeout: S.settleMs }).catch(() => {});
            for (const end = Date.now() + S.settleMs; f.faulted() === null && Date.now() < end; ) await page.waitForTimeout(100);
            if (f.faulted() !== null) {
              await page.waitForLoadState("networkidle", { timeout: S.settleMs }).catch(() => {});
              const found = await page.evaluate(P.errorExpr);
              if (Array.isArray(found)) rows.push(...found.filter((r) => r && r.rule === "states.error"));
            }
            ran.push("states.error");
          } finally {
            await f.off();
          }
        } catch (e) {}
      }
      answer.__first = { key: S.route + "|" + S.width + "|" + (await page.evaluate(P.media).catch(() => ({ colorScheme: "light" }))).colorScheme, ran, rows: rows.slice(0, 50).map((r) => ({ rule: r.rule, key: String(r.key).slice(0, 300), measured: String(r.measured).slice(0, 200), expected: r.expected == null ? null : String(r.expected).slice(0, 200) })) };
    }
  } catch (e) {}
  return answer;
}
`,
    take: (answer) => {
      if (isObj(answer) && Object.hasOwn(answer, "__probe")) {
        if (isObj(answer.__probe) && typeof answer.__probe.key === "string" && !sink.probes.some((x) => x.key === answer.__probe.key)) sink.probes.push({ key: answer.__probe.key, themes: answer.__probe.themes ?? null, rows: Array.isArray(answer.__probe.rows) ? answer.__probe.rows : null });
        delete answer.__probe;
      }
      if (isObj(answer) && Object.hasOwn(answer, "__first")) {
        if (!sink.first && isObj(answer.__first) && Array.isArray(answer.__first.rows)) sink.first = { key: String(answer.__first.key), ran: Array.isArray(answer.__first.ran) ? answer.__first.ran : [], rows: answer.__first.rows };
        delete answer.__first;
      }
      if (isObj(answer) && Object.hasOwn(answer, "__taste")) {
        if (!sink.measured) sink.measured = isObj(answer.__taste) ? answer.__taste : { rows: null };
        delete answer.__taste;
      }
      return answer;
    },
  };
  return sink;
}

/** A screen key's own-scheme twin: `route|width` with the scheme the walk recorded it in (`light` when none). */
const ownKey = (screen, records) => {
  const [route, width] = String(screen).split("|");
  const rec = records.find((s) => s.route === route && String(s.width) === width);
  return rec ? rec.key : `${route}|${width}|light`;
};

/**
 * What a replay of journey `journey` measures first (confirmSink's `probe`), or null when nothing is left: `records`
 * the journey's recorded screens, `at` the screen it replays to (a row's, which may be its dark twin, or a probe's),
 * `judge` the run's judge.json (its rows and `probed`: `{media: [screen key], states: ["<screen key> <rule>"]}`).
 * A screen is measured already when an earlier replay of the run measured it, or when its walk record holds the other
 * scheme's census (a record from before the walk stopped switching). The target's form case runs where the walk saw a
 * form with a submit, its routed fault where it saw a same-origin GET, each once a run and never for a rule the screen
 * already has a row of, nor one `cfg.off` turns off.
 */
export function probePlan({ journey, at, records, judge, cfg = null }) {
  const mine = records.filter((s) => s.journey === journey);
  const probed = isObj(judge && judge.probed) ? judge.probed : {};
  const off = new Set(cfg && Array.isArray(cfg.off) ? cfg.off : []);
  const screens = [...new Set(mine.map((s) => s.key))];
  const walked = mine.filter((s) => isObj(s.taste) && (s.taste.themes || s.taste.dark && s.taste.light)).map((s) => s.key);
  const skip = [...new Set([...(Array.isArray(probed.media) ? probed.media : []), ...walked])];
  const own = ownKey(at, mine);
  const recs = mine.filter((s) => s.key === own);
  const rows = (judge && Array.isArray(judge.rows) ? judge.rows : []).filter((r) => r.journey === journey && ownKey(r.screen, mine) === own);
  const open = (rule) => !off.has(rule) && !(Array.isArray(probed.states) && probed.states.includes(`${own} ${rule}`)) && !rows.some((r) => r.rule === rule);
  const form = recs.some((s) => isObj(s.ease) && Array.isArray(s.ease.forms) && s.ease.forms.some((f) => isObj(f) && f.submit === true));
  const get = recs.some((s) => isObj(s.ease) && Array.isArray(s.ease.requests) && s.ease.requests.some((r) => isObj(r) && r.same !== false && r.method === "GET"));
  const target = { recovery: form && open("states.recovery"), error: get && open("states.error") };
  const left = screens.filter((k) => !skip.includes(k));
  if (!left.length && !target.recovery && !target.error) return null;
  return { at: own, screens, skip, target: target.recovery || target.error ? target : null };
}

/**
 * The rows sink `sink` measured first in replay `ref` of journey `journey` → `{rows, probed}`: each a judge row without
 * its number (`probe: ref` says where it was first measured; it stands on that measurement, `witnesses` empty), a dark
 * rule's on the screen's dark key; never a rule `cfg.off` turns off, an information rule, nor a `bar` rule (a bar row
 * needs the corpus band and an internal witness); `probed` the screen keys and `<key> <rule>` pairs now measured.
 */
export function firstRows({ ref, journey, sink, bar = loadBar(), cfg = null }) {
  const rules = new Map(bar.rules.map((r) => [r.id, r]));
  const off = new Set(cfg && Array.isArray(cfg.off) ? cfg.off : []);
  const rows = [];
  const probed = { media: [], states: [] };
  const add = (screen, f) => {
    const rule = rules.get(f.rule);
    if (!rule || off.has(rule.id) || rule.info || rule.class === "bar" || !FIRST_RULES.includes(rule.id) || typeof f.key !== "string" || f.key === "") return;
    const key = f.key.replace(/[\r\n]+/g, " ").slice(0, 300);
    if (rows.some((r) => r.rule === rule.id && r.screen === screen && r.key === key)) return;
    rows.push({ journey, rule: rule.id, class: rule.class, screen, key, measured: f.measured ?? null, expected: f.expected ?? null, witnesses: [], cost: null, confirmed: null, probe: ref });
  };
  for (const p of sink.probes) {
    if (!Array.isArray(p.rows)) continue;
    probed.media.push(p.key);
    const [route, width] = p.key.split("|");
    for (const f of p.rows) add(String(f.rule).startsWith("colour.dark-") && p.themes === "dual" ? `${route}|${width}|dark` : p.key, f);
  }
  if (sink.first) {
    for (const rule of sink.first.ran) probed.states.push(`${sink.first.key} ${rule}`);
    for (const f of sink.first.rows) add(sink.first.key, f);
  }
  return { rows, probed };
}
