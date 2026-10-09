// argus-live-browser.mjs — the journey lane's browser driver (spec §9): the pinned @playwright/cli,
// installed once per user in the user's cache from the lockfile the plugin ships (scripts/pw/), checked
// by a manifest on every use, and run directly with node (argus-live-cli.mjs runs it, in a clean
// environment); and the Chrome-family browser it drives. Nothing here is installed with the plugin: its
// own scripts import only `node:` modules.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cliEnv, closeSessions, runCli, sessionName, sweepSessions } from "./argus-live-cli.mjs";
import { liveDir, runIdOk } from "./argus-live-lock.mjs";
import { processTable, redact, run, runAsync, within } from "./argus-live-proc.mjs";
import { ownDir, updateRun } from "./argus-live-run.mjs";

export const CLI_PACKAGE = "@playwright/cli";
export const CLI_VERSION = "0.1.22";

/** The plugin's pinned package: package.json (one exact dependency) and its package-lock.json. */
const PW_DIR = fileURLToPath(new URL("./pw/", import.meta.url));
const PW_FILES = ["package.json", "package-lock.json"];
const ENTRY = path.join("node_modules", "@playwright", "cli", "playwright-cli.js");
/** What an install holds, written once it is complete and checked on every use. */
const MANIFEST = ".sapu-manifest.json";

/**
 * The user's own cache for the CLI, outside TMPDIR (macOS prunes `$TMPDIR` file by file, which would
 * leave an install that starts and then fails): macOS `~/Library/Caches/sapu`, else
 * `$XDG_CACHE_HOME/sapu` (an absolute one) or `~/.cache/sapu`.
 */
export function cliCacheRoot({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === "darwin") return path.join(home, "Library", "Caches", "sapu");
  const xdg = env.XDG_CACHE_HOME;
  return path.join(typeof xdg === "string" && path.isAbsolute(xdg) ? xdg : path.join(home, ".cache"), "sapu");
}

/** Where the pinned CLI is installed: `<root>/pw-<first 12 hex of sha256(package-lock.json)>`. */
export function cliInstallDir({ root = cliCacheRoot() } = {}) {
  const lock = fs.readFileSync(path.join(PW_DIR, "package-lock.json"));
  return path.join(root, `pw-${createHash("sha256").update(lock).digest("hex").slice(0, 12)}`);
}

/** The CLI's `--version` (trimmed), or null when it cannot be run. */
function versionOf(js, runner) {
  if (!fs.existsSync(js)) return null;
  const r = runner([process.execPath, js, "--version"], { cwd: path.dirname(js), env: cliEnv(os.tmpdir()), timeout: 30_000 });
  return r.error ? null : String(r.stdout ?? "").trim();
}

/** Every entry under `dir` but the manifest, sorted: files as {path, size, sha256}, symlinks as {path, link}. */
function listing(dir) {
  const out = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (r === MANIFEST) continue;
      const p = path.join(dir, r);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(r);
      else if (st.isSymbolicLink()) out.push({ path: r, link: fs.readlinkSync(p) });
      else out.push({ path: r, size: st.size, sha256: createHash("sha256").update(fs.readFileSync(p)).digest("hex") });
    }
  };
  walk("");
  return out;
}

/** True when `dir` holds exactly what its manifest lists (no file missing, changed or added). */
function intact(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8"));
    return JSON.stringify(m.files) === JSON.stringify(listing(dir));
  } catch {
    return false;
  }
}

/** Removes `pw-*.tmp-<pid>` installs under `root` whose process is gone (an install that died midway). */
function removeStaleTemps(root) {
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const m = /^pw-[0-9a-f]{12}\.tmp-(\d+)$/.exec(name);
    if (!m) continue;
    try {
      process.kill(Number(m[1]), 0);
      continue; // still installing (or the pid is someone else's now: left alone)
    } catch (e) {
      if (e && e.code === "EPERM") continue;
    }
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}

/**
 * npm's error, in one line: the last line of its stderr that says something — not the pointer to its
 * debug log, a stack frame, an error object's fields or the proxy hint it prints after every network
 * error.
 */
function npmError(stderr) {
  const noise = /A complete log of this run|^npm (error|ERR!)\s*$|^npm (error|ERR!)\s+(at |code |syscall |errno |[a-z]+: |[{}]|If you are behind a proxy)/;
  const lines = String(stderr ?? "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
  const said = lines.filter((l) => !noise.test(l));
  return (said.pop() || lines.pop() || "").slice(0, 300);
}

/** `text` with secret values and URL credentials masked (`scheme://<anything>@` up to the last `@`, so a password holding `/` or `@` goes too). */
const masked = (text, secrets) => redact(text, secrets).replace(/([a-z][a-z0-9+.-]*:)?\/\/\S*@/gi, "$1//***@");

/**
 * The pinned CLI, installed when missing or not intact → {dir, js}. `<root>` (cliCacheRoot) is this
 * user's own directory (0700, never a symlink; refused inside the repo `realMain`). An install whose
 * manifest matches every file and whose `--version` prints CLI_VERSION is used as is. Else stale temp
 * installs are removed, both pinned files are copied into `<dir>.tmp-<pid>`, `npm ci --ignore-scripts
 * --no-audit --no-fund --prefer-offline` runs there (the owner's environment minus NODE_OPTIONS, so npm
 * finds its cache), the result's `--version` is checked, its manifest (path, size and sha256 of every
 * file) written, and it is renamed into place (a concurrent winner's intact install is kept). Any
 * failure → `refused: the pinned browser CLI (@playwright/cli <v>) cannot be installed: <npm's error
 * (npmError)>`, secrets and URL credentials masked, nothing left behind.
 */
export function ensureCli({ runner = run, ownerEnv = process.env, root = cliCacheRoot(), realMain = null, secrets = {} } = {}) {
  const inRepo = (p) => realMain && within(realMain, p);
  const tooClose = () => new Error(`refused: the browser CLI's cache ${root} would lie inside the repo`);
  if (inRepo(path.resolve(root))) throw tooClose();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  ownDir(root);
  if (inRepo(fs.realpathSync.native(root))) throw tooClose();
  const dir = cliInstallDir({ root });
  const js = path.join(dir, ENTRY);
  const ready = () => intact(dir) && versionOf(js, runner) === CLI_VERSION;
  if (ready()) return { dir, js };
  const refuse = (why) => new Error(`refused: the pinned browser CLI (${CLI_PACKAGE} ${CLI_VERSION}) cannot be installed: ${masked(why, secrets)}`);
  removeStaleTemps(root);
  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    fs.mkdirSync(tmp, { mode: 0o700 });
    for (const f of PW_FILES) fs.copyFileSync(path.join(PW_DIR, f), path.join(tmp, f));
    const { NODE_OPTIONS: _drop, ...env } = ownerEnv;
    const r = runner(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], { cwd: tmp, env, timeout: 600_000 });
    if (r.error || r.status !== 0) {
      throw refuse(npmError(r.stderr) || (r.error ? r.error.message : `npm ci exited ${r.status}`));
    }
    const got = versionOf(path.join(tmp, ENTRY), runner);
    if (got !== CLI_VERSION) throw refuse(`its --version printed ${got || "nothing"}`);
    fs.writeFileSync(path.join(tmp, MANIFEST), `${JSON.stringify({ package: CLI_PACKAGE, version: CLI_VERSION, files: listing(tmp) })}\n`, { mode: 0o600 });
    try {
      fs.renameSync(tmp, dir);
    } catch (e) {
      if (!e || (e.code !== "ENOTEMPTY" && e.code !== "EEXIST")) throw e;
      // Another install won the race, or a broken one sits there: keep an intact one, else replace it.
      if (!ready()) {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.renameSync(tmp, dir);
      }
    }
    return { dir, js };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("refused: ")) throw e;
    throw refuse(e && e.message ? e.message : String(e));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Where a Chrome-family browser lives, per platform, in the order they are preferred. */
const BROWSERS = {
  darwin: [
    { channel: "chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    { channel: "msedge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
  ],
  linux: [
    { channel: "chrome", path: "/opt/google/chrome/chrome" },
    { channel: "msedge", path: "/opt/microsoft/msedge/msedge" },
  ],
};

/** The installed Chrome-family browser → {channel, path} (Google Chrome first, then Microsoft Edge), or null. */
export function findChrome({ platform = process.platform, exists = fs.existsSync } = {}) {
  return (BROWSERS[platform] || []).find((b) => exists(b.path)) || null;
}

/** A slot: a positive integer (an explorer's), or `up` (the proving logins of `up`). */
const SLOT = (slot) => (Number.isInteger(slot) && slot > 0) || slot === "up";

/** A slot's directory, `<MAIN>/.argus/live/<runId>/<slot>`: the CLI's cwd, so its workspace and session namespace. */
export function slotDir(main, runId, slot) {
  runIdOk(runId);
  if (!SLOT(slot)) throw new Error(`failed: ${slot} is not a slot (a positive integer, or up)`);
  return path.join(liveDir(main), runId, String(slot));
}

/**
 * The init script every page and popup of a slot's sessions runs (spec §7, short-lived signals): it
 * watches elements with role=status, role=alert or aria-live (polite or assertive) for their text and
 * wraps window.Notification; each signal {kind, text (at most 200 characters), t} is pushed onto the
 * page's `window.__argusSignals` (at most 200) and logged as `console.info("[argus-signal]", <json>)`, so
 * a toast gone before the next snapshot is still seen. Probed: Chrome runs init scripts in a popup's first
 * document (about:blank) but not in the page it then navigates to, which keeps that window; so the script
 * also wraps window.open and watches the popup's document from the opener once it is no longer about:blank
 * (same origin only: a cross-origin popup is outside the run anyway). A popup a link opened (target=_blank
 * rel=opener) has no such hook: `pw`'s observation evaluates this script again in every page (each
 * evaluation watches the current document once; the wrappers go on once per window), so it is watched from
 * the next call on, and a signal it raised before that is not seen.
 */
export const SIGNAL_SCRIPT = `(() => {
  const kindOf = (el) => {
    if (!el || el.nodeType !== 1) return null;
    const role = el.getAttribute("role");
    if (role === "status" || role === "alert") return role;
    const live = el.getAttribute("aria-live");
    return live === "polite" || live === "assertive" ? "live" : null;
  };
  // Watches win's current document once; the signals go to win's own buffer.
  const watch = (win) => {
    let doc;
    try {
      doc = win.document;
    } catch (e) {
      return true;
    }
    if (!doc || !doc.documentElement) return false;
    if (doc.__argusSignalsWatched) return true;
    doc.__argusSignalsWatched = true;
    const buffer = (win.__argusSignals = win.__argusSignals || []);
    const push = (kind, text) => {
      const t = String(text == null ? "" : text).replace(/\\s+/g, " ").trim().slice(0, 200);
      if (!t) return;
      const signal = { kind, text: t, t: Date.now() };
      if (buffer.length < 200) buffer.push(signal);
      try {
        win.console.info("[argus-signal]", JSON.stringify(signal));
      } catch (e) {}
    };
    win.__argusSignalPush = push;
    const last = new WeakMap();
    const report = (el) => {
      const kind = kindOf(el);
      if (!kind) return;
      const text = el.textContent;
      if (last.get(el) === text) return;
      last.set(el, text);
      push(kind, text);
    };
    const region = (node) => {
      for (let p = node && node.nodeType === 1 ? node : node && node.parentElement; p; p = p.parentElement) if (kindOf(p)) return p;
      return null;
    };
    const scan = (node) => {
      if (!node || node.nodeType !== 1) return;
      report(node);
      node.querySelectorAll("[role=status],[role=alert],[aria-live]").forEach(report);
    };
    scan(doc.documentElement);
    new MutationObserver((records) => {
      for (const m of records) {
        if (m.type === "childList") m.addedNodes.forEach(scan);
        const r = region(m.target);
        if (r) report(r);
      }
    }).observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["role", "aria-live"] });
    return true;
  };
  // Every evaluation watches the current document (once per document); the wrappers below go on once per
  // window: a popup keeps the window of its about:blank, where the init script ran, for its next document.
  if (!watch(window)) document.addEventListener("DOMContentLoaded", () => watch(window));
  if (window.__argusSignalsInstalled) return;
  window.__argusSignalsInstalled = true;
  const nativeOpen = window.open;
  if (typeof nativeOpen === "function") {
    window.open = function (...args) {
      const w = nativeOpen.apply(this, args);
      const since = Date.now();
      const poll = () => {
        try {
          if (!w || w.closed) return;
          if (w.document.URL !== "about:blank" && watch(w)) return;
        } catch (e) {
          return;
        }
        if (Date.now() - since < 60000) setTimeout(poll, 5);
      };
      poll();
      return w;
    };
  }
  const Native = window.Notification;
  if (typeof Native === "function") {
    const Wrapped = function (title, options) {
      const push = window.__argusSignalPush;
      if (push) push("notification", String(title) + (options && options.body ? ": " + options.body : ""));
      return new Native(title, options);
    };
    Wrapped.prototype = Native.prototype;
    Wrapped.requestPermission = (...a) => Native.requestPermission(...a);
    Object.defineProperty(Wrapped, "permission", { get: () => Native.permission });
    window.Notification = Wrapped;
  }
})();
`;

/**
 * Chrome switches that keep its own background services off the network (probed with 0.1.22's Chrome:
 * without them a fresh profile reaches accounts.google.com, android.clients.google.com,
 * update.googleapis.com, www.google.com and www.gstatic.com through the run's proxy, which blocks and logs
 * them). The service URLs Chrome still asks for (sign-in, push messaging, component updates) point at the
 * discard port on loopback, which the proxy refuses. Chrome keeps the last `--disable-features`, so this
 * one repeats the list Playwright (1.64) passes and adds the services found. One www.gstatic.com
 * connection at start-up remains: the login and blocked-origin judgements read the page's own requests.
 */
const OFF = "http://127.0.0.1:9";
const PLAYWRIGHT_DISABLED = ["AvoidUnnecessaryBeforeUnloadCheckSync", "DestroyProfileOnBrowserClose", "DialMediaRouteProvider", "GlobalMediaControls", "HttpsUpgrades", "LensOverlay", "MediaRouter", "PaintHolding", "ThirdPartyStoragePartitioning", "BlockOriginHeaderModificationOnRedirect", "Translate", "AutoDeElevate", "OptimizationHints", "NetworkTimeServiceQuerying", "AimEnabled", "msForceBrowserSignIn", "msEdgeUpdateLaunchServicesPreferredVersion"];
const QUIET_DISABLED = ["AutofillServerCommunication", "OptimizationGuideModelDownloading", "OptimizationHintsFetching", "OptimizationGuideOnDeviceModel", "OnDeviceModelPerformanceParams", "CertificateTransparencyComponentUpdater", "InterestFeedContentSuggestions", "SearchPrefetchServicePrefetching", "PrefetchProxy", "PreconnectToSearch", "NavigationPredictor", "PrivacySandboxSettings4", "ChromeWhatsNewUI", "SafeBrowsingRealTimeUrlLookup"];
export const CHROME_QUIET = [
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--no-pings",
  "--disable-domain-reliability",
  "--disable-client-side-phishing-detection",
  `--gaia-url=${OFF}`,
  `--google-base-url=${OFF}`,
  `--gcm-checkin-url=${OFF}`,
  `--gcm-registration-url=${OFF}`,
  `--gcm-mcs-endpoint=${OFF}`,
  `--component-updater=url-source=${OFF}`,
  `--disable-features=${[...PLAYWRIGHT_DISABLED, ...QUIET_DISABLED].join(",")}`,
];

/**
 * The CLI config of the slot in `dir` (spec §9 per-slot config; key paths as 0.1.22 reads them): Chrome
 * (`chrome.channel`) headless and isolated, every request through the run's proxy (no `proxy.bypass`:
 * Playwright then adds `<-loopback>`, so loopback goes through it too), host names other than the run's
 * and `allow_origins`' resolving to nothing, WebRTC kept off non-proxied UDP, Chrome's own background
 * services off (CHROME_QUIET), the run's locale, time zone
 * and first viewport width (else en-US, UTC, 1440), service workers blocked, the signal script in every
 * page, `network.allowedOrigins` = the run's origins and `allow_origins`, output under `<dir>/out`.
 */
export function slotConfig({ dir, origins, allowOrigins = [], proxyPort, live = {}, chrome }) {
  // The proxy's own address too: the rules apply to every host Chrome connects to, its proxy included.
  const hosts = [...new Set(["127.0.0.1", ...[...origins, ...allowOrigins].map((o) => new URL(o).hostname)])];
  return {
    browser: {
      browserName: "chromium",
      isolated: true,
      launchOptions: {
        channel: chrome.channel,
        headless: true,
        proxy: { server: `http://127.0.0.1:${proxyPort}` },
        args: [`--host-resolver-rules=MAP * ~NOTFOUND, ${hosts.map((h) => `EXCLUDE ${h}`).join(", ")}`, "--webrtc-ip-handling-policy=disable_non_proxied_udp", "--force-webrtc-ip-handling-policy", ...CHROME_QUIET],
      },
      contextOptions: { locale: live.locale || "en-US", timezoneId: live.timezone || "UTC", serviceWorkers: "block", viewport: { width: (live.viewports ?? [])[0] || 1440, height: 900 } },
      initScript: [path.join(dir, ".playwright", "signals.js")],
    },
    outputDir: path.join(dir, "out"),
    network: { allowedOrigins: [...origins, ...allowOrigins] },
    timeouts: { idle: 1_800_000 },
    allowUnrestrictedFileAccess: false,
    console: { level: "info" },
  };
}

/** Writes a slot's CLI config and signal script (0600) under `<dir>/.playwright/`, and creates `out/` and `files/` (all 0700). */
export function writeSlotConfig(dir, cfg) {
  for (const d of [dir, path.join(dir, ".playwright"), path.join(dir, "out"), path.join(dir, "files")]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.chmodSync(d, 0o700);
  }
  const put = (name, text) => {
    const file = path.join(dir, ".playwright", name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  put("cli.config.json", `${JSON.stringify(cfg, null, 2)}\n`);
  put("signals.js", SIGNAL_SCRIPT);
}

/** `{pid, pgid, started}` of a process-table row. */
const identity = (p) => (p ? { pid: p.pid, pgid: p.pgid, started: p.started } : null);

/** run.json `sessions` with `record` in place of the one of its name (appended when there is none); null drops that name. */
function putSession(main, runId, name, record) {
  return updateRun(main, runId, (prev) => (prev ? { ...prev, sessions: [...(prev.sessions ?? []).filter((x) => !x || x.name !== name), ...(record ? [record] : [])] } : undefined), { create: false });
}

/**
 * Opens account `account`'s CLI session in slot `slot` (`open`, in the slot's directory, under the
 * run's browser HOME) → the record `{name, slot, account, cwd, home, daemon, browser}`, kept in run.json
 * `sessions` (through updateRun) from before `open` runs: a session that starts and is never recorded
 * would outlive every teardown. With `storageState` (a file: a login command's state), the slot config
 * plus `browser.contextOptions.storageState` goes into `.playwright/<session>.config.json`, passed as
 * `open --config=<file>`; both files are removed once `open` returned. The daemon is the process whose
 * command runs playwright-core's `cliDaemon.js <session>`, the browser its child (Chrome's root, which
 * leads a process group of its own); each recorded by {pid, pgid, started}, which the teardown's kills
 * ask first. An `open` that fails or times out, or a daemon not in ps, closes the session by name and
 * sweeps what it left (sweepSessions), drops the record, and throws; run.json gone or sealed before
 * `open` throws with nothing started.
 */
export async function openSession({ main, runId, slot, account, js, home, storageState = null, runner = run, cliRunner = runAsync, timeoutMs = 60_000 }) {
  const dir = slotDir(main, runId, slot);
  const name = sessionName(runId, slot, account);
  const pending = { name, slot, account, cwd: dir, home, daemon: null, browser: null };
  try {
    if (!putSession(main, runId, name, pending)) throw new Error(`failed: run.json of cycle ${runId} is gone; the session ${name} was not opened`);
  } catch (e) {
    for (const f of [storageState]) if (f) fs.rmSync(f, { force: true });
    throw e;
  }
  const undo = async (failure) => {
    await closeSessions([pending], { js, runner, cliRunner, graceMs: 3000 });
    await sweepSessions({ match: (n) => n === name, runner, graceMs: 3000 });
    try {
      putSession(main, runId, name, null);
    } catch {
      // sealed or gone: the teardown closes what the record names
    }
    return failure;
  };
  let args = ["open"];
  let config = null;
  try {
    if (storageState) {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".playwright", "cli.config.json"), "utf8"));
      cfg.browser.contextOptions = { ...cfg.browser.contextOptions, storageState };
      config = path.join(dir, ".playwright", `${name}.config.json`);
      fs.writeFileSync(config, JSON.stringify(cfg), { mode: 0o600 });
      args = ["open", `--config=${config}`];
    }
    const r = await runCli({ js, session: name, args, cwd: dir, home, timeoutMs, runner: cliRunner });
    if (r.code !== 0) {
      const why = `${r.stdout}\n${r.stderr}`.split("\n").map((l) => l.trim()).filter((l) => /error/i.test(l)).pop() || (r.timedOut ? "timed out" : `exit ${r.code}`);
      throw new Error(`failed: the browser session ${name} could not open: ${why.slice(0, 300)}`);
    }
  } catch (e) {
    throw await undo(e);
  } finally {
    for (const f of [config, storageState]) if (f) fs.rmSync(f, { force: true });
  }
  const table = processTable(runner);
  const daemonOf = new RegExp(`/cliDaemon\\.js ${name.replace(/[^A-Za-z0-9]/g, "\\$&")}(\\s|$)`);
  const daemon = table.find((p) => daemonOf.test(p.command));
  const children = daemon ? table.filter((p) => p.ppid === daemon.pid) : [];
  const browser = children.find((p) => p.pgid === p.pid) || children[0] || null;
  const record = { ...pending, daemon: identity(daemon), browser: identity(browser) };
  if (!daemon) throw await undo(new Error(`failed: the browser session ${name} opened but its daemon is not in ps; closed again`));
  try {
    putSession(main, runId, name, record);
  } catch (e) {
    await closeSessions([record], { js, runner, cliRunner, graceMs: 3000 });
    throw e;
  }
  return record;
}
