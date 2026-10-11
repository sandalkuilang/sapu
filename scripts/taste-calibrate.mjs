#!/usr/bin/env node
// scripts/taste-calibrate.mjs — the maintainer's taste calibration (spec §20.3, plan decision 16). It runs the taste
// pass's own probes (argus-live-taste.mjs's census and argus-live-ease.mjs's page-only measurements: no action, no
// fault) on the public pages of the reference corpus (scripts/taste-corpus.json) and writes the per-archetype bands
// into the bar's `archetypes`: per archetype and metric `{n, sites, p10, p50, p90, urls}`, numbers and URLs only.
//
// It lives in sapu's repository, never in the plugin, so no consumer installs it; the guard refuses it to every
// subagent. Without `--network` it only validates the corpus and prints the plan. With it, on a maintainer's machine:
// robots.txt honoured for `*` and for the script's own agent (both must allow a page), one request at a time, at most
// one page per site every 10 s, no login, no form, no stored screenshot, text, asset or CSS. Its output reaches the
// plugin only through a reviewed pull request (decision 21's procedure).
//
//   node scripts/taste-calibrate.mjs [--network] --corpus <file> --out <bar> [--diff]
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ensureCli, findChrome } from "../plugins/sapu/scripts/argus-live-browser.mjs";
import { EASE_INIT, EASE_SOURCE, easeOf } from "../plugins/sapu/scripts/argus-live-ease.mjs";
import { TASTE_INIT, TASTE_SOURCE, censusOf } from "../plugins/sapu/scripts/argus-live-taste.mjs";
import { ARCHETYPES, FAMILIES, TASTE_BUFFER, WIDTH_BUCKETS, loadBar, validateBar, widthBucket } from "../plugins/sapu/scripts/argus-live-tastecfg.mjs";

/** The product token robots.txt names this script by; it rides at the end of the browser's own user agent. */
export const AGENT = "sapu-taste-calibration";
/** The pause between two requests to one site, from the end of one to the start of the next. */
export const PACE_MS = 10_000;
/** Decision 16: an archetype's band is a witness only with this many sites and pages (the judge applies it; shown here). */
export const WITNESS = Object.freeze({ sites: 5, pages: 15 });
/** The viewport every corpus page is measured at (one width: the bands compare screens, not breakpoints). */
export const VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const usage = "usage: taste-calibrate.mjs [--network] --corpus <file> --out <bar> [--diff]\n       taste-calibrate.mjs --local <manifest> --refresh\n       taste-calibrate.mjs --local <manifest> [--network] --out <bar> [--diff]";
export const refused = (why) => `refused: taste-calibrate: ${why}`;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const METRIC = /^[a-z][a-z0-9_]{0,63}$/;
/** A calibration month, as the bar records it per archetype: `YYYY-MM`, never a day. */
const MONTH = /^20[0-9]{2}-(0[1-9]|1[0-2])$/;
/** The month (UTC) of time `ms` → `YYYY-MM`. */
export const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A corpus or band URL: https (http only where a test hands calibrate loopback pages), no credentials, no fragment. */
const urlOk = (v, protocols = ["https:"]) => {
  if (typeof v !== "string" || v.length > 500 || /\s/.test(v)) return false;
  try {
    const u = new URL(v);
    return protocols.includes(u.protocol) && !u.username && !u.password && !u.hash && !v.includes("#");
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------------------------------
// The corpus.

const CORPUS_KEYS = ["coverage", "sites", "pages", "skipped"];
const PAGE_KEYS = ["url", "site", "archetype", "source", "terms_reviewed_by"];
const SKIP_KEYS = ["url", "site", "archetype", "reason"];
const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
/** A site's terms confirmation names the bar version it was confirmed for, never a date. */
const CONFIRMED_ON = /^taste-bar [1-9][0-9]{0,3}$/;
/** The corpus's sites whose terms no maintainer confirmed (`sites.<s>.confirmed`), among those its pages name: a `--network` run refuses them. */
export const unconfirmedSites = (corpus) => [...new Set(corpus.pages.map((p) => p.site))].filter((s) => !isObj(corpus.sites[s]?.confirmed)).sort();

/**
 * The corpus checked → `{value, errors}`: `{coverage, sites: {<site>: {terms, note, confirmed?}}, pages: [{url, site,
 * archetype, source, terms_reviewed_by}], skipped: [{url, site, archetype, reason}]}`, unknown keys refused. `terms` is
 * the https page of the site's terms the reviewer read; `confirmed` `{by, on}` the maintainer who confirmed that reading
 * (`on` the bar version it was confirmed for, `taste-bar <n>`, never a date): a `--network` run measures no site
 * without it. `source` the research id or https page that admits the site; `skipped` records the pages a review left
 * out (robots.txt, a login) so they are not proposed again unread.
 */
export function validateCorpus(raw) {
  if (!isObj(raw)) return { value: null, errors: ["the corpus must be a JSON object"] };
  const errs = [];
  const need = (cond, msg) => cond || errs.push(msg);
  for (const k of Object.keys(raw)) if (!CORPUS_KEYS.includes(k)) errs.push(`unknown key "${KEBAB.test(k) ? k : "(not shown)"}"`);
  need(text(raw.coverage, 2000), "coverage must be the research's coverage statement");
  const sites = isObj(raw.sites) ? raw.sites : {};
  if (need(isObj(raw.sites) && Object.keys(raw.sites).length > 0, "sites must describe every site: {terms, note}") === true) {
    for (const [s, d] of Object.entries(raw.sites)) {
      const at = `sites.${KEBAB.test(s) ? s : "(not shown)"}`;
      need(KEBAB.test(s) && isObj(d) && Object.keys(d).every((k) => ["terms", "note", "confirmed"].includes(k)), `${at} must be {terms, note, confirmed?} under a kebab-case name`);
      if (isObj(d) && "confirmed" in d) need(isObj(d.confirmed) && Object.keys(d.confirmed).length === 2 && text(d.confirmed.by, 80) && typeof d.confirmed.on === "string" && CONFIRMED_ON.test(d.confirmed.on), `${at}.confirmed must be {by: the maintainer, on: "taste-bar <n>"}`);
      need(isObj(d) && urlOk(d.terms), `${at}.terms must be the https page of the terms reviewed`);
      need(isObj(d) && text(d.note, 300), `${at}.note must say what the review found`);
    }
  }
  const seen = new Set();
  const entry = (p, at, keys, extra) => {
    if (need(isObj(p), `${at} must be an object`) !== true) return;
    for (const k of Object.keys(p)) if (!keys.includes(k)) errs.push(`${at}: unknown key "${KEBAB.test(k) ? k : "(not shown)"}"`);
    if (need(urlOk(p.url), `${at}.url must be a public https URL with no credentials or fragment`) === true) {
      need(!seen.has(p.url), `${at}.url is listed twice`);
      seen.add(p.url);
    }
    need(typeof p.site === "string" && Object.hasOwn(sites, p.site), `${at}.site must be one of sites`);
    need(ARCHETYPES.includes(p.archetype), `${at}.archetype must be one of ${ARCHETYPES.join(", ")}`);
    extra(p);
  };
  if (need(Array.isArray(raw.pages) && raw.pages.length > 0, "pages must be a non-empty array") === true) {
    raw.pages.forEach((p, i) =>
      entry(p, `pages[${i}]`, PAGE_KEYS, (x) => {
        need((typeof x.source === "string" && KEBAB.test(x.source)) || urlOk(x.source), `pages[${i}].source must be a research id or the https page that admits the site`);
        need(text(x.terms_reviewed_by, 80), `pages[${i}].terms_reviewed_by must name who reviewed the site's terms`);
      }),
    );
  }
  if (need(Array.isArray(raw.skipped), "skipped must be an array") === true) {
    raw.skipped.forEach((p, i) => entry(p, `skipped[${i}]`, SKIP_KEYS, (x) => need(text(x.reason, 200), `skipped[${i}].reason must say why the page is left out`)));
  }
  return errs.length ? { value: null, errors: errs } : { value: structuredClone(raw), errors: [] };
}

// ---------------------------------------------------------------------------------------------------
// robots.txt (RFC 9309), read for `*` and for AGENT: a page is fetched only when both groups allow it.

/** robots.txt's text → its groups `[{agents: [lowercase], rules: [{allow, pattern}]}]`. */
function parseRobots(txt) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(txt).slice(0, 512 * 1024).split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      lastWasAgent = false;
      if (cur && value !== "") cur.rules.push({ allow: key === "allow", pattern: value });
    } else lastWasAgent = false;
  }
  return groups;
}

/** A robots pattern (`*` any run, a final `$` the end) matches `target` (path and query) from its start. */
function patternMatches(pattern, target) {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern).split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${body.join(".*")}${anchored ? "$" : ""}`).test(target);
}

/** Whether the rules of the groups naming `agent` allow `target`; null when no group names it. */
function groupAllows(groups, agent, target) {
  const rules = groups.filter((g) => g.agents.includes(agent)).flatMap((g) => g.rules);
  if (!groups.some((g) => g.agents.includes(agent))) return null;
  let best = null;
  for (const r of rules) {
    if (!patternMatches(r.pattern, target)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

/** Why robots.txt's text refuses `url` (`for *` or `for <agent>`), or null when both groups allow it. */
export function robotsRefusal(txt, url, agent = AGENT) {
  const u = new URL(url);
  const target = `${u.pathname}${u.search}`;
  if (u.pathname === "/robots.txt") return null;
  const groups = parseRobots(txt);
  if (groupAllows(groups, "*", target) === false) return "for *";
  if (groupAllows(groups, agent.toLowerCase(), target) === false) return `for ${agent}`;
  return null;
}

/** Whether robots.txt's text lets this script fetch `url`. */
export const robotsAllows = (txt, url, agent = AGENT) => robotsRefusal(txt, url, agent) === null;

// ---------------------------------------------------------------------------------------------------
// Measurements and bands.

/**
 * The metrics a band is read for (the judge's bandOf): every screen rule of class `bar` (its band and an internal
 * witness make its row) and every count with a `band` threshold. A cycle family compares paths or screens: only the
 * judge has those; an implicit or derived rule stands on its own measurement and needs no band.
 */
export const screenMetrics = (bar) => [...new Set(bar.rules.filter((r) => FAMILIES[r.family] && FAMILIES[r.family].scope === "screen" && (r.class === "bar" || "band" in r.threshold)).map((r) => r.metric))];

/**
 * A measured screen (`{census, ease}`, whatever shape the probes give) → `{<metric>: number}` for the band metrics
 * (screenMetrics): the first finite number found under the metric's own name, at any depth of plain objects (the
 * probes put them under `metrics`). A string, an array or a non-finite number is never taken, so no page text can
 * become a band.
 */
export function metricsOf(screen, bar) {
  const wanted = new Set(screenMetrics(bar));
  const out = {};
  const queue = [screen];
  while (queue.length) {
    const o = queue.shift();
    if (!isObj(o)) continue;
    for (const [k, v] of Object.entries(o)) {
      if (wanted.has(k) && !(k in out) && typeof v === "number" && Number.isFinite(v)) out[k] = v;
      else if (isObj(v)) queue.push(v);
    }
  }
  return Object.fromEntries(screenMetrics(bar).filter((m) => m in out).map((m) => [m, out[m]]));
}

/** The nearest-rank percentile `q` (0–1) of ascending `sorted`: always a value the corpus measured. */
export function percentile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

const round = (v) => Math.round(v * 1000) / 1000;

/**
 * The measured pages `[{url, site, archetype, width, metrics}]` → `{archetypes, cut}`: per archetype `{calibrated,
 * widths}`, a band per width bucket (widthBucket of the page's width) and metric, `{n, sites, p10, p50, p90, urls}`. A
 * band driven by one site is cut (one site only, or one site giving more than half its pages): a single brand's numbers
 * never stand for the corpus.
 */
export function bandsOf(measured, { calibrated }) {
  const archetypes = {};
  const cut = [];
  for (const a of ARCHETYPES) {
    for (const width of WIDTH_BUCKETS) {
      const rows = measured.filter((m) => m.archetype === a && widthBucket(m.width) === width);
      const metrics = [...new Set(rows.flatMap((r) => Object.keys(r.metrics)))].sort();
      for (const metric of metrics) {
        const hits = rows.filter((r) => typeof r.metrics[metric] === "number");
        const perSite = new Map();
        for (const h of hits) perSite.set(h.site, (perSite.get(h.site) || 0) + 1);
        if (perSite.size < 2) {
          cut.push({ archetype: a, width, metric, why: "one site gives it all" });
          continue;
        }
        if (Math.max(...perSite.values()) * 2 > hits.length) {
          cut.push({ archetype: a, width, metric, why: "one site gives more than half its pages" });
          continue;
        }
        const sorted = hits.map((h) => h.metrics[metric]).sort((x, y) => x - y);
        ((archetypes[a] ||= { calibrated, widths: {} }).widths[width] ||= {})[metric] = {
          n: hits.length,
          sites: perSite.size,
          p10: round(percentile(sorted, 0.1)),
          p50: round(percentile(sorted, 0.5)),
          p90: round(percentile(sorted, 0.9)),
          urls: [...new Set(hits.map((h) => h.url))].sort(),
        };
      }
    }
  }
  return { archetypes, cut };
}

/**
 * The bar's next `archetypes`: each archetype measured now (`fresh`) replaces its entry whole; one the run had no page
 * of (`attempted` holds the run's archetypes) keeps its entry while the bar's probe digest is the current probes' (the
 * same measure), else it is dropped → `{archetypes, lines}`, a line per archetype kept or dropped.
 */
export function mergeArchetypes(bar, fresh, attempted) {
  const archetypes = {};
  const lines = [];
  const same = bar.probe === probeDigest();
  for (const a of ARCHETYPES) {
    const old = bar.archetypes[a];
    if (fresh[a]) archetypes[a] = fresh[a];
    else if (old && !attempted.has(a) && same) {
      archetypes[a] = old;
      lines.push(`kept ${a} (calibrated ${old.calibrated}): this run measured none of its pages`);
    } else if (old && !attempted.has(a)) lines.push(`dropped ${a} (calibrated ${old.calibrated}): measured by other probe sources than this run's`);
  }
  return { archetypes, lines };
}

/**
 * Null when `archetypes` holds nothing but bands of numbers, the bar's metric names and the measured URLs; else where
 * the first other value sits (never the value itself: it may be page text).
 */
export function numbersOnly(archetypes, metrics = screenMetrics(loadBar()), urls = null) {
  if (!isObj(archetypes)) return "archetypes: not an object";
  const allowed = new Set(metrics);
  for (const [a, e] of Object.entries(archetypes)) {
    if (!ARCHETYPES.includes(a)) return "archetypes: a key that is not one of the five archetypes";
    if (!isObj(e)) return `archetypes.${a}: not an object`;
    if (!Object.keys(e).every((k) => k === "calibrated" || k === "widths")) return `archetypes.${a}: a key that is not calibrated or widths`;
    if (typeof e.calibrated !== "string" || !MONTH.test(e.calibrated)) return `archetypes.${a}.calibrated: not a month`;
    if (!isObj(e.widths)) return `archetypes.${a}.widths: not an object of width buckets`;
    for (const [w, bands] of Object.entries(e.widths)) {
      if (!WIDTH_BUCKETS.includes(w)) return `archetypes.${a}.widths: a key that is not a width bucket`;
      if (!isObj(bands)) return `archetypes.${a}.widths.${w}: not an object of bands`;
      for (const [m, b] of Object.entries(bands)) {
        if (!allowed.has(m) || !METRIC.test(m)) return `archetypes.${a}.widths.${w}: a key that is not a metric of the bar`;
        const at = `archetypes.${a}.widths.${w}.${m}`;
        if (!isObj(b)) return `${at}: not a band`;
        for (const [k, v] of Object.entries(b)) {
          if (k === "urls") {
            if (!Array.isArray(v) || !v.every((u) => urlOk(u, ["https:", "http:"]) && (!urls || urls.has(u)))) return `${at}.urls: a value that is not a measured URL`;
          } else if (!["n", "sites", "p10", "p50", "p90"].includes(k)) return `${at}: a key that is not part of a band`;
          else if (typeof v !== "number" || !Number.isFinite(v)) return `${at}.${k}: not a number`;
        }
      }
    }
  }
  return null;
}

/** The sha256 of the probe sources a calibration measured with: the bar's `probe`. */
export function probeDigest(sources = [TASTE_SOURCE, EASE_SOURCE]) {
  return crypto.createHash("sha256").update(JSON.stringify(sources)).digest("hex");
}

const ps = (b) => `${b.p10}/${b.p50}/${b.p90}`;
/**
 * Each archetype's month and each band's change from `before` to `after` (bar `archetypes`): per archetype (sorted) its
 * `calibrated` line, then one line a band, by width bucket and metric (`<archetype>.<width>.<metric>`, sorted).
 */
export function diffLines(before, after) {
  const out = [];
  for (const a of [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].sort()) {
    const [o, n] = [before?.[a], after?.[a]];
    if (!o) out.push(`${a}: calibrated ${n.calibrated} (new)`);
    else if (!n) out.push(`${a}: gone (was calibrated ${o.calibrated})`);
    else out.push(o.calibrated === n.calibrated ? `${a}: calibrated ${n.calibrated} (unchanged)` : `${a}: calibrated ${o.calibrated} → ${n.calibrated}`);
    const keys = new Set();
    for (const e of [o, n]) for (const [w, bands] of Object.entries(e?.widths || {})) for (const m of Object.keys(bands)) keys.add(`${w}.${m}`);
    for (const k of [...keys].sort()) {
      const [w, m] = k.split(".");
      out.push(bandLine(`${a}.${k}`, o?.widths?.[w]?.[m], n?.widths?.[w]?.[m]));
    }
  }
  return out;
}

/** One band's change: new, gone, unchanged, or its percentiles, n and sites before → after. */
function bandLine(key, o, n) {
  if (!o) return `${key}: new ${ps(n)} (n ${n.n}, sites ${n.sites})`;
  if (!n) return `${key}: gone (was ${ps(o)}, n ${o.n}, sites ${o.sites})`;
  if (ps(o) === ps(n) && o.n === n.n && o.sites === n.sites) return `${key}: unchanged ${ps(n)} (n ${n.n}, sites ${n.sites})`;
  const part = (label, x, y) => (x === y ? `${label} ${x}` : `${label} ${x} → ${y}`);
  return `${key}: ${part("p10/p50/p90", ps(o), ps(n))}, ${part("n", o.n, n.n)}, ${part("sites", o.sites, n.sites)}`;
}

// ---------------------------------------------------------------------------------------------------
// The run.

/** Pages in round-robin order across sites (each site's own order kept), so one site's pause does not hold the rest. */
const interleave = (pages) => {
  const bySite = new Map();
  for (const p of pages) bySite.set(p.site, [...(bySite.get(p.site) || []), p]);
  return bySite;
};

/** A short, page-text-free reason for a load error. */
const loadError = (e) => {
  const msg = e && e.message ? String(e.message) : "";
  const net = /net::[A-Z_]+/.exec(msg);
  if (net) return net[0];
  if (/timeout/i.test(msg)) return "timeout";
  return e && e.name ? String(e.name).slice(0, 40) : "error";
};
const SIGN_IN = /(^|\/)(log-?in|sign-?in|signin|sign_in|session|auth|sso|oauth)(\/|$)/i;

/**
 * Measures `pages` (validated corpus pages, or loopback ones in a test) through `session` with `probes` → `{measured,
 * skipped, archetypes, cut}`. The order per site is kept, sites are served round-robin, and every request to a site
 * (robots.txt included) starts PACE_MS after its last one ended. robots.txt is read once per origin: a page it refuses
 * for `*` or for AGENT is never requested; an origin whose robots.txt cannot be read (5xx, 429, a network error) is
 * skipped whole; a 4xx other than 429 means no robots.txt (RFC 9309). A page that redirects off its origin or to a
 * sign-in path, answers non-2xx, or yields no metric is skipped. Only numbers of the bar's metrics are kept, under the
 * 1440 width bucket (VIEWPORT) and the month of `today()`.
 */
export async function calibrate({ pages, bar, session, probes, now = Date.now, today = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const queues = interleave(pages);
  const order = [...queues.keys()];
  const last = new Map();
  const robots = new Map();
  const measured = [];
  const skipped = [];
  const skip = (url, reason) => {
    skipped.push({ url, reason });
    log(`skipped ${url}: ${reason}`);
  };
  const measure = async (page) => {
    try {
      return { screen: { census: await probes.census(page), ease: await probes.ease(page) } };
    } catch (e) {
      const m = e && e.message ? String(e.message).split("\n")[0] : "";
      return { error: /^(refused|failed): /.test(m) ? m.slice(0, 160) : loadError(e) };
    }
  };
  for (;;) {
    const ready = order.filter((s) => queues.get(s).length > 0);
    if (!ready.length) break;
    // The site free soonest (the earlier one in the corpus on a tie) goes next.
    const at = (s) => (last.has(s) ? last.get(s) + PACE_MS : -Infinity);
    const site = ready.reduce((best, s) => (at(s) < at(best) ? s : best));
    const wait = at(site) - now();
    if (wait > 0) await sleep(wait);
    const page = queues.get(site)[0];
    const origin = new URL(page.url).origin;
    if (!robots.has(origin)) {
      let r;
      try {
        r = await session.robots(origin);
      } catch (e) {
        r = { status: 0, error: loadError(e) };
      }
      last.set(site, now());
      const s = r.status;
      robots.set(origin, s >= 200 && s < 300 ? { text: r.text || "" } : s >= 400 && s < 500 && s !== 429 ? { text: "" } : { unreadable: s ? `HTTP ${s}` : r.error || "network error" });
      continue;
    }
    queues.get(site).shift();
    const rb = robots.get(origin);
    if (rb.unreadable) {
      skip(page.url, `robots.txt could not be read (${rb.unreadable}): the origin is skipped`);
      continue;
    }
    const no = robotsRefusal(rb.text, page.url);
    if (no) {
      skip(page.url, `robots.txt disallows it ${no}`);
      continue;
    }
    let v;
    try {
      v = await session.visit(page.url, measure);
    } catch (e) {
      v = { error: loadError(e) };
    }
    last.set(site, now());
    if (v.error) {
      skip(page.url, `the page did not load (${v.error})`);
      continue;
    }
    const final = v.finalUrl ? new URL(v.finalUrl) : null;
    if (!(v.status >= 200 && v.status < 300)) skip(page.url, `HTTP ${v.status}`);
    else if (!final || final.origin !== origin) skip(page.url, "redirected to another origin");
    else if (final.pathname !== new URL(page.url).pathname && SIGN_IN.test(final.pathname)) skip(page.url, "redirected to a sign-in page");
    else if (robotsRefusal(rb.text, final.href)) skip(page.url, "redirected to a path robots.txt disallows");
    else if (v.result.error) skip(page.url, `the probes failed on it (${v.result.error})`);
    else {
      const metrics = metricsOf(v.result.screen, bar);
      if (!Object.keys(metrics).length) skip(page.url, "the probes measured no metric of the bar");
      else {
        measured.push({ url: page.url, site: page.site, archetype: page.archetype, width: VIEWPORT.width, metrics });
        log(`measured ${page.url} (${page.archetype}, ${plural(Object.keys(metrics).length, "metric")})`);
      }
    }
  }
  const { archetypes, cut } = bandsOf(measured, { calibrated: monthOf(today()) });
  const why = numbersOnly(archetypes, screenMetrics(bar), new Set(pages.map((p) => p.url)));
  if (why) throw new Error(`failed: taste-calibrate: the output would hold a string that is not a URL or a metric name (${why}): nothing written`);
  return { measured, skipped, archetypes, cut };
}

// ---------------------------------------------------------------------------------------------------
// The browser: the pinned install's playwright-core driving the local Chrome, a fresh context a page.

/** A blank local page for the probes' dry run: no request leaves the browser. */
const BLANK = `<!doctype html><html lang="en"><head><title>blank</title></head><body><main><h1>Blank</h1><p>A local page.</p><button type="button">Go</button></main></body></html>`;

/**
 * A browser session → `{blank(measure), robots(origin), visit(url, measure, opts?), signIn(code, opts?), close()}`. Each
 * visit gets a fresh context (no cookie or storage carried over: never signed in), the taste buffer and both probes'
 * init scripts as the lane's session hook installs them, light colour scheme and no reduced motion, service workers
 * blocked, and the user agent Chrome reports plus AGENT. The local corpus's `opts`: `viewport` (VIEWPORT by default),
 * `storageState` (a signed-in context), and `origins`: every request to another origin is aborted (the lane's loopback
 * instance only). `signIn(code)` runs `code` (an `async page => …` source, the lane's own login stage) on a fresh
 * page → `{result, storageState}`, the storage state only when the stage answered `in`.
 */
export async function openSession({ cli = ensureCli(), chrome = findChrome() } = {}) {
  if (!chrome) throw new Error("failed: taste-calibrate: no Chrome-family browser found");
  const pw = (await import(pathToFileURL(path.join(cli.dir, "node_modules/playwright-core/index.mjs")).href)).default;
  const browser = await pw.chromium.launch({ executablePath: chrome.path, headless: true });
  try {
    const probe = await browser.newPage();
    const ua = `${await probe.evaluate(() => navigator.userAgent)} ${AGENT}`;
    await probe.close();
    const init = [TASTE_BUFFER, TASTE_INIT, EASE_INIT].filter((s) => s !== "").join(";\n");
    const context = async ({ viewport = VIEWPORT, storageState = null, origins = null } = {}) => {
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, userAgent: ua, colorScheme: "light", reducedMotion: "no-preference", locale: "en-US", serviceWorkers: "block", ...(storageState ? { storageState } : {}) });
      if (origins) {
        const allowed = new Set(origins.map((o) => new URL(o).origin));
        await ctx.route("**/*", (r) => {
          let origin = null;
          try {
            origin = new URL(r.request().url()).origin;
          } catch {
            origin = null;
          }
          return allowed.has(origin) ? r.continue() : r.abort("blockedbyclient");
        });
      }
      await ctx.addInitScript({ content: init });
      return ctx;
    };
    const request = await pw.request.newContext({ userAgent: ua, timeout: 30_000 });
    return {
      async blank(measure) {
        const ctx = await context();
        try {
          const page = await ctx.newPage();
          await page.route("**/*", (r) => r.abort());
          await page.setContent(BLANK, { waitUntil: "load" });
          return await measure(page);
        } finally {
          await ctx.close();
        }
      },
      async robots(origin) {
        const r = await request.get(`${origin}/robots.txt`, { maxRedirects: 5, failOnStatusCode: false });
        return { status: r.status(), text: r.ok() ? await r.text() : "" };
      },
      async signIn(code, opts = {}) {
        const ctx = await context(opts);
        try {
          const page = await ctx.newPage();
          const result = await new Function(`return (${code})`)()(page);
          return { result, storageState: result && result.state === "in" ? await ctx.storageState() : null };
        } finally {
          await ctx.close();
        }
      },
      async visit(url, measure, opts = {}) {
        const ctx = await context(opts);
        try {
          const page = await ctx.newPage();
          const resp = await page.goto(url, { waitUntil: "load", timeout: 45_000 });
          await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
          await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
          return { status: resp ? resp.status() : 0, finalUrl: page.url(), result: await measure(page) };
        } finally {
          await ctx.close();
        }
      },
      async close() {
        await request.dispose().catch(() => {});
        await browser.close();
      },
    };
  } catch (e) {
    await browser.close();
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------
// The CLI.

/** The new bar's text: `probe` and `archetypes` replaced in place (the rest of the file byte for byte, one band a line), else re-written. */
export function barText(old, bar) {
  const lines = [];
  const band = (b) => JSON.stringify(b).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, "{ ").replace(/\}$/, " }");
  for (const a of ARCHETYPES.filter((x) => bar.archetypes[x])) {
    const e = bar.archetypes[a];
    const widths = Object.entries(e.widths).map(([w, bands]) => `        ${JSON.stringify(w)}: {\n${Object.entries(bands).map(([m, b]) => `          ${JSON.stringify(m)}: ${band(b)}`).join(",\n")}\n        }`);
    lines.push(`    ${JSON.stringify(a)}: {\n      "calibrated": ${JSON.stringify(e.calibrated)},\n      "widths": {\n${widths.join(",\n")}\n      }\n    }`);
  }
  const archetypes = lines.length ? `{\n${lines.join(",\n")}\n  }` : "{}";
  const spliced = old.replace(/^ {2}"probe": (null|"[0-9a-f]{64}"),$/m, () => `  "probe": ${JSON.stringify(bar.probe)},`).replace(/^ {2}"archetypes": [\s\S]*\n\}\s*$/m, () => `  "archetypes": ${archetypes}\n}\n`);
  try {
    if (JSON.stringify(JSON.parse(spliced)) === JSON.stringify(bar)) return spliced;
  } catch {
    // The file's layout changed: write it whole.
  }
  return `${JSON.stringify(bar, null, 2)}\n`;
}

/** The plan without --network: every page by archetype, what is skipped and why, and the least time it takes. */
function planLines(corpus) {
  const out = ["taste-calibrate: the plan (nothing fetched: --network measures it, on a maintainer's machine only)"];
  const sites = new Set(corpus.pages.map((p) => p.site));
  const perSite = Math.max(...[...sites].map((s) => corpus.pages.filter((p) => p.site === s).length));
  out.push(`${plural(corpus.pages.length, "page")} on ${plural(sites.size, "site")}; robots.txt honoured for * and ${AGENT}; one page per site every ${PACE_MS / 1000} s (at least ${Math.ceil((perSite * PACE_MS) / 60_000)} min)`);
  for (const a of ARCHETYPES) {
    const ps = corpus.pages.filter((p) => p.archetype === a);
    const ss = [...new Set(ps.map((p) => p.site))];
    out.push(`${a}: ${plural(ps.length, "page")}, ${plural(ss.length, "site")}${ss.length ? ` (${ss.join(", ")})` : ""}`);
    for (const p of ps) out.push(`  ${p.url} (${p.site})`);
  }
  if (corpus.skipped.length) {
    out.push(`left out by the corpus's review: ${corpus.skipped.length}`);
    for (const s of corpus.skipped) out.push(`  ${s.url}: ${s.reason}`);
  }
  return out;
}

/** Per archetype and width bucket: pages (or `unit`s) and sites measured, and whether that reaches decision 16's witness threshold. */
export function summaryLines(measured, unit = "page") {
  return ARCHETYPES.flatMap((a) => {
    const all = measured.filter((m) => m.archetype === a);
    if (!all.length) return [`${a}: no page measured — thin`];
    return WIDTH_BUCKETS.map((w) => [w, all.filter((m) => widthBucket(m.width) === w)]).filter(([, rows]) => rows.length).map(([w, rows]) => {
      const sites = new Set(rows.map((r) => r.site)).size;
      const witness = sites >= WITNESS.sites && rows.length >= WITNESS.pages;
      return `${a} ${w}: ${plural(rows.length, unit)}, ${plural(sites, "site")} — ${witness ? "a witness" : `thin (a witness needs at least ${WITNESS.sites} sites and ${WITNESS.pages} pages)`}`;
    });
  });
}

export const readJson = (file, what) => {
  try {
    return { value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (e) {
    return { error: refused(`${what} ${file} ${e instanceof SyntaxError ? "is not valid JSON" : "cannot be read"}`) };
  }
};

/**
 * `argv` → `{code, lines}`. `deps` replaces the browser, the probes, the clocks (`now` paces, `today` dates the bands),
 * and for --local GitHub, git, docker and the lane's CLI (the tests' seams; the CLI passes none). Without --network: the
 * corpus validated and the plan printed, nothing fetched or written. `--local <manifest>` measures the local reference
 * corpus instead (taste-calibrate-local.mjs): `--refresh` pins each app to its latest release.
 */
export async function main(argv, deps = {}) {
  const opts = { network: false, diff: false, refresh: false, corpus: null, out: null, local: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--network") opts.network = true;
    else if (a === "--diff") opts.diff = true;
    else if (a === "--refresh") opts.refresh = true;
    else if ((a === "--corpus" || a === "--out" || a === "--local") && typeof argv[i + 1] === "string" && !argv[i + 1].startsWith("--")) opts[a.slice(2)] = argv[++i];
    else return { code: 1, lines: [refused(`unknown argument ${JSON.stringify(a).slice(0, 60)}`), usage] };
  }
  if (opts.local && opts.corpus) return { code: 1, lines: [refused("--local and --corpus are two corpora: name one"), usage] };
  if (opts.refresh && !opts.local) return { code: 1, lines: [refused("--refresh needs --local <manifest>"), usage] };
  if (opts.refresh && (opts.network || opts.out || opts.diff)) return { code: 1, lines: [refused("--refresh only rewrites the manifest's pins: run it alone, then --network"), usage] };
  if (opts.local && !opts.refresh && !opts.out) return { code: 1, lines: [refused("--out is required (the bar the bands go into)"), usage] };
  if (!opts.local && (!opts.corpus || !opts.out)) return { code: 1, lines: [refused("--corpus and --out are required"), usage] };
  if (opts.diff && !opts.network) return { code: 1, lines: [refused("--diff compares a new calibration with the bar, so it needs --network"), usage] };
  if (opts.local) return (await import("./taste-calibrate-local.mjs")).mainLocal(opts, deps);
  const c = readJson(opts.corpus, "the corpus");
  if (c.error) return { code: 1, lines: [c.error] };
  const corpus = validateCorpus(c.value);
  if (!corpus.value) return { code: 1, lines: corpus.errors.map((e) => refused(`the corpus is broken: ${e}`)) };
  const b = readJson(opts.out, "the bar");
  if (b.error) return { code: 1, lines: [b.error] };
  const bar = validateBar(b.value);
  if (!bar.value) return { code: 1, lines: [refused(`the bar ${opts.out} is broken: ${bar.errors[0]}`)] };
  if (!opts.network) return { code: 0, lines: planLines(corpus.value) };
  // The terms gate: an agent's reading of a site's terms is not the maintainer's. A site measured needs `confirmed`.
  const unconfirmed = unconfirmedSites(corpus.value);
  if (unconfirmed.length) return { code: 1, lines: [refused(`no maintainer confirmed the terms of ${unconfirmed.join(", ")} (sites.<site>.confirmed {by, on}): nothing fetched`)] };

  const probes = deps.probes || { census: censusOf, ease: easeOf };
  const lines = [];
  const session = await (deps.openSession || openSession)();
  let result;
  try {
    try {
      await session.blank(async (page) => ({ census: await probes.census(page), ease: await probes.ease(page) }));
    } catch (e) {
      const m = e && e.message ? String(e.message).split("\n")[0].slice(0, 160) : "an error";
      return { code: 1, lines: [refused(`the probes cannot measure a blank page (${m}): nothing was fetched`)] };
    }
    result = await calibrate({ pages: corpus.value.pages, bar: bar.value, session, probes, now: deps.now, today: deps.today, sleep: deps.sleep, log: (l) => lines.push(l) });
  } catch (e) {
    return { code: 1, lines: [...lines, e && e.message && /^(refused|failed): /.test(e.message) ? e.message : refused(`the run stopped (${loadError(e)}): nothing written`)] };
  } finally {
    await session.close();
  }
  const written = writeBands({ out: opts.out, bar: bar.value, result, attempted: new Set(corpus.value.pages.map((p) => p.archetype)), diff: opts.diff });
  return { code: written.code, lines: [...lines, ...written.lines] };
}

/**
 * A run's `result` (calibrate's, or the local corpus's) written into the bar at `out`: `probe` the current probes'
 * digest, `archetypes` merged (mergeArchetypes: `attempted` the run's archetypes), validated, then renamed into place
 * → `{code, lines}`: each cut band, the kept or dropped archetypes, `diff`'s lines, the summary per archetype and width.
 * No band measured, or a bar that would not validate: refused, nothing written.
 */
export function writeBands({ out, bar, result, attempted, diff = false, unit = "page" }) {
  const cuts = result.cut.map((k) => `cut ${k.archetype}.${k.width}.${k.metric}: ${k.why}`);
  if (!Object.keys(result.archetypes).length) return { code: 1, lines: [...cuts, refused("no band was measured: the bar is unchanged")] };
  const lines = [...cuts];
  const merged = mergeArchetypes(bar, result.archetypes, attempted);
  const next = { ...bar, probe: probeDigest(), archetypes: merged.archetypes };
  const checked = validateBar(next);
  if (!checked.value) return { code: 1, lines: [refused(`the new bar would not validate (${checked.errors[0]}): nothing written`)] };
  const tmp = `${out}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, barText(fs.readFileSync(out, "utf8"), next));
  fs.renameSync(tmp, out);
  lines.push(...merged.lines);
  if (diff) lines.push(...diffLines(bar.archetypes, next.archetypes));
  lines.push(...summaryLines(result.measured, unit));
  lines.push(`taste-bar ${bar.version} stays: a calibration after a release raises it by one (decision 21); probe ${next.probe.slice(0, 12)}`);
  lines.push(`wrote ${out}: ${plural(result.measured.length, unit)} measured, ${plural(result.skipped.length, "page")} skipped`);
  return { code: 0, lines };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const r = await main(process.argv.slice(2));
  for (const l of r.lines) (r.code ? process.stderr : process.stdout).write(`${l}\n`);
  process.exitCode = r.code;
}
