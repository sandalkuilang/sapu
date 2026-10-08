// argus-live-browser.mjs — the journey lane's browser driver (spec §9): the pinned @playwright/cli,
// installed once per machine from the lockfile the plugin ships (scripts/pw/) and run directly with
// node, in a clean environment; and the Chrome-family browser it drives. Nothing here is installed with
// the plugin: its own scripts import only `node:` modules.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redact, run, runAsync } from "./argus-live-proc.mjs";
import { liveRoot } from "./argus-live-run.mjs";

export const CLI_PACKAGE = "@playwright/cli";
export const CLI_VERSION = "0.1.22";

/** The plugin's pinned package: package.json (one exact dependency) and its package-lock.json. */
const PW_DIR = fileURLToPath(new URL("./pw/", import.meta.url));
const PW_FILES = ["package.json", "package-lock.json"];
const ENTRY = path.join("node_modules", "@playwright", "cli", "playwright-cli.js");

/** Where the pinned CLI is installed: `<root>/pw-<first 12 hex of sha256(package-lock.json)>`. */
export function cliInstallDir({ root = liveRoot() } = {}) {
  const lock = fs.readFileSync(path.join(PW_DIR, "package-lock.json"));
  return path.join(root, `pw-${createHash("sha256").update(lock).digest("hex").slice(0, 12)}`);
}

/** The CLI's `--version` (trimmed), or null when it cannot be run. */
function versionOf(js, runner) {
  if (!fs.existsSync(js)) return null;
  const r = runner([process.execPath, js, "--version"], { cwd: path.dirname(js), env: cliEnv(path.dirname(js)), timeout: 30_000 });
  return r.error ? null : String(r.stdout ?? "").trim();
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

/** `text` with secret values and URL credentials (`//user:pass@`) masked. */
const masked = (text, secrets) => redact(text, secrets).replace(/\/\/[^\s/@]+@/g, "//***@");

/**
 * The pinned CLI, installed when missing → {dir, js}. An install whose `--version` prints CLI_VERSION is
 * used as is. Else both pinned files are copied into `<dir>.tmp-<pid>`, `npm ci --ignore-scripts
 * --no-audit --no-fund --prefer-offline` runs there (the owner's environment minus NODE_OPTIONS, so npm
 * finds its cache), the result's `--version` is checked, and it is renamed into place (a concurrent
 * winner's directory is kept). Any failure → `refused: the pinned browser CLI (@playwright/cli <v>) cannot
 * be installed: <npm's error (npmError)>`, secrets and URL credentials masked, nothing left behind.
 */
export function ensureCli({ runner = run, ownerEnv = process.env, root, secrets = {} } = {}) {
  const dir = cliInstallDir(root === undefined ? {} : { root });
  const js = path.join(dir, ENTRY);
  if (versionOf(js, runner) === CLI_VERSION) return { dir, js };
  const refuse = (why) => new Error(`refused: the pinned browser CLI (${CLI_PACKAGE} ${CLI_VERSION}) cannot be installed: ${masked(why, secrets)}`);
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
    try {
      fs.renameSync(tmp, dir);
    } catch (e) {
      if (!e || (e.code !== "ENOTEMPTY" && e.code !== "EEXIST")) throw e;
      // Another install won the race, or a broken one sits there: keep a good one, else replace it.
      if (versionOf(js, runner) !== CLI_VERSION) {
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

/**
 * The CLI's whole environment: PATH, USER, SHELL, TMPDIR, LANG and the LC_* variables the owner set,
 * HOME = `home` (the run's `<HOME>/browser`, so neither the owner's global CLI config nor its caches are
 * read), NO_UPDATE_NOTIFIER=1 (no registry call). Never PLAYWRIGHT_*, PWTEST_*, NODE_OPTIONS or XDG_*.
 */
export function cliEnv(home, ownerEnv = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(ownerEnv)) {
    if (typeof v === "string" && (["PATH", "USER", "SHELL", "TMPDIR", "LANG"].includes(k) || /^LC_[A-Z_]+$/.test(k))) env[k] = v;
  }
  return { ...env, HOME: home, NO_UPDATE_NOTIFIER: "1" };
}

/**
 * One CLI call: `node <js> -s=<session> ...args` in `cwd` (the slot's directory: its `.playwright/`
 * scopes the CLI's config and session namespace), under cliEnv(home), in its own process group, killed
 * with whatever it left in that group when it exits or at `timeoutMs` (the daemon `open` starts is
 * detached into a group of its own, so it stays) → {code, stdout, stderr, timedOut}.
 */
export async function runCli({ js, session, args, cwd, home, timeoutMs = 60_000, runner = runAsync }) {
  const r = await runner([process.execPath, js, `-s=${session}`, ...args], { cwd, env: cliEnv(home), timeoutMs, stdio: ["ignore", "pipe", "pipe"], capture: true, killAfter: true });
  if (r.error) throw new Error(`failed: the browser CLI could not run: ${r.error.message}`);
  return { code: r.status ?? null, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: Boolean(r.timedOut) };
}
