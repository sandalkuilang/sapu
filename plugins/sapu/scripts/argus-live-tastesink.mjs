// argus-live-tastesink.mjs — the taste confirmation's sink (spec §20.4): the in-daemon code a confirmation replay runs
// around each step of the path in slot r, which measures the row's screen once the replay reached it (in the media the
// rule needs, through the routed fault or the AI drive), and hands the measurement back to argus-live-tastejudge.mjs
// tasteConfirm. Split from the judge, which decides with what this measures.
import { AIUX_DRIVE, driveArg, faultArm } from "./argus-live-aiux.mjs";
import { EASE_SOURCE, FAULT_SOURCE, RECOVERY_SOURCE, ruleExpression as easeExpression } from "./argus-live-ease.mjs";
import { routeTemplate } from "./argus-live-session.mjs";
import { censusOf, rulesFor as tasteRules, ruleExpression as tasteExpression } from "./argus-live-taste.mjs";
import { FAMILIES, loadBar } from "./argus-live-tastecfg.mjs";

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

/**
 * The replay's sink for row `row` (the session driver's, slot `r`, while confirming): `arm` (the routed fault of a
 * `states.error` row, the AI probe's marked fault of an `ai.error` row, else null); `wrap(text)` a step's code followed, at the first step after which the page is at
 * the row's route template and width, once the network settled, by the row's measurement — a MEDIA_RULES row through
 * the taste probe's censusOf and rulesFor (their sources, self-contained, with `bar`'s rule and frames and the owner's
 * frame), an AI row through the AI probe's drive (AIUX_DRIVE: it sends its own prompt on the surface and measures what
 * follows), any other through its probe's ruleExpression; `take(answer)` keeps that measurement (`measured`: `{rows}` of
 * the rule, at most 50, or `{rows: null}` when it failed) and removes it from the step's answer.
 */
export function confirmSink(rows, { routes, settleMs, bar = loadBar(), cfg = null, prohibited = [] }) {
  const group = Array.isArray(rows) ? rows : [rows];
  const row = group[0];
  const [route, width] = row.screen.split("|");
  const family = row.rule.split(".")[0];
  const frame = cfg ? { frame: cfg.frame ?? null, tokens: cfg.tokens ?? null } : {};
  const exprOf = (id) => (FAMILIES[id.split(".")[0]].probe === "ease" ? easeExpression : tasteExpression)(id, frame);
  const ids = [...new Set(group.map((r) => r.rule))];
  const mediaIds = ids.filter((id) => MEDIA_RULES.includes(id));
  const media = mediaIds.length > 0;
  const ai = family === "ai";
  // A group (rows of one screen): the media rules through one census, every other rule through its expression.
  const more = group.length > 1 ? { ids, exprs: ids.filter((id) => !MEDIA_RULES.includes(id) && (media || id !== row.rule)).map(exprOf) } : {};
  const S = { rule: row.rule, route, width: Number(width), routes, settleMs, media, ...(media ? { census: String(censusOf), rules: String(tasteRules), bar: { version: bar.version, rules: bar.rules.filter((r) => mediaIds.includes(r.id)), frames: bar.frames }, cfg: frame } : ai ? { drive: AIUX_DRIVE, driveArg: driveArg(row.rule, prohibited) } : row.rule === "states.recovery" ? { recover: RECOVERY_SOURCE, ease: EASE_SOURCE } : { expr: exprOf(row.rule) }), ...more };
  const sink = {
    measured: null,
    arm: row.rule === "states.error" ? faultCode(S) : row.rule === "ai.error" ? faultArm() : null,
    wrap: (text) =>
      sink.measured
        ? text
        : `async page => {
  const answer = await (${text.trimEnd()})(page);
  const S = ${JSON.stringify(S)};
  try {
    const vp = page.viewportSize();
    const width = vp && vp.width ? vp.width : await page.evaluate("innerWidth");
    if (width === S.width && (${routeTemplate.toString()})(new URL(page.url()).pathname, S.routes) === S.route) {
      await page.waitForLoadState("networkidle", { timeout: S.settleMs }).catch(() => {});
      let rows = null;
      try {
        // states.recovery: the ease probe's form case (RECOVERY_SOURCE) on the screen's first form with a submit.
        const recover = async () => {
          const SUBMIT = "button:not([type]), button[type=submit], input[type=submit]";
          const lost = await new Function("return " + S.recover)()(page, page.locator("form").filter({ has: page.locator(SUBMIT) }).first().locator(SUBMIT).first(), new Function("return " + S.ease)());
          return Array.isArray(lost) ? lost.map((x) => ({ rule: "states.recovery", key: x.key, measured: "lost" })) : null;
        };
        rows = S.media ? new Function("return " + S.rules)()(await new Function("return " + S.census)()(page), S.bar, S.cfg) : S.drive ? await new Function("return " + S.drive)()(page, S.driveArg) : S.recover ? await recover() : await page.evaluate(S.expr);
        for (const e of S.exprs || []) if (Array.isArray(rows)) rows = rows.concat(await page.evaluate(e));
      } catch (e) {
        rows = null;
      }
      const ours = (r) => r && (S.ids ? S.ids.includes(r.rule) : r.rule === S.rule);
      answer.__taste = { rows: Array.isArray(rows) ? rows.filter(ours).slice(0, S.ids ? 50 * S.ids.length : 50).map((r) => (S.ids ? { rule: r.rule, key: String(r.key).slice(0, 300), measured: r.measured } : { key: String(r.key).slice(0, 300), measured: r.measured })) : null };
    }
  } catch (e) {}
  return answer;
}
`,
    take: (answer) => {
      if (isObj(answer) && Object.hasOwn(answer, "__taste")) {
        if (!sink.measured) sink.measured = isObj(answer.__taste) ? answer.__taste : { rows: null };
        delete answer.__taste;
      }
      return answer;
    },
  };
  return sink;
}
