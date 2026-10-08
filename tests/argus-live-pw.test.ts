// tests/argus-live-pw.test.ts — the journey lane's browser side without a browser (argus-live-browser,
// -fence, -targets, -config's browser keys, and later the proxy, slots, pw and return): a CLI shim stands
// in for @playwright/cli wherever a command would reach it.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanTemps, tempDir } from "./helpers/argus-live";
// @ts-expect-error — plain ESM script without types
import { CLI_PACKAGE, CLI_VERSION, cliEnv, cliInstallDir, ensureCli, findChrome, runCli } from "../plugins/sapu/scripts/argus-live-browser.mjs";

type Obj = Record<string, any>;

afterEach(cleanTemps);

const PW_DIR = join(__dirname, "../plugins/sapu/scripts/pw");

/**
 * The CLI shim: a Node script standing in for playwright-cli.js. Each call appends `{argv, cwd, env}` as
 * one JSON line to `<shim>.calls`; `goto` answers a page, `run-code` the next line of `<shim>.queue`,
 * anything else a fixed line.
 */
const makeShim = (dir = tempDir()) => {
  const shim = join(dir, "shim.mjs");
  writeFileSync(
    shim,
    `import fs from "node:fs";
const self = new URL(import.meta.url).pathname;
const argv = process.argv.slice(2);
fs.appendFileSync(self + ".calls", JSON.stringify({ argv, cwd: process.cwd(), env: process.env }) + "\\n");
const cmd = argv.find((a) => !a.startsWith("-"));
if (cmd === "goto") {
  const url = argv[argv.indexOf("--") + 1];
  process.stdout.write("### Page\\n- Page URL: " + url + "\\n");
} else if (cmd === "run-code") {
  const q = self + ".queue";
  const lines = fs.existsSync(q) ? fs.readFileSync(q, "utf8").split("\\n").filter(Boolean) : [];
  process.stdout.write("### Result\\n" + (lines.shift() ?? "null") + "\\n");
  fs.writeFileSync(q, lines.map((l) => l + "\\n").join(""));
} else {
  process.stdout.write("ok " + cmd + "\\n");
}
`,
  );
  const calls = (): Obj[] => (existsSync(`${shim}.calls`) ? readFileSync(`${shim}.calls`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { shim, calls };
};

/**
 * A fake `npm` on PATH: records its argv in `<dir>/npm.calls` and, for `ci`, creates the CLI entry point
 * printing `version` for `--version` — or fails as `fail` says.
 */
const fakeNpm = ({ version = "0.1.22", fail = "" }: { version?: string; fail?: string } = {}) => {
  const bin = tempDir();
  const npm = join(bin, "npm");
  writeFileSync(
    npm,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(join(bin, "npm.calls"))}
${fail ? `echo 'npm WARN something else' >&2\ncat ${JSON.stringify(join(bin, "npm.stderr"))} >&2\nexit 1` : ""}
mkdir -p node_modules/@playwright/cli
printf 'if (process.argv.includes("--version")) console.log("${version}");\\n' > node_modules/@playwright/cli/playwright-cli.js
`,
  );
  chmodSync(npm, 0o755);
  writeFileSync(join(bin, "npm.stderr"), `${fail}\n`);
  const ownerEnv = { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, NODE_OPTIONS: "--require /nonexistent-preload.js" };
  const calls = () => (existsSync(join(bin, "npm.calls")) ? readFileSync(join(bin, "npm.calls"), "utf8").trim().split("\n").filter(Boolean) : []);
  return { ownerEnv, calls };
};

describe("argus-live browser — the pinned CLI", () => {
  it("the lockfile pins @playwright/cli 0.1.22 and an integrity for every package", () => {
    const pkg = JSON.parse(readFileSync(join(PW_DIR, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(PW_DIR, "package-lock.json"), "utf8"));
    expect(CLI_PACKAGE).toBe("@playwright/cli");
    expect(CLI_VERSION).toBe("0.1.22");
    expect(pkg.dependencies).toEqual({ "@playwright/cli": "0.1.22" });
    expect(Object.keys(pkg).sort()).toEqual(["dependencies", "name", "private"]);
    expect(lock.name).toBe(pkg.name);
    expect(lock.packages[""].dependencies).toEqual({ "@playwright/cli": "0.1.22" });
    const deps = Object.entries(lock.packages as Record<string, Obj>).filter(([k]) => k !== "");
    expect(deps.map(([k]) => k).sort()).toEqual(["node_modules/@playwright/cli", "node_modules/playwright", "node_modules/playwright-core"]);
    for (const [, p] of deps) {
      expect(p.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/); // exact, no range
      expect(p.resolved).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(p.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
      expect(p.hasInstallScript).toBeUndefined();
      for (const v of Object.values((p.dependencies ?? {}) as Record<string, string>)) expect(v).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    }
    expect(lock.packages["node_modules/@playwright/cli"].version).toBe("0.1.22");
  });

  it("ensureCli installs once into a directory keyed by the lockfile", () => {
    const root = tempDir();
    const npm = fakeNpm();
    const a = ensureCli({ root, ownerEnv: npm.ownerEnv });
    expect(npm.calls()).toEqual(["ci --ignore-scripts --no-audit --no-fund --prefer-offline"]);
    expect(a.dir).toBe(cliInstallDir({ root }));
    expect(a.dir).toMatch(/\/pw-[0-9a-f]{12}$/);
    expect(a.js).toBe(join(a.dir, "node_modules/@playwright/cli/playwright-cli.js"));
    // Both pinned files are what npm ci read.
    expect(readFileSync(join(a.dir, "package-lock.json"), "utf8")).toBe(readFileSync(join(PW_DIR, "package-lock.json"), "utf8"));
    const b = ensureCli({ root, ownerEnv: npm.ownerEnv });
    expect(b).toEqual(a);
    expect(npm.calls()).toHaveLength(1);
    expect(readdirSync(root)).toEqual([a.dir.split("/").pop()]);
  });

  it("ensureCli refuses, naming the package, when npm fails (offline, empty cache)", () => {
    const root = tempDir();
    const npm = fakeNpm({ fail: "npm ERR! network request failed" });
    expect(() => ensureCli({ root, ownerEnv: npm.ownerEnv })).toThrow(/^refused: the pinned browser CLI \(@playwright\/cli 0\.1\.22\) cannot be installed: npm ERR! network request failed$/);
    expect(readdirSync(root)).toEqual([]);
  });

  it("ensureCli names npm's error, not the pointer to its debug log", () => {
    const root = tempDir();
    const npm = fakeNpm({ fail: "npm error FetchError: request to http://127.0.0.1:9/x.tgz failed, reason: connect ECONNREFUSED\nnpm error   code: 'ECONNREFUSED',\nnpm error }\nnpm error\nnpm error If you are behind a proxy, please make sure that the 'proxy' config is set properly.\nnpm error A complete log of this run can be found in: /x/_logs/debug-0.log" });
    expect(() => ensureCli({ root, ownerEnv: npm.ownerEnv })).toThrow(/cannot be installed: npm error FetchError: request to http:\/\/127\.0\.0\.1:9\/x\.tgz failed, reason: connect ECONNREFUSED$/);
  });

  it("ensureCli masks secret values in npm's error", () => {
    const root = tempDir();
    const npm = fakeNpm({ fail: "npm ERR! 401 https://user:t0ken-9x@registry.example.test/ s3cret-v" });
    expect(() => ensureCli({ root, ownerEnv: npm.ownerEnv, secrets: { TOKEN: "s3cret-v" } })).toThrow(/cannot be installed: npm ERR! 401 https:\/\/\*\*\*@registry\.example\.test\/ \*\*\*$/);
  });

  it("ensureCli refuses a CLI whose --version is not the pinned one", () => {
    const root = tempDir();
    const npm = fakeNpm({ version: "0.1.23" });
    expect(() => ensureCli({ root, ownerEnv: npm.ownerEnv })).toThrow(/^refused: the pinned browser CLI \(@playwright\/cli 0\.1\.22\) cannot be installed: its --version printed 0\.1\.23$/);
    expect(readdirSync(root)).toEqual([]);
  });

  it("ensureCli reinstalls over an install whose --version is wrong", () => {
    const root = tempDir();
    const dir = cliInstallDir({ root });
    mkdirSync(join(dir, "node_modules/@playwright/cli"), { recursive: true });
    writeFileSync(join(dir, "node_modules/@playwright/cli/playwright-cli.js"), 'console.log("0.0.1");\n');
    const npm = fakeNpm();
    expect(ensureCli({ root, ownerEnv: npm.ownerEnv }).dir).toBe(dir);
    expect(npm.calls()).toHaveLength(1);
    expect(readdirSync(root)).toEqual([dir.split("/").pop()]);
  });

  it("findChrome takes Chrome, then Edge, else null", () => {
    const CHROME_MAC = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const EDGE_MAC = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    const has = (...paths: string[]) => (p: string) => paths.includes(p);
    expect(findChrome({ platform: "darwin", exists: has(CHROME_MAC, EDGE_MAC) })).toEqual({ channel: "chrome", path: CHROME_MAC });
    expect(findChrome({ platform: "darwin", exists: has(EDGE_MAC) })).toEqual({ channel: "msedge", path: EDGE_MAC });
    expect(findChrome({ platform: "darwin", exists: has() })).toBeNull();
    expect(findChrome({ platform: "linux", exists: has("/opt/google/chrome/chrome", "/opt/microsoft/msedge/msedge") })).toEqual({ channel: "chrome", path: "/opt/google/chrome/chrome" });
    expect(findChrome({ platform: "linux", exists: has("/opt/microsoft/msedge/msedge") })).toEqual({ channel: "msedge", path: "/opt/microsoft/msedge/msedge" });
    expect(findChrome({ platform: "linux", exists: has(CHROME_MAC) })).toBeNull();
    expect(findChrome({ platform: "win32", exists: () => true })).toBeNull();
  });

  it("cliEnv carries no PLAYWRIGHT_*, PWTEST_*, NODE_OPTIONS or XDG_* and sets NO_UPDATE_NOTIFIER", () => {
    const ownerEnv = {
      PATH: "/usr/bin:/bin",
      USER: "u",
      SHELL: "/bin/sh",
      TMPDIR: "/tmp/x",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      LC_CTYPE: "UTF-8",
      HOME: "/owner-home",
      PLAYWRIGHT_CLI_SESSION: "x",
      PLAYWRIGHT_BROWSERS_PATH: "/x",
      PWTEST_CLI_GLOBAL_CONFIG: "/x",
      PWTEST_DAEMON_SESSION_DIR: "/x",
      NODE_OPTIONS: "--require /x",
      XDG_CACHE_HOME: "/x",
      AWS_SECRET: "x",
      CI: "1",
    };
    expect(cliEnv("/run/home/browser", ownerEnv)).toEqual({ PATH: "/usr/bin:/bin", USER: "u", SHELL: "/bin/sh", TMPDIR: "/tmp/x", LANG: "en_US.UTF-8", LC_ALL: "C", LC_CTYPE: "UTF-8", HOME: "/run/home/browser", NO_UPDATE_NOTIFIER: "1" });
    expect(cliEnv("/h", { PATH: "/bin" })).toEqual({ PATH: "/bin", HOME: "/h", NO_UPDATE_NOTIFIER: "1" });
  });

  it("runCli passes -s=<session> first and runs in cwd with cliEnv", async () => {
    const { shim, calls } = makeShim();
    const cwd = tempDir();
    const home = tempDir();
    const r = await runCli({ js: shim, session: "r1-1-buyer.1", args: ["goto", "--", "http://localhost:1/x"], cwd, home });
    expect(r).toEqual({ code: 0, stdout: "### Page\n- Page URL: http://localhost:1/x\n", stderr: "", timedOut: false });
    const [c] = calls();
    expect(c.argv).toEqual(["-s=r1-1-buyer.1", "goto", "--", "http://localhost:1/x"]);
    expect(c.cwd).toBe(realpathSync(cwd));
    const { __CF_USER_TEXT_ENCODING: _cf, ...env } = c.env; // macOS adds this one to every process
    expect(env).toEqual(cliEnv(home));
  });

  it("runCli kills the CLI at its timeout and reports its stderr", async () => {
    const dir = tempDir();
    const js = join(dir, "slow.mjs");
    writeFileSync(js, 'process.stderr.write("boom\\n"); setInterval(() => {}, 1 << 30);\n');
    const t0 = Date.now();
    const r = await runCli({ js, session: "s", args: ["snapshot"], cwd: dir, home: dir, timeoutMs: 500 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
    expect(r.stderr).toBe("boom\n");
  });
});
