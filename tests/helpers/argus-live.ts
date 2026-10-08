// Helpers shared by the argus-live test files: temp directories, a committed repo, a run as `up`
// leaves it before its run files, and small process and timing helpers.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain ESM script without types
import { makeHome, makeWorktree } from "../../plugins/sapu/scripts/argus-live-instance.mjs";
// @ts-expect-error — plain ESM script without types
import { takeLock } from "../../plugins/sapu/scripts/argus-live-lock.mjs";

const temps: string[] = [];

/** A fresh directory under the OS temp dir; removed by cleanTemps (each test file calls it afterEach). */
export const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "argus-live-"));
  temps.push(d);
  return d;
};

export const cleanTemps = () => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
};

export const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/** A repo with one commit (`app.txt`). */
export const committed = () => {
  const main = tempDir();
  git(main, "init", "-q");
  writeFileSync(join(main, "app.txt"), "app\n");
  git(main, "add", ".");
  git(main, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "init");
  return main;
};

/** A loopback port free at the moment of the call. */
export const freePort = () =>
  new Promise<number>((done) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => done(p));
    });
  });

/** The process runs (one of another user's counts as running). */
export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Polls `ok` every 50 ms for up to `ms`; its last answer. */
export const until = async (ok: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return ok();
};

/** Now in epoch seconds, as the lock records times. */
export const now = () => Math.floor(Date.now() / 1000);

export const setLock = (main: string, lock: { runId: string; start: number; deadline: number }) => writeFileSync(join(main, ".argus/live/lock.json"), `${JSON.stringify(lock)}\n`);

/** A run as `up` leaves it before its run files: the lock, a worktree, a HOME, a setup log. */
export const liveRun = () => {
  const main = committed();
  const l = takeLock(main, { maxCycleMinutes: 45 });
  const wt = makeWorktree(main, l.runId);
  const home = makeHome(main, l.runId);
  writeFileSync(`${wt}.setup.log`, "setup output\n");
  const env = { PATH: process.env.PATH!, HOME: home, COMPOSE_PROJECT_NAME: `argus-${l.runId}` };
  return { main, runId: l.runId as string, wt, home, env, lock: l };
};
