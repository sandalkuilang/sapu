// scripts/taste-calibrate-local.mjs — taste-calibrate's local reference corpus (`--local <manifest>`, spec §20.3): the
// bar's bands measured on OSI-licensed, actively maintained OSS apps run on loopback, instead of public sites whose terms
// no maintainer confirmed. Each app of the manifest (scripts/taste-corpus-local.json) is pinned to its latest release
// (`--refresh` resolves it: a git commit, or an image digest, and refuses an app whose last release is older than
// `max_age_months` or whose license GitHub does not confirm as the OSI license declared), fetched into a temp dir, run
// by the journey lane's own instance runner (`argus-live.mjs up` and `down`, as a cycle runs it), measured by the
// calibration's own session and probes (taste-calibrate.mjs openSession, the census and ease probes: numbers only, no
// page text, screenshot or asset kept), then deleted.
//
// A library of taste-calibrate.mjs (its main imports it for --local), never a program of its own, never in the plugin.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandConfig, loadLive, validateLive } from "../plugins/sapu/scripts/argus-live-config.mjs";
import { easeOf } from "../plugins/sapu/scripts/argus-live-ease.mjs";
import { loginCode, loginPlan } from "../plugins/sapu/scripts/argus-live-login.mjs";
import { censusOf } from "../plugins/sapu/scripts/argus-live-taste.mjs";
import { ARCHETYPES, STALE_MONTHS, staleBands, validateBar } from "../plugins/sapu/scripts/argus-live-tastecfg.mjs";
import { AGENT, bandsOf, metricsOf, monthOf, numbersOnly, openSession, readJson, refused, screenMetrics, writeBands } from "./taste-calibrate.mjs";

/** The widths every route is measured at (each a width bucket of the bar); the census gives light and dark at each. */
export const WIDTHS = Object.freeze([390, 1440]);
const HEIGHT = Object.freeze({ 390: 844, 1440: 900 });
/** The routes a ready app names: three app screens, two forms, two data screens. */
export const ROUTE_MIX = Object.freeze({ app: 3, form: 2, data: 2 });
/**
 * The licenses the Open Source Initiative approved, as SPDX ids (GitHub spells the AGPL, GPL and LGPL without
 * `-only`): an app under any other (a source-available or a commercial license, or none GitHub can name) is refused.
 */
export const OSI_LICENSES = Object.freeze(["0BSD", "AFL-3.0", "AGPL-3.0", "AGPL-3.0-only", "AGPL-3.0-or-later", "Apache-2.0", "Artistic-2.0", "BSD-2-Clause", "BSD-3-Clause", "BSL-1.0", "CDDL-1.0", "ECL-2.0", "EPL-1.0", "EPL-2.0", "EUPL-1.2", "GPL-2.0", "GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0", "GPL-3.0-only", "GPL-3.0-or-later", "ISC", "LGPL-2.1", "LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0", "LGPL-3.0-only", "LGPL-3.0-or-later", "MIT", "MIT-0", "MPL-2.0", "MS-PL", "NCSA", "OSL-3.0", "PostgreSQL", "UPL-1.0", "Unlicense", "Zlib"]);
/** The lane's one program: `up` and `down` run through it, in the fetched app's directory. */
export const ARGUS_LIVE = fileURLToPath(new URL("../plugins/sapu/scripts/argus-live.mjs", import.meta.url));

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MONTH = /^20[0-9]{2}-(0[1-9]|1[0-2])$/;
const GITHUB = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/;
const IMAGE = /^[a-z0-9]+([._/-][a-z0-9]+)*(:[0-9]{1,5}\/[a-z0-9]+([._/-][a-z0-9]+)*)?$/;
const IMAGE_TAG = /^[A-Za-z0-9._@{}-]{1,128}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const ROUTE = /^\/[^\s#]{0,199}$/;
const ENV_FILE = ".argus/live.env";
const shown = (v) => (typeof v === "string" && /^[\x21-\x7e]{1,80}$/.test(v) ? v : "(not shown)");
const firstLine = (t) => String(t || "").trim().split("\n").filter(Boolean).pop()?.slice(0, 200) || "no output";

// ---------------------------------------------------------------------------------------------------
// The manifest.

const MANIFEST_KEYS = ["coverage", "max_age_months", "apps"];
const APP_KEYS = ["repo", "license", "note", "source", "image", "image_tag", "release", "live", "env", "login", "routes"];

/**
 * The manifest checked → `{value, errors}`: `{coverage, max_age_months, apps: {<id>: {repo, license, note, source,
 * image?, image_tag?, release, live, env, login, routes}}}`, unknown keys refused. `repo` is the app's GitHub page (its
 * releases and license are read there); `license` an OSI-approved SPDX id (OSI_LICENSES); `source` `git` (the release's
 * commit is fetched) or `image` (`image` pulled by digest, the app's live config naming it as `${IMAGE}`; `image_tag`
 * maps a release tag to the image's, `{tag}` or `{version}`, the tag without its leading letters); `release` null until
 * --refresh pins it, then `{tag, published: "YYYY-MM", commit | digest}`. `live` is the app's `.argus/live.json` for the
 * lane (null: a candidate, not run), `env` the values its env file gets (`.argus/live.env`, single-quoted as the lane
 * reads them, so no value holds a `'`; never committed with the app), `login` the role signed in before the routes (its first user, password only), `routes` `[{path, archetype}]`:
 * a ready app (one with `live`) names ROUTE_MIX exactly.
 */
export function validateManifest(raw) {
  if (!isObj(raw)) return { value: null, errors: ["the manifest must be a JSON object"] };
  const errs = [];
  const need = (cond, msg) => cond || errs.push(msg);
  for (const k of Object.keys(raw)) if (!MANIFEST_KEYS.includes(k)) errs.push(`unknown key "${shown(k)}"`);
  need(text(raw.coverage, 2000), "coverage must say what the corpus covers and why");
  need(Number.isInteger(raw.max_age_months) && raw.max_age_months >= 1 && raw.max_age_months <= 60, "max_age_months must be an integer from 1 to 60 (a release older than that is unmaintained)");
  if (need(isObj(raw.apps) && Object.keys(raw.apps).length > 0, "apps must describe at least one app") !== true) return { value: null, errors: errs };
  for (const [id, a] of Object.entries(raw.apps)) {
    const at = `apps.${shown(id)}`;
    if (need(KEBAB.test(id) && isObj(a), `${at} must be an object under a kebab-case id`) !== true) continue;
    for (const k of Object.keys(a)) if (!APP_KEYS.includes(k)) errs.push(`${at}: unknown key "${shown(k)}"`);
    need(typeof a.repo === "string" && GITHUB.test(a.repo), `${at}.repo must be the app's https://github.com/<owner>/<repo> page`);
    need(OSI_LICENSES.includes(a.license), `${at}.license must be an OSI-approved license (SPDX id, one of OSI_LICENSES)`);
    need(text(a.note, 300), `${at}.note must say what the app is and why it is in the corpus`);
    const image = a.source === "image";
    need(a.source === "git" || image, `${at}.source must be git or image`);
    if (image) need(typeof a.image === "string" && IMAGE.test(a.image), `${at}.image must be the image's name, with no tag or digest`);
    else need(!("image" in a) && !("image_tag" in a), `${at}: image and image_tag belong to an image source`);
    if ("image_tag" in a) need(typeof a.image_tag === "string" && IMAGE_TAG.test(a.image_tag) && /\{(tag|version)\}/.test(a.image_tag), `${at}.image_tag must map the release tag ({tag} or {version}) to the image's`);
    if (a.release !== null) {
      const r = a.release;
      const pin = image ? "digest" : "commit";
      need(isObj(r) && Object.keys(r).length === 3 && text(r.tag, 128) && !/\s/.test(r.tag) && typeof r.published === "string" && MONTH.test(r.published) && (image ? /^sha256:[0-9a-f]{64}$/.test(r.digest) : /^[0-9a-f]{40}$/.test(r.commit)), `${at}.release must be null or {tag, published: "YYYY-MM", ${pin}} (--refresh writes it)`);
    }
    const env = isObj(a.env) ? a.env : null;
    need(env && Object.entries(env).every(([k, v]) => ENV_NAME.test(k) && typeof v === "string" && v.length <= 500 && !/[\r\n']/.test(v)) && !(image && "IMAGE" in env), `${at}.env must map NAMES to one-line values with no single quote (the env file quotes them so)${image ? "; IMAGE is the script's: the pinned image" : ""}`);
    if (a.live !== null) {
      if (need(isObj(a.live), `${at}.live must be null (a candidate) or the app's live.json for the lane`) !== true) continue;
      for (const e of validateLive(a.live)) errs.push(`${at}.live: ${String(e).replace(/^\.argus\/live\.json:? /, "")}`);
      const file = image || (env && Object.keys(env).length > 0);
      need(a.live.env_file === ENV_FILE || (!file && !("env_file" in a.live)), `${at}.live.env_file must be ${ENV_FILE} (where env's values${image ? " and IMAGE" : ""} go)`);
    }
    if (a.login !== null) {
      const role = isObj(a.live) && isObj(a.live.roles) ? a.live.roles[a.login] : null;
      const user = isObj(role) && Array.isArray(role.users) ? role.users[0] : null;
      need(typeof a.login === "string" && isObj(user) && !("totp_secret" in user), `${at}.login must name a role of its live config whose first user signs in with a password alone`);
    }
    if (need(Array.isArray(a.routes) && a.routes.every((r) => isObj(r) && Object.keys(r).length === 2 && typeof r.path === "string" && ROUTE.test(r.path) && Object.hasOwn(ROUTE_MIX, r.archetype)), `${at}.routes must be [{path: "/…" (no fragment), archetype: app, form or data}]`) !== true) continue;
    need(new Set(a.routes.map((r) => r.path)).size === a.routes.length, `${at}.routes names a path twice`);
    if (a.live !== null) need(Object.entries(ROUTE_MIX).every(([k, n]) => a.routes.filter((r) => r.archetype === k).length === n), `${at}.routes must be ${ROUTE_MIX.app} app, ${ROUTE_MIX.form} form and ${ROUTE_MIX.data} data routes`);
  }
  return errs.length ? { value: null, errors: errs } : { value: structuredClone(raw), errors: [] };
}

const monthsSince = (month, now) => {
  const d = new Date(now);
  return d.getUTCFullYear() * 12 + d.getUTCMonth() - (Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1);
};

/** Whether app `a` (validated) is measured by a run at `now`: `{ready, why}`, why naming every gap. */
export function appStatus(a, { now, maxAge }) {
  const why = [];
  if (a.live === null) why.push("no live config");
  if (!a.routes.length) why.push("no routes");
  if (a.release === null) why.push("no release pinned (--refresh resolves the latest)");
  else if (monthsSince(a.release.published, now) > maxAge) why.push(`its release ${a.release.tag} is from ${a.release.published}, older than ${maxAge} months: unmaintained`);
  return why.length ? { ready: false, why: why.join("; ") } : { ready: true, why: null };
}

// ---------------------------------------------------------------------------------------------------
// --refresh: GitHub's latest release, its commit or image digest, the license GitHub reads.

/** GitHub's REST API, read anonymously or with GH_TOKEN / GITHUB_TOKEN → `{status, json}` (json null unless 2xx). */
async function githubJson(url) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const r = await fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": AGENT, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  return { status: r.status, json: r.ok ? await r.json() : null };
}

const run = (argv, opts = {}) => {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", maxBuffer: 16 * 2 ** 20, ...opts });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? r.error.message : "") };
};

/**
 * Each app of `manifest` pinned to its latest GitHub release, or rejected (its `release` null, a line saying why): no
 * release, a release older than `max_age_months`, a license GitHub reads as anything but the one declared (GitHub's
 * own detection, so a repository mixing licenses reads `NOASSERTION` and is refused), a tag whose commit or image
 * digest cannot be read. `fetchJson(url)` → `{status, json}` (a network failure throws: nothing is pinned), `runner`
 * runs docker's manifest inspection → `{manifest, lines}`.
 */
export async function refreshManifest(manifest, { fetchJson = githubJson, runner = run, now = Date.now() } = {}) {
  const next = structuredClone(manifest);
  const lines = [];
  for (const [id, a] of Object.entries(next.apps)) {
    const [, owner, repo] = GITHUB.exec(a.repo);
    const api = `https://api.github.com/repos/${owner}/${repo}`;
    const was = a.release;
    a.release = null;
    const reject = (why) => lines.push(`rejected ${id}: ${why}`);
    const rel = await fetchJson(`${api}/releases/latest`);
    const tag = rel.json && typeof rel.json.tag_name === "string" ? rel.json.tag_name : null;
    const at = rel.json && Date.parse(rel.json.published_at);
    if (rel.status !== 200 || !tag || !Number.isFinite(at)) {
      reject(`no latest release (GitHub answered ${rel.status})`);
      continue;
    }
    const published = monthOf(at);
    if (monthsSince(published, now) > next.max_age_months) {
      reject(`its latest release ${tag} is from ${published}, older than ${next.max_age_months} months: unmaintained`);
      continue;
    }
    const lic = await fetchJson(`${api}/license`);
    const spdx = lic.json && isObj(lic.json.license) && typeof lic.json.license.spdx_id === "string" ? lic.json.license.spdx_id : "none";
    if (spdx !== a.license) {
      reject(`GitHub reads its license as ${shown(spdx)}, not ${a.license} (only an OSI license GitHub confirms is measured)`);
      continue;
    }
    let pin;
    if (a.source === "git") {
      const c = await fetchJson(`${api}/commits/${encodeURIComponent(tag)}`);
      const sha = c.json && typeof c.json.sha === "string" && /^[0-9a-f]{40}$/.test(c.json.sha) ? c.json.sha : null;
      if (!sha) {
        reject(`the commit of ${tag} cannot be read (GitHub answered ${c.status})`);
        continue;
      }
      pin = { commit: sha };
    } else {
      const ref = `${a.image}:${(a.image_tag ?? "{tag}").replace("{tag}", tag).replace("{version}", tag.replace(/^[^0-9]*/, ""))}`;
      const r = runner(["docker", "buildx", "imagetools", "inspect", ref, "--format", "{{json .Manifest}}"]);
      let digest = null;
      try {
        digest = r.status === 0 ? JSON.parse(r.stdout).digest : null;
      } catch {
        digest = null;
      }
      if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
        reject(`the digest of ${shown(ref)} cannot be read (${firstLine(r.stderr)})`);
        continue;
      }
      pin = { digest };
    }
    a.release = { tag, published, ...pin };
    const since = !was ? "new" : was.tag === tag && (was.commit ?? was.digest) === (pin.commit ?? pin.digest) ? "unchanged" : `was ${was.tag}`;
    lines.push(`${id}: ${tag} (${published}) ${pin.commit ? `commit ${pin.commit.slice(0, 12)}` : `image ${pin.digest.slice(0, 19)}`} (${since})`);
  }
  return { manifest: next, lines };
}

// ---------------------------------------------------------------------------------------------------
// One app: fetched, prepared, up, measured, down, deleted.

/** A command run asynchronously (the lane's `up` waits on the app for minutes) → `{code, stdout, stderr}`. */
function execAsync(argv, { cwd, env }) {
  return new Promise((resolve) => {
    const p = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.stderr.on("data", (c) => (stderr += c));
    p.on("error", (e) => resolve({ code: 1, stdout, stderr: `${stderr}${e.message}` }));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** The sapu contract the fetched app is given, so the lane's `up` keeps every agent out of its env file. */
const contractFor = (a) => ({
  version: 1,
  repo: GITHUB.exec(a.repo).slice(1, 3).join("/"),
  ghUser: AGENT,
  gitEmail: `${AGENT}@localhost`,
  baseBranch: "main",
  gate: { fast: "true", merge: "false", summaryStart: "^$", redIf: "^$" },
  redAreas: null,
  redAreaSpecialists: [],
  mergeAfter: null,
  labels: { tierPrefix: "risk:", inProgress: "agent:in-progress", done: "agent:done" },
  securityEpic: null,
  invariantDomains: "none: a throwaway instance the taste calibration measures and deletes",
  testResources: "none: a throwaway instance the taste calibration measures and deletes",
  guard: { envFiles: [path.basename(ENV_FILE)], postgres: null, deny: [] },
});

/**
 * App `a`'s pinned release fetched into `dir` and made a repo the lane can run: a git source's commit fetched alone
 * (depth 1) and checked out, an image source's image pulled by digest into an empty repo; then `.argus/live.json`
 * (the manifest's `live`), `.claude/sapu.json` (contractFor) and the ignore lines committed on top, and the env file
 * written (ignored, never committed). Throws `failed: …` naming the step.
 */
function prepare(a, dir, { git, runner, gitUrl }) {
  const g = (...args) => {
    const r = git(["-C", dir, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", `user.name=${AGENT}`, "-c", `user.email=${AGENT}@localhost`, ...args]);
    if (r.status !== 0) throw new Error(`failed: git ${args[0]}: ${firstLine(r.stderr)}`);
    return String(r.stdout).trim();
  };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  g("init", "-q");
  const env = { ...a.env };
  if (a.source === "git") {
    g("fetch", "-q", "--depth", "1", "--no-tags", gitUrl(a), a.release.commit);
    g("checkout", "-q", "--detach", "FETCH_HEAD");
    if (g("rev-parse", "HEAD") !== a.release.commit) throw new Error("failed: the commit fetched is not the one pinned");
  } else {
    const ref = `${a.image}@${a.release.digest}`;
    const r = runner(["docker", "pull", "-q", ref]);
    if (r.status !== 0) throw new Error(`failed: docker pull: ${firstLine(r.stderr)}`);
    env.IMAGE = ref;
  }
  fs.mkdirSync(path.join(dir, ".argus"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".argus/live.json"), `${JSON.stringify(a.live, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, ".claude/sapu.json"), `${JSON.stringify(contractFor(a), null, 2)}\n`);
  fs.appendFileSync(path.join(dir, ".gitignore"), `\n${ENV_FILE}\n.argus/live/\n`);
  g("add", "-f", ".argus/live.json", ".claude/sapu.json", ".gitignore");
  g("commit", "-q", "--allow-empty", "-m", "taste calibration: the lane's live config");
  fs.writeFileSync(path.join(dir, ENV_FILE), Object.entries(env).map(([k, v]) => `${k}='${v}'\n`).join(""), { mode: 0o600 });
}

/** A screen's census per colour scheme → `[{theme, metrics}]`: light, and dark when the page answers it (censusOf's `dual`). */
export function themedMetrics(screen, bar) {
  const c = isObj(screen) && isObj(screen.census) ? screen.census : {};
  return ["light", "dark"]
    .filter((t) => isObj(c[t]))
    .map((theme) => ({ theme, metrics: metricsOf({ census: c[theme], reduce: c.reduce, ease: screen.ease }, bar) }))
    .filter((x) => Object.keys(x.metrics).length > 0);
}

/**
 * App `id` run and measured (spec: pinned, loopback only, numbers only, deleted): its temp dir under `tmpdir`, the
 * lane's `up` there (TMPDIR inside it, so the run's worktree and HOME are too), the login role signed in by the lane's
 * own login stage, each route at each width visited by `session` confined to the run's origins and measured by
 * `probes`, then `down`, the image removed and the temp dir deleted, whatever happened → `{rows, skipped, lines}`. A row
 * is `{url, site, archetype, width, metrics}`: `url` the app's release page, never the instance's address.
 */
async function measureApp(id, a, { session, probes, bar, deps }) {
  const { git = (args) => run(["git", ...args]), runner = run, exec = execAsync, gitUrl = (x) => `${x.repo}.git`, env: extra = {}, tmpdir = os.tmpdir() } = deps;
  const root = fs.mkdtempSync(path.join(tmpdir, `taste-local-${id}-`));
  const dir = path.join(root, "app");
  const env = { ...process.env, ...extra, TMPDIR: path.join(root, "tmp") };
  fs.mkdirSync(env.TMPDIR, { mode: 0o700 });
  const url = `${a.repo}/releases/tag/${encodeURIComponent(a.release.tag)}`;
  const rows = [];
  const skipped = [];
  const lines = [];
  const skip = (where, reason) => {
    skipped.push({ url: `${id}:${where}`, reason });
    lines.push(`skipped ${id} ${where}: ${reason}`);
  };
  let started = false;
  let pages = 0;
  try {
    prepare(a, dir, { git, runner, gitUrl });
    started = true;
    const u = await exec([process.execPath, ARGUS_LIVE, "up"], { cwd: dir, env });
    let up = null;
    try {
      up = u.code === 0 ? JSON.parse(u.stdout.trim().split("\n").at(-1)) : null;
    } catch {
      up = null;
    }
    if (!up || typeof up.baseUrl !== "string") throw new Error(`failed: the lane's up: ${firstLine(u.stderr || u.stdout)}`);
    const origins = up.origins.length ? up.origins : [new URL(up.baseUrl).origin];
    let storageState = null;
    if (a.login) {
      const { config, secrets } = loadLive(dir);
      const live = expandConfig(config, { ports: up.ports, secrets });
      const plan = loginPlan(live, a.login);
      const user = live.roles[a.login].users[0];
      const s = await session.signIn(loginCode("credentials", { url: plan.url, open: plan.open, user: user.user, password: user.password, loggedIn: plan.loggedIn, settleMs: plan.settleMs }), { origins });
      if (!s.storageState) throw new Error(`failed: ${a.login} could not sign in (${s.result && typeof s.result.state === "string" ? s.result.state : "no answer"})`);
      storageState = s.storageState;
    }
    const measure = async (page) => {
      try {
        return { screen: { census: await probes.census(page), ease: await probes.ease(page) } };
      } catch (e) {
        return { error: e && e.name ? String(e.name).slice(0, 40) : "error" };
      }
    };
    const base = new URL(up.baseUrl);
    for (const r of a.routes) {
      for (const width of WIDTHS) {
        const where = `${r.path} at ${width}`;
        const target = new URL(r.path, base);
        let v;
        try {
          v = await session.visit(target.href, measure, { viewport: { width, height: HEIGHT[width] }, storageState, origins });
        } catch (e) {
          skip(where, `the page did not load (${e && e.name ? String(e.name).slice(0, 40) : "error"})`);
          continue;
        }
        const final = v.finalUrl ? new URL(v.finalUrl) : null;
        if (!(v.status >= 200 && v.status < 300)) skip(where, `HTTP ${v.status}`);
        else if (!final || final.origin !== target.origin || final.pathname !== target.pathname) skip(where, "it redirected away from the route (a sign-in, or another page)");
        else if (v.result.error) skip(where, `the probes failed on it (${v.result.error})`);
        else {
          const themed = themedMetrics(v.result.screen, bar);
          if (!themed.length) skip(where, "the probes measured no metric of the bar");
          else {
            pages += 1;
            for (const t of themed) rows.push({ url, site: id, archetype: r.archetype, width, metrics: t.metrics });
          }
        }
      }
    }
  } catch (e) {
    const m = e && e.message ? String(e.message).split("\n")[0].slice(0, 300) : "an error";
    skip("(the app)", m.replace(/^failed: /, ""));
  } finally {
    const notes = [];
    if (started) {
      const d = await exec([process.execPath, ARGUS_LIVE, "down"], { cwd: dir, env });
      if (d.code !== 0) notes.push(`down: ${firstLine(d.stderr || d.stdout)}`);
    }
    if (a.source === "image") {
      const r = runner(["docker", "image", "rm", `${a.image}@${a.release.digest}`]);
      if (r.status !== 0) notes.push(`docker image rm: ${firstLine(r.stderr)}`);
    }
    fs.rmSync(root, { recursive: true, force: true });
    if (fs.existsSync(root)) notes.push(`${root} could not be deleted: delete it by hand`);
    const total = a.routes.length * WIDTHS.length;
    lines.push(`${id} ${a.release.tag}: measured ${pages} of ${total} pages (${plural(rows.length, "screen")}); ${notes.length ? `cleanup: ${notes.join("; ")}` : "its instance is down and its files deleted"}`);
  }
  return { rows, skipped, lines };
}

// ---------------------------------------------------------------------------------------------------
// The CLI's --local.

function planLines(m, bar, now) {
  const ids = Object.keys(m.apps);
  const status = Object.fromEntries(ids.map((id) => [id, appStatus(m.apps[id], { now, maxAge: m.max_age_months })]));
  const ready = ids.filter((id) => status[id].ready).length;
  const out = [
    "taste-calibrate --local: the plan (nothing fetched: --network fetches, runs and measures, on a maintainer's machine only)",
    `${plural(ids.length, "app")}: ${ready} ready, ${ids.length - ready} not; each ready app: ${ROUTE_MIX.app} app, ${ROUTE_MIX.form} form and ${ROUTE_MIX.data} data routes at widths ${WIDTHS.join(" and ")}, light and dark; a release older than ${m.max_age_months} months is unmaintained`,
  ];
  for (const id of ids) {
    const a = m.apps[id];
    const head = `${id} (${a.license}, ${a.source})`;
    if (!status[id].ready) out.push(`${head}: not ready: ${status[id].why}`);
    else {
      out.push(`${head}: ready: ${a.release.tag} (${a.release.published}), ${a.source === "git" ? `commit ${a.release.commit.slice(0, 12)}` : `image ${a.release.digest.slice(0, 19)}`}; ${plural(a.routes.length, "route")}`);
      for (const r of a.routes) out.push(`  ${r.path} (${r.archetype})`);
    }
  }
  const stale = new Set(staleBands(bar, now).map((x) => x.archetype));
  const entries = ARCHETYPES.filter((x) => bar.archetypes[x]).map((x) => `${x} calibrated ${bar.archetypes[x].calibrated}${stale.has(x) ? ` (stale: over ${STALE_MONTHS} months)` : ""}`);
  out.push(`the bar: ${entries.length ? entries.join(", ") : "no band yet"}`);
  return out;
}

/** Writes `value` as the manifest at `file` (a temp file renamed into place). */
function writeManifest(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

const unreachable = (e) => refused(`GitHub could not be reached (${e && e.message ? String(e.message).split("\n")[0].slice(0, 120) : "an error"})`);

/**
 * taste-calibrate.mjs main's `--local` (`opts` parsed there, `deps` its seams) → `{code, lines}`: `--refresh` pins the
 * manifest; without `--network`, the plan; with it, every ready app checked to be pinned at its latest release (else
 * refused before anything is fetched), then run and measured one at a time (measureApp), and the bands written into
 * the bar (writeBands: merged by archetype, numbers only).
 */
export async function mainLocal(opts, deps = {}) {
  const today = deps.today ?? Date.now;
  const m = readJson(opts.local, "the manifest");
  if (m.error) return { code: 1, lines: [m.error] };
  const manifest = validateManifest(m.value);
  if (!manifest.value) return { code: 1, lines: manifest.errors.map((e) => refused(`the manifest is broken: ${e}`)) };
  if (opts.refresh) {
    let r;
    try {
      r = await refreshManifest(manifest.value, { fetchJson: deps.fetchJson, runner: deps.runner, now: today() });
    } catch (e) {
      return { code: 1, lines: [unreachable(e) + ": the manifest is unchanged"] };
    }
    writeManifest(opts.local, r.manifest);
    const pinned = Object.values(r.manifest.apps).filter((a) => a.release).length;
    return { code: 0, lines: [...r.lines, `wrote ${opts.local}: ${plural(pinned, "app")} pinned, ${Object.keys(r.manifest.apps).length - pinned} rejected`] };
  }
  const b = readJson(opts.out, "the bar");
  if (b.error) return { code: 1, lines: [b.error] };
  const bar = validateBar(b.value);
  if (!bar.value) return { code: 1, lines: [refused(`the bar ${opts.out} is broken: ${bar.errors[0]}`)] };
  if (!opts.network) return { code: 0, lines: planLines(manifest.value, bar.value, today()) };

  const apps = Object.entries(manifest.value.apps).filter(([, a]) => appStatus(a, { now: today(), maxAge: manifest.value.max_age_months }).ready);
  if (!apps.length) return { code: 1, lines: [refused(`no app of the manifest is ready (a live config, ${Object.values(ROUTE_MIX).reduce((x, y) => x + y)} routes and a maintained release pinned): nothing fetched`)] };
  // Recalibration targets each app's latest release: a pin --refresh would move refuses the run.
  let latest;
  try {
    latest = await refreshManifest({ ...manifest.value, apps: Object.fromEntries(apps) }, { fetchJson: deps.fetchJson, runner: deps.runner, now: today() });
  } catch (e) {
    return { code: 1, lines: [unreachable(e) + ": nothing fetched"] };
  }
  for (const [id, a] of apps) {
    const now = latest.manifest.apps[id].release;
    if (!now) return { code: 1, lines: [refused(`--refresh now rejects ${id} (${latest.lines.find((l) => l.startsWith(`rejected ${id}:`)).slice(`rejected ${id}: `.length)}): nothing fetched`)] };
    if (now.tag !== a.release.tag || (now.commit ?? now.digest) !== (a.release.commit ?? a.release.digest)) return { code: 1, lines: [refused(`${id}'s latest release is ${now.tag}, but the manifest pins ${a.release.tag}: run --refresh, review its diff, then measure: nothing fetched`)] };
  }

  const probes = deps.probes || { census: censusOf, ease: easeOf };
  const lines = [];
  const measured = [];
  const skipped = [];
  const session = await (deps.openSession || openSession)();
  try {
    try {
      await session.blank(async (page) => ({ census: await probes.census(page), ease: await probes.ease(page) }));
    } catch (e) {
      const why = e && e.message ? String(e.message).split("\n")[0].slice(0, 160) : "an error";
      return { code: 1, lines: [refused(`the probes cannot measure a blank page (${why}): nothing was fetched`)] };
    }
    for (const [id, a] of apps) {
      const r = await measureApp(id, a, { session, probes, bar: bar.value, deps });
      measured.push(...r.rows);
      skipped.push(...r.skipped);
      lines.push(...r.lines);
    }
  } finally {
    await session.close();
  }
  const { archetypes, cut } = bandsOf(measured, { calibrated: monthOf(today()) });
  const why = numbersOnly(archetypes, screenMetrics(bar.value), new Set(apps.map(([, a]) => `${a.repo}/releases/tag/${encodeURIComponent(a.release.tag)}`)));
  if (why) return { code: 1, lines: [...lines, `failed: taste-calibrate: the output would hold a string that is not a URL or a metric name (${why}): nothing written`] };
  const attempted = new Set(apps.flatMap(([, a]) => a.routes.map((r) => r.archetype)));
  const written = writeBands({ out: opts.out, bar: bar.value, result: { measured, skipped, archetypes, cut }, attempted, diff: opts.diff, unit: "screen" });
  return { code: written.code, lines: [...lines, ...written.lines] };
}
