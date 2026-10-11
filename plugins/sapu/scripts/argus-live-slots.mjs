// argus-live-slots.mjs — explorer slots and their tokens (spec §7 "Budget, loops, handoff", §9 "Token"):
// `slot <n>` mints a random token per explorer dispatch and allocates the journey's accounts to the slot;
// run.json keeps only the token's sha256, so no file of the run holds a live token. A handoff retires the
// token and mints the next generation with a fresh budget (at most two handoffs). An account serves one
// slot per run. Each slot's counters live in `<slot>/state.json` under a per-slot lock that also
// serializes the slot's `pw` calls. A map slot (`slot <n> --map`, decision 20) holds no account: its token
// takes `code` and `submit` only, in any run whose worktree exists.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { slotConfig, slotDir, writeSlotConfig } from "./argus-live-browser.mjs";
import { expandConfig, loadLive } from "./argus-live-config.mjs";
import { readLock } from "./argus-live-lock.mjs";
import { run, tempBeside, withFileLock } from "./argus-live-proc.mjs";
import { readRun, updateRun } from "./argus-live-run.mjs";

/** A journey id: kebab-case. */
const JOURNEY = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** An account as the explorer names it: `<role>` (its first account) or `<role>.<k>`. */
const ACCOUNT_WORD = /^[a-z][a-z0-9_-]*(\.[1-9][0-9]?)?$/;
/** An account as a slot holds it: `<role>.<k>`. */
const ACCOUNT = /^([a-z][a-z0-9_-]*)\.([1-9][0-9]?)$/;
/** A token: 32 lower-case hex characters (randomBytes(16)). */
const TOKEN = /^[0-9a-f]{32}$/;
/** The most generations a slot has: the first and two handoffs. */
const MAX_GENERATION = 3;

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/**
 * The running cycle as a slot sees it: the lock, and run.json naming it with an instance id (its `up`
 * finished), not sealed by a `down`, before the lock's deadline → {lock, rec}; refused otherwise.
 */
function cycle(main, now = Date.now()) {
  const lock = readLock(main);
  if (!lock) throw new Error("refused: no journey cycle is running");
  if (lock.deadline * 1000 <= now) throw new Error(`refused: the deadline of cycle ${lock.runId} passed; run down`);
  const rec = readRun(main);
  if (!rec || rec.runId !== lock.runId || !rec.instanceId) throw new Error(`refused: cycle ${lock.runId} has no instance (its up did not finish)`);
  if (rec.closing) throw new Error(`refused: cycle ${lock.runId} is being torn down`);
  return { lock, rec };
}

/**
 * Refuses unless run.json `rec` holds cycle `runId` live — named, not sealed by a `down`, with an instance
 * id (an `up --fresh` under way has none) — in cycle()'s words. `pw` asks it of every call but `submit`.
 */
export function refuseNotLive(rec, runId) {
  if (!rec || rec.runId !== runId || rec.closing) throw new Error(`refused: cycle ${runId} is being torn down`);
  if (!rec.instanceId) throw new Error(`refused: cycle ${runId} has no instance (its up did not finish)`);
}

/**
 * refuseNotLive on run.json as it stands now. Every writer of a slot's files asks it just before it
 * writes: a `down` removes those files (removeRunSecrets), and a write after that would leave them behind.
 * A map slot's writers (`map`) need no instance id, only the run named and not sealed.
 */
export function stillLive(main, runId, { map = false } = {}) {
  const rec = readRun(main);
  if (!map) return refuseNotLive(rec, runId);
  if (!rec || rec.runId !== runId || rec.closing) throw new Error(`refused: cycle ${runId} is being torn down`);
}

/**
 * `<role>.<k>=<user>|<role>.<k>,…` (the CLI's `--accounts`) → `{"<role>.<k>": "<user>" | null}`. A
 * word that is not `<role>.<k>`, an account named twice, or an empty list is refused.
 */
export function parseAccounts(list) {
  const out = {};
  const items = String(list ?? "").split(",").filter((x) => x !== "");
  if (!items.length) throw new Error("refused: --accounts lists no account");
  for (const item of items) {
    const i = item.indexOf("=");
    const account = i < 0 ? item : item.slice(0, i);
    if (!ACCOUNT.test(account)) throw new Error(`refused: ${JSON.stringify(account)} is not an account (<role>.<k>)`);
    if (Object.hasOwn(out, account)) throw new Error(`refused: ${account} is listed twice`);
    out[account] = i < 0 ? null : item.slice(i + 1);
  }
  return out;
}

/**
 * The account `account` (`<role>.<k>`) and its user checked against the expanded config `live` → the key
 * it is allocated by (`<role>/<user>`, `<role>/command` for a login-command role), or null for `anon`.
 * Refused: `system`, a role the config lacks, `anon` with a user or past `.1`, a login-command role past
 * `.1` or with a user, a users role without a user or with one it does not list.
 */
function allocationKey(account, user, live) {
  const [, role, k] = ACCOUNT.exec(account);
  if (role === "system") throw new Error("refused: system is not an account: its steps are triggers");
  const r = live.roles && Object.hasOwn(live.roles, role) ? live.roles[role] : null;
  if (!r) throw new Error(`refused: ${account}: the config has no role ${role}`);
  if (role === "anon") {
    if (user !== null) throw new Error(`refused: ${account}: anon is never signed in, so it takes no user`);
    return null;
  }
  if (r.login) {
    if (k !== "1") throw new Error(`refused: ${account}: ${role} signs in by its login command, so it has only ${role}.1`);
    if (user !== null) throw new Error(`refused: ${account}: ${role} signs in by its login command, so it takes no user`);
    return `${role}/command`;
  }
  if (user === null) throw new Error(`refused: ${account} needs its user (${account}=<user>)`);
  if (!(r.users ?? []).some((u) => u && u.user === user)) throw new Error(`refused: ${account}: ${user} is not one of ${role}'s users`);
  return `${role}/${user}`;
}

/** Every allocation key of `accounts` (allocationKey), after the per-role numbering is checked: `.1`, `.2`, … without a gap. */
function allocationKeys(accounts, live) {
  const ks = {};
  for (const a of Object.keys(accounts)) {
    const [, role, k] = ACCOUNT.exec(a);
    (ks[role] ??= []).push(Number(k));
  }
  for (const [role, list] of Object.entries(ks)) {
    const sorted = [...list].sort((x, y) => x - y);
    sorted.forEach((k, i) => {
      if (k !== i + 1) throw new Error(`refused: ${role}.${k} without ${role}.${i + 1}: a role's accounts are numbered 1, 2, …`);
    });
  }
  const keys = {};
  for (const [a, user] of Object.entries(accounts)) {
    const key = allocationKey(a, user, live);
    if (key === null) continue;
    const other = Object.entries(keys).find(([, x]) => x === key);
    if (other) throw new Error(`refused: ${user ?? a} is allocated twice (${other[0]} and ${a})`);
    keys[a] = key;
  }
  return keys;
}

/** A fresh slot state: no call yet. */
const freshState = () => ({ calls: 0, loops: {}, sessions: {}, blockedOffset: 0, proxyBlocked: [], blockedReported: [], created: {} });

/** The slot's state (`<dir>/state.json`): `{calls, loops, sessions, blockedOffset, proxyBlocked, blockedReported, created}`; a fresh one when there is none. */
export function readSlotState(dir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    if (s && typeof s === "object" && !Array.isArray(s)) return { ...freshState(), ...s };
  } catch {
    // none yet
  }
  return freshState();
}

/**
 * Writes the slot's state whole (beside, then renamed into place), mode 0600: `created` holds the
 * passwords of accounts the journey made. With `live` ({main, runId, map?}), only while the run is still live
 * (stillLive), else `refused: …` and nothing written.
 */
export function writeSlotState(dir, s, live = null) {
  if (live) stillLive(live.main, live.runId, { map: Boolean(live.map) });
  const file = path.join(dir, "state.json");
  fs.renameSync(tempBeside(file, `${JSON.stringify(s)}\n`, 0o600), file);
}

/**
 * Copies the fixtures (`live.fixtures`, a repo-relative directory) from the worktree's HEAD tree into
 * `<dir>/files/` (0600 each): the regular files directly in it whose names `upload` accepts
 * (`[A-Za-z0-9._-]`, at most 128 characters); symlinks and subdirectories are not copied. Read from
 * HEAD, as the explorer's Read is, never from the working tree.
 */
function copyFixtures(worktree, fixtures, dir, runner) {
  if (typeof fixtures !== "string" || !fixtures) return;
  const spec = `${fixtures.replace(/\/+$/, "")}/`;
  const ls = runner(["git", "--literal-pathspecs", "-C", worktree, "ls-tree", "-z", "HEAD", "--", spec]);
  if (ls.error || ls.status !== 0) throw new Error(`failed: the fixtures ${fixtures} cannot be listed at HEAD: ${String(ls.stderr || (ls.error && ls.error.message)).trim().slice(0, 200)}`);
  for (const entry of String(ls.stdout).split("\0").filter(Boolean)) {
    const m = /^(100644|100755) blob ([0-9a-f]+)\t(.+)$/.exec(entry);
    if (!m) continue;
    const name = path.posix.basename(m[3]);
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(name) || name === "." || name === "..") continue;
    const blob = runner(["git", "-C", worktree, "cat-file", "blob", m[2]], { encoding: "buffer" });
    if (blob.error || blob.status !== 0) throw new Error(`failed: the fixture ${m[3]} cannot be read at HEAD`);
    fs.writeFileSync(path.join(dir, "files", name), blob.stdout, { mode: 0o600 });
  }
}

/**
 * The slot's directory, made ready for its sessions: the CLI config and signal script (writeSlotConfig) and
 * the fixtures, under the slot's lock with the run re-checked there (stillLive), so a `down`, which takes
 * that lock before it removes the slot's files, never runs between the check and the writes.
 */
async function prepareSlot(main, rec, slot, live, runner) {
  const port = rec.internal && rec.internal.proxy;
  const channel = rec.browser && rec.browser.channel;
  if (!Number.isInteger(port) || typeof channel !== "string") throw new Error(`refused: cycle ${rec.runId} has no proxy or browser recorded (its up did not reach step 9)`);
  const dir = slotDir(main, rec.runId, slot);
  await withSlotLock(
    main,
    rec.runId,
    slot,
    () => {
      stillLive(main, rec.runId);
      writeSlotConfig(dir, slotConfig({ dir, origins: rec.origins ?? [], allowOrigins: rec.allowOrigins ?? [], proxyPort: port, live, chrome: { channel } }));
      copyFixtures(rec.worktree, live.fixtures, dir, runner);
      writeSlotState(dir, freshState(), { main, runId: rec.runId });
    },
    { waitMs: slotLockWaitMs(live.settle_ms) },
  );
  return dir;
}

/** The running cycle's config, expanded with its ports and the env_file's values (users may name `${NAME}`). */
function liveOf(main, rec) {
  const { config, errors, secrets } = loadLive(main);
  if (!config || errors.length) throw new Error(`refused: .argus/live.json: ${errors.join("; ")}`);
  return expandConfig(config, { ports: { ...(rec.ports ?? {}) }, secrets });
}

const reply = (slot, token, s) => ({ slot, token, generation: s.generation, journey: s.journey, accounts: s.accounts });

/**
 * Mints slot `slot` (a positive integer) for journey `journey` with `accounts` (`{"<role>.<k>": user |
 * null}`, parseAccounts) → `{slot, token, generation: 1, journey, accounts}`, the only place a token
 * exists: run.json `slots[<n>]` keeps `{journey, generation, tokenHash, accounts, retired: [],
 * submitted: false}`. Refused: no running cycle with an instance; a slot minted already (`--handoff`); a
 * journey id that is not kebab-case; an account the config does not allow (allocationKeys); an account
 * that serves another slot of the run (`refused: <user> already serves slot <m>`). The slot's directory
 * gets its CLI config, its fixtures and a fresh state.json, under the slot's lock (prepareSlot).
 */
export async function mintSlot(main, { slot, journey, accounts }, { runner = run } = {}) {
  if (!Number.isInteger(slot) || slot < 1 || slot > 99) throw new Error("refused: a slot is a number from 1 to 99");
  if (typeof journey !== "string" || !JOURNEY.test(journey)) throw new Error(`refused: ${JSON.stringify(String(journey))} is not a journey id (kebab-case)`);
  const { lock, rec } = cycle(main);
  const live = liveOf(main, rec);
  const keys = allocationKeys(accounts, live);
  const token = randomBytes(16).toString("hex");
  const entry = { journey, generation: 1, tokenHash: sha256(token), accounts: { ...accounts }, retired: [], submitted: false };
  updateRun(
    main,
    lock.runId,
    (prev) => {
      if (!prev || !prev.instanceId) throw new Error(`refused: cycle ${lock.runId} has no instance (its up did not finish)`);
      const slots = prev.slots ?? {};
      if (Object.hasOwn(slots, String(slot))) throw new Error(`refused: slot ${slot} is minted already; hand it off (slot ${slot} --handoff)`);
      for (const [n, s] of Object.entries(slots)) {
        const taken = new Set(Object.values(allocationKeysQuiet(s.accounts, live)));
        for (const [a, key] of Object.entries(keys)) if (taken.has(key)) throw new Error(`refused: ${accounts[a] ?? a} already serves slot ${n}`);
      }
      return { ...prev, slots: { ...slots, [String(slot)]: entry } };
    },
    { create: false },
  );
  try {
    await prepareSlot(main, rec, slot, live, runner);
  } catch (e) {
    // A slot that cannot be prepared is not minted: its allocation is given back.
    try {
      updateRun(main, lock.runId, (prev) => (prev ? { ...prev, slots: Object.fromEntries(Object.entries(prev.slots ?? {}).filter(([n]) => n !== String(slot))) } : undefined), { create: false });
    } catch {
      // sealed or gone
    }
    throw e;
  }
  return reply(slot, token, entry);
}

/**
 * Mints map slot `slot` (decision 20) → `{slot, token, generation: 1, mode: "map"}`, in any run whose run.json
 * has a worktree (a map run, or a full `up` still starting): run.json `slots[<n>]` keeps `{mode: "map",
 * journey: null, generation, tokenHash, accounts: {}, retired: [], submitted: false}`, and the slot's
 * directory a fresh state.json only. Refused: no lock, past its deadline, a sealed run, no worktree yet, a
 * slot minted already.
 */
export async function mintMapSlot(main, { slot }) {
  if (!Number.isInteger(slot) || slot < 1 || slot > 99) throw new Error("refused: a slot is a number from 1 to 99");
  const lock = readLock(main);
  if (!lock) throw new Error("refused: no journey cycle is running");
  if (lock.deadline * 1000 <= Date.now()) throw new Error(`refused: the deadline of cycle ${lock.runId} passed; run down`);
  const token = randomBytes(16).toString("hex");
  const entry = { mode: "map", journey: null, generation: 1, tokenHash: sha256(token), accounts: {}, retired: [], submitted: false };
  updateRun(
    main,
    lock.runId,
    (prev) => {
      if (!prev || typeof prev.worktree !== "string") throw new Error(`refused: cycle ${lock.runId} has no worktree yet`);
      const slots = prev.slots ?? {};
      if (Object.hasOwn(slots, String(slot))) throw new Error(`refused: slot ${slot} is minted already`);
      return { ...prev, slots: { ...slots, [String(slot)]: entry } };
    },
    { create: false },
  );
  const settle = (loadLive(main).config ?? {}).settle_ms;
  try {
    await withSlotLock(main, lock.runId, slot, () => writeSlotState(slotDir(main, lock.runId, slot), freshState(), { main, runId: lock.runId, map: true }), { waitMs: slotLockWaitMs(settle) });
  } catch (e) {
    // A slot whose state cannot be written is not minted.
    try {
      updateRun(main, lock.runId, (prev) => (prev ? { ...prev, slots: Object.fromEntries(Object.entries(prev.slots ?? {}).filter(([n]) => n !== String(slot))) } : undefined), { create: false });
    } catch {
      // sealed or gone
    }
    throw e;
  }
  return { slot, token, generation: 1, mode: "map" };
}

/** allocationKeys of an earlier slot's accounts, as keys only (an account the config no longer allows still blocks its key). */
function allocationKeysQuiet(accounts, live) {
  const out = {};
  for (const [a, user] of Object.entries(accounts ?? {})) {
    const m = ACCOUNT.exec(a);
    if (!m || m[1] === "anon") continue;
    const r = live.roles && live.roles[m[1]];
    out[a] = r && r.login ? `${m[1]}/command` : `${m[1]}/${user}`;
  }
  return out;
}

/**
 * Hands slot `slot` off (spec §7): its current token retires (its hash moves to `retired`), a new token
 * is minted for the next generation with a fresh budget (a fresh state.json, under the slot's lock, so no
 * call of the old token is counted into it) → `{slot, token, generation, journey, accounts}`. The browser
 * sessions stay open: the next explorer continues where the last stopped. Refused past generation 3
 * (`refused: slot <n> already had two handoffs`) and for a slot never minted.
 */
export async function handoffSlot(main, slot) {
  const { lock, rec } = cycle(main);
  const n = String(slot);
  if (!rec.slots || !Object.hasOwn(rec.slots, n)) throw new Error(`refused: slot ${slot} was never minted`);
  const token = randomBytes(16).toString("hex");
  let entry = null;
  const settle = (loadLive(main).config ?? {}).settle_ms;
  await withSlotLock(
    main,
    lock.runId,
    slot,
    () => {
      updateRun(
        main,
        lock.runId,
        (prev) => {
          const cur = prev && prev.slots && prev.slots[n];
          if (!cur) throw new Error(`refused: slot ${slot} was never minted`);
          if (cur.generation >= MAX_GENERATION) throw new Error(`refused: slot ${slot} already had two handoffs`);
          entry = { ...cur, generation: cur.generation + 1, tokenHash: sha256(token), retired: [...(cur.retired ?? []), ...(cur.tokenHash ? [cur.tokenHash] : [])], submitted: false };
          return { ...prev, slots: { ...prev.slots, [n]: entry } };
        },
        { create: false },
      );
      const dir = slotDir(main, lock.runId, slot);
      const was = readSlotState(dir);
      // A fresh budget and loop count; the sessions' state (signed in, last page, console seen), the
      // accounts the journey created and the blocked origins already told carry over: the browsers stay open.
      writeSlotState(dir, { ...freshState(), sessions: was.sessions, created: was.created, blockedOffset: was.blockedOffset, proxyBlocked: was.proxyBlocked, blockedReported: was.blockedReported }, { main, runId: lock.runId });
    },
    { waitMs: slotLockWaitMs(settle) },
  );
  return reply(slot, token, entry);
}

/**
 * The slot a token belongs to → `{runId, slot, rec, lock, run, mode}` (`rec` its run.json `slots` entry, `run`
 * run.json as read, `mode` `map` for a map slot, else `explore`). The
 * token's sha256 is compared with each slot's current hash by timingSafeEqual. A retired token →
 * `refused: retired token`; anything else (not 32 lower-case hex, another run's, no cycle) →
 * `refused: unknown token`.
 */
export function tokenSlot(main, token) {
  const unknown = () => new Error("refused: unknown token");
  if (typeof token !== "string" || !TOKEN.test(token)) throw unknown();
  const lock = readLock(main);
  const rec = lock ? readRun(main) : null;
  if (!lock || !rec || rec.runId !== lock.runId || !rec.slots) throw unknown();
  const mine = Buffer.from(sha256(token), "hex");
  const same = (h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h) && timingSafeEqual(Buffer.from(h, "hex"), mine);
  let retired = false;
  for (const [n, s] of Object.entries(rec.slots)) {
    if (!s) continue;
    if (same(s.tokenHash)) return { runId: lock.runId, slot: Number(n), rec: s, lock, run: rec, mode: s.mode === "map" ? "map" : "explore" };
    if ((s.retired ?? []).some(same)) retired = true;
  }
  if (retired) throw new Error("refused: retired token");
  throw unknown();
}

/**
 * The slot account an explorer's word names: `<role>.<k>` as is, a bare `<role>` as `<role>.1` →
 * `<role>.<k>`, when the slot `rec` holds it; else `refused: <word> is not allocated to this slot` (a
 * word that is not an account's shape is not echoed).
 */
export function accountOf(rec, word) {
  if (typeof word !== "string" || !ACCOUNT_WORD.test(word)) throw new Error("refused: not an account word (<role> or <role>.<k>)");
  const account = word.includes(".") ? word : `${word}.1`;
  if (!rec || !rec.accounts || !Object.hasOwn(rec.accounts, account)) throw new Error(`refused: ${word} is not allocated to this slot`);
  return account;
}

/**
 * How long a caller waits for a slot's lock: the longest a `pw` call holds it at `settleMs` (its CLI calls'
 * bounds — the command and a find's waits, the observation, the console, a probe, a login's two stages and
 * a TOTP step — with room to spare).
 */
export function slotLockWaitMs(settleMs) {
  return 15 * (Number.isInteger(settleMs) ? settleMs : 10_000) + 420_000;
}

/**
 * Runs `fn` holding slot `slot`'s lock, `<dir>/lock` (withFileLock: created whole, `{pid, started}`; a
 * holder that no longer runs is taken over; no age limit, since a call may wait for a page) → what `fn`
 * returns. Every `pw` call of the slot runs under it, so its counters are never lost to a race.
 */
export async function withSlotLock(main, runId, slot, fn, { waitMs = 30_000 } = {}) {
  const dir = slotDir(main, runId, slot);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return withFileLock(path.join(dir, "lock"), fn, { waitMs });
}

/** Retires every slot's current token (`up --fresh`: the explorers belong to the instance it resets). */
export function retireAll(main, runId) {
  return updateRun(
    main,
    runId,
    (prev) => {
      if (!prev || !prev.slots) return undefined;
      const slots = {};
      for (const [n, s] of Object.entries(prev.slots)) slots[n] = s && s.tokenHash ? { ...s, retired: [...(s.retired ?? []), s.tokenHash], tokenHash: null } : s;
      return { ...prev, slots };
    },
    { create: false },
  );
}
