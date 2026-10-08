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
import { cliEnv } from "./argus-live-cli.mjs";
import { redact, run, within } from "./argus-live-proc.mjs";
import { ownDir } from "./argus-live-run.mjs";

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
