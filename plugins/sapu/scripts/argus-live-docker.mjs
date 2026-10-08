// argus-live-docker.mjs — Docker for the journey lane's live instance (spec §8 steps 3, 5 and 8): the
// run's Docker client, the static Compose check, the daemon's clock, the events follower and the
// Docker runtime gate.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnvFile } from "./argus-live-config.mjs";
import { dockerHost, readOwner, scopeChecker, SOCKET_NAME } from "./argus-live-endpoints.mjs";
import { membersOf, processTable, redact, resolveLink, run, sameGroup, startTime, tail, within } from "./argus-live-proc.mjs";

/**
 * The run's Docker client (spec §8 step 3), so no docker command of the instance reads the owner's
 * credentials or reaches anything but this machine's daemon: DOCKER_CONFIG = `<home>/.docker`, holding
 * only links to the owner's CLI plugins (`<their DOCKER_CONFIG or ~/.docker>/cli-plugins/docker-*`) and
 * a config.json without auths, credsStore or currentContext (only `cliPluginsExtraDirs` carried over);
 * DOCKER_HOST = the local unix socket of the owner's current context (`docker context inspect`).
 * Refused when that context is anything but a local unix socket. Without docker on PATH, only
 * DOCKER_CONFIG. `ownerEnv` is the session's environment, in which the context is looked up.
 */
export function dockerEnv({ home, runner = run, ownerEnv = process.env }) {
  const dir = path.join(home, ".docker");
  const plugins = path.join(dir, "cli-plugins");
  fs.mkdirSync(plugins, { recursive: true, mode: 0o700 });
  const ownerCfg = ownerEnv.DOCKER_CONFIG || path.join(ownerEnv.HOME || os.homedir(), ".docker");
  let names = [];
  try {
    names = fs.readdirSync(path.join(ownerCfg, "cli-plugins"));
  } catch {
    // no plugins of the owner's own
  }
  for (const name of names) if (/^docker-[A-Za-z0-9._-]+$/.test(name)) fs.symlinkSync(path.join(ownerCfg, "cli-plugins", name), path.join(plugins, name));
  let extra;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ownerCfg, "config.json"), "utf8"));
    if (Array.isArray(j.cliPluginsExtraDirs)) extra = j.cliPluginsExtraDirs.filter((d) => typeof d === "string");
  } catch {
    // no config of the owner's own
  }
  fs.writeFileSync(path.join(dir, "config.json"), `${JSON.stringify(extra ? { cliPluginsExtraDirs: extra } : {})}\n`, { mode: 0o600 });
  const out = { DOCKER_CONFIG: dir };
  const r = runner(["docker", "context", "inspect"], { env: ownerEnv, timeout: 30_000 });
  if (r.error && r.error.code === "ENOENT") return out;
  if (r.error || r.status !== 0) throw new Error(`refused: docker context inspect failed: ${tail((r.error && r.error.message) || r.stderr)}`);
  let ctx;
  try {
    ctx = JSON.parse(r.stdout)[0];
  } catch {
    ctx = null;
  }
  const host = ctx && ctx.Endpoints && ctx.Endpoints.docker && ctx.Endpoints.docker.Host;
  const m = typeof host === "string" && host.match(/^unix:\/\/(\/.+)$/);
  if (!m) {
    const scheme = typeof host === "string" ? host.split(":")[0] : "no host";
    throw new Error(`refused: the docker context ${(ctx && ctx.Name) || "in use"} is not a local unix socket (${scheme}); the instance uses only this machine's daemon`);
  }
  out.DOCKER_HOST = `unix://${m[1]}`;
  return out;
}

/** The files `docker compose` reads by itself in a project directory, in the order it prefers them. */
const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
/** A Compose file's name: `compose*.y*ml` or `docker-compose*.y*ml` (not `composer.yaml`). */
const COMPOSE_NAME = /^(docker-)?compose([._-][^/]*)?\.ya?ml$/i;
/** Compose's global flags that make a command read other files, or act on another project, than the check saw. */
const COMPOSE_ESCAPES = new Set(["-p", "--project-name", "-f", "--file", "--project-directory", "--env-file"]);
/** Compose's global flags that take a value (the next word, unless written `--flag=value`). */
const COMPOSE_VALUED = new Set([...COMPOSE_ESCAPES, "--profile", "--ansi", "--parallel", "--progress"]);
/** Capabilities a service may add: none of them reaches beyond its own container. */
const CAPS_OK = new Set(["NET_BIND_SERVICE", "CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER"]);

/**
 * Where container runtimes and local datastores keep their sockets: a bind mount of one, or of a
 * directory holding one, hands the container the owner's daemon or data.
 */
function knownSockets(env = {}) {
  const home = process.env.HOME || os.homedir();
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const list = [
    "/var/run/docker.sock", "/run/docker.sock", "/var/run/containerd/containerd.sock", "/run/containerd/containerd.sock",
    "/var/run/podman/podman.sock", "/run/podman/podman.sock", `/run/user/${uid}/docker.sock`, `/run/user/${uid}/podman/podman.sock`,
    `${home}/.docker/run/docker.sock`, `${home}/.docker/desktop/docker.sock`, `${home}/.colima/default/docker.sock`, `${home}/.rd/docker.sock`, `${home}/.orbstack/run/docker.sock`,
    "/tmp/.s.PGSQL.5432", "/var/run/postgresql/.s.PGSQL.5432", "/run/postgresql/.s.PGSQL.5432", "/tmp/mysql.sock", "/var/run/mysqld/mysqld.sock", "/run/mysqld/mysqld.sock",
    "/var/run/redis/redis.sock", "/run/redis/redis.sock", "/var/run/redis/redis-server.sock", "/run/redis/redis-server.sock",
  ];
  const m = String(env.DOCKER_HOST || "").match(/^unix:\/\/(\/.+)$/);
  if (m) list.push(m[1]);
  return [...new Set(list.flatMap((s) => [s, resolveLink(s)]).filter(Boolean))];
}

/** Where Docker Desktop and other runtimes keep their sockets: any `*.sock` under one is the runtime's. */
function dockerRunDirs() {
  const home = process.env.HOME || os.homedir();
  const dirs = [`${home}/.docker/run`, `${home}/.docker/desktop`, `${home}/Library/Containers/com.docker.docker/Data`, `${home}/.colima`, `${home}/.rd`, `${home}/.orbstack/run`, "/var/run/docker", "/run/docker", "/var/run/containerd", "/run/containerd", "/var/run/podman", "/run/podman"];
  return [...new Set(dirs.flatMap((d) => [d, resolveLink(d)]).filter(Boolean))];
}

/**
 * Why a host path a container would get (a bind mount, a local volume's device) is refused, or null:
 * it lies inside <MAIN> (outside the `exempt` directories: linked worktrees, which are not the main
 * checkout) or holds it, or (outside the worktree `root`, and unless `socketsOk`) it is a container
 * runtime or datastore socket or a directory holding one.
 */
function hostPathRefusal(source, { worktree, root, realMain, sockets, exempt = [], socketsOk = false }) {
  const raw = path.resolve(worktree, String(source));
  const real = resolveLink(raw);
  const inMain = real !== null && within(realMain, real) && !exempt.some((d) => within(d, real));
  if (real === null || inMain || within(real, realMain)) return "a path inside the main checkout (or one holding it)";
  if (within(root, real) || socketsOk) return null; // the run's own, or a socket the caller allows
  const runDirs = dockerRunDirs();
  const runtime = (p) => SOCKET_NAME.test(path.basename(p)) || sockets.some((s) => within(p, s)) || runDirs.some((d) => within(p, d) || (within(d, p) && p.endsWith(".sock")));
  if ([raw, real].some(runtime)) return "a container runtime or datastore socket, or a directory holding one";
  return null;
}

/** A shell command's simple commands as word lists: enough to find a flag, not a parser. */
const shellWords = (cmd) =>
  String(cmd)
    .split(/&&|\|\||[;&|\n()]/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean));

/** Every command of the config, as [where, words[][]]: argv lists are one command each, shell fields split. */
function commandsOf(config) {
  const out = [];
  (config.setup ?? []).forEach((argv, i) => out.push([`setup[${i}]`, [argv.map(String)]]));
  for (const k of ["facts", "mail"]) if (config[k] && Array.isArray(config[k].argv)) out.push([`${k}.argv`, [config[k].argv.map(String)]]);
  for (const [n, t] of Object.entries(config.triggers ?? {})) if (t && Array.isArray(t.argv)) out.push([`triggers.${n}.argv`, [t.argv.map(String)]]);
  for (const k of ["store_check", "reset"]) if (typeof config[k] === "string") out.push([k, shellWords(config[k])]);
  for (const e of config.start ?? []) {
    for (const [k, v] of [["cmd", e.cmd], ["stop", e.stop], ["health.cmd", e.health && e.health.cmd]]) if (typeof v === "string") out.push([`start.${e.name}.${k}`, shellWords(v)]);
  }
  for (const [r, role] of Object.entries(config.roles ?? {})) if (role && role.login && typeof role.login.command === "string") out.push([`roles.${r}.login.command`, shellWords(role.login.command)]);
  return out;
}

/**
 * Why one simple command (`raw` words) would run Docker past the check, or null: it sets or unsets a
 * COMPOSE_* or DOCKER_* variable; it runs `docker` other than `docker compose`; or its `docker compose`
 * / `docker-compose` passes COMPOSE_ESCAPES, or a variable, before the subcommand. Quotes and
 * backslashes are dropped first, as the shell would.
 */
function dockerEscape(raw) {
  const words = raw.map((w) => w.replace(/['"\\]/g, ""));
  const base = (w) => w.split("/").pop();
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const set = w.match(/^((?:COMPOSE|DOCKER)_[A-Za-z0-9_]*)=/);
    if (set) return `sets ${set[1]}`;
    if (w === "unset") {
      const v = words.slice(i + 1).find((x) => /^(COMPOSE|DOCKER)_/.test(x));
      if (v) return `unsets ${v}`;
    }
    let j;
    if (base(w) === "docker-compose") j = i + 1;
    else if (base(w) === "docker" && i + 1 < words.length) {
      if (words[i + 1] !== "compose") return `runs docker ${words[i + 1]}; only docker compose runs under the check`;
      j = i + 2;
    } else continue;
    for (; j < words.length; j++) {
      if (/[$`]/.test(raw[j])) return "passes a variable where docker compose reads its flags";
      const t = words[j];
      if (!t.startsWith("-")) break;
      const flag = /^-[pf]./.test(t) ? t.slice(0, 2) : t.split("=")[0];
      if (COMPOSE_ESCAPES.has(flag)) return `passes ${flag} to docker compose`;
      if (COMPOSE_VALUED.has(flag) && !t.includes("=")) j++;
    }
  }
  return null;
}

/** Every file the worktree tracks (`git ls-files`), as paths from its root. */
function gitFiles(worktree, runner) {
  const r = runner(["git", "-C", worktree, "ls-files", "-z"]);
  if (r.error || r.status !== 0) throw new Error(`failed: git ls-files in ${worktree}: ${tail((r.error && r.error.message) || r.stderr)}`);
  return r.stdout.split("\0").filter(Boolean);
}

/** Every Compose file in the worktree: tracked at any depth, and the default names at its root. */
function composeFiles(worktree, runner) {
  const tracked = gitFiles(worktree, runner).filter((f) => COMPOSE_NAME.test(path.posix.basename(f)));
  const root = COMPOSE_FILES.filter((f) => fs.existsSync(path.join(worktree, f)));
  return [...new Set([...tracked, ...root])];
}

/** A directory's Compose files in the order Compose merges them: default names, then overrides, then the rest. */
const composeOrder = (a, b) => {
  const rank = (f) => (COMPOSE_FILES.includes(f) ? COMPOSE_FILES.indexOf(f) : /^(docker-)?compose\.override\./i.test(f) ? 10 : 20);
  return rank(a) - rank(b) || a.localeCompare(b);
};

/**
 * `up` step 5's Compose check (spec §8 step 5).
 * 1. No command of `config` may set or unset a COMPOSE_* or DOCKER_* variable, run `docker` other than
 *    `docker compose`, or pass Compose a project, file, project directory or env file of its own (or a
 *    variable where its flags go): the check would not see what it runs.
 * 2. The Compose files checked: `config.compose_files` when set (each tracked; merged in their order
 *    from the worktree's root), else the COMPOSE_FILE the instance env (or a tracked `.env`) sets (read
 *    as Compose reads it, at the root), else every Compose file — tracked at any depth, or a default
 *    name at the root — one `config` per directory, a refusal then saying to list `compose_files`
 *    (fail closed; files used only by commands or scripts are left to the runtime gate). None may name
 *    a path inside <MAIN> (an `env_file`, `extends` or `include` read from the owner's checkout).
 * 3. `docker compose [-f <file>…] --profile * config --format json` runs in each such directory under
 *    the instance env, and every project must share nothing with the owner's
 *    stack: named COMPOSE_PROJECT_NAME; no `container_name`; only this run's ports published (never a
 *    random one); no `network_mode` host, bridge or `container:`; no `pid`/`ipc`/`cgroup` host or
 *    `container:`, no `uts`/`userns_mode` host; no `volumes_from` a container; not privileged, no
 *    devices, no capability outside CAPS_OK; no bind mount or local volume device inside <MAIN> (or
 *    holding it) or at a runtime or datastore socket (or a directory holding one); no secret, config or
 *    build context read from <MAIN>; no `extra_hosts` to the Docker host; no network or volume external
 *    or named outside the project; and each service's environment, command and entrypoint pass
 *    checkStore's comparison (as a container: its loopback is its own, the Docker host is refused off
 *    the run's ports).
 * Docker missing or failing is a refusal. Returns {services, published}: the service names of every
 * project (checkStore's `composeServices`) and the host ports they publish (all of them the run's: a
 * listener there is the Docker daemon's, not a process of the run); both [] without a Compose file.
 */
export function checkCompose({ worktree, env, ports = {}, main, config = {}, contract = null, secrets = {}, runner = run }) {
  for (const [where, commands] of commandsOf(config)) {
    for (const words of commands) {
      const why = dockerEscape(words);
      if (why) throw new Error(`refused: ${where} ${why}; the check sees only the Compose files and project the env gives (COMPOSE_FILE, COMPOSE_PROFILES; COMPOSE_PROJECT_NAME, DOCKER_CONFIG and DOCKER_HOST are the run's)`);
    }
  }
  const realMain = fs.realpathSync.native(main);
  let dotenv = {};
  try {
    dotenv = parseEnvFile(fs.readFileSync(path.join(worktree, ".env"), "utf8"));
  } catch {
    // no .env tracked
  }
  let scan;
  let runs;
  let hint = "";
  const listed = Array.isArray(config.compose_files) && config.compose_files.length ? config.compose_files : null;
  const composeFile = env.COMPOSE_FILE || dotenv.COMPOSE_FILE;
  if (listed) {
    const tracked = new Set(gitFiles(worktree, runner));
    for (const f of listed) if (!tracked.has(f)) throw new Error(`refused: compose_files names ${f}, which the worktree does not track`);
    scan = listed;
    runs = [{ what: `${listed[0]} (compose_files) is in the worktree`, cwd: worktree, args: listed.flatMap((f) => ["-f", f]) }];
  } else if (composeFile) {
    scan = String(composeFile).split(env.COMPOSE_PATH_SEPARATOR || dotenv.COMPOSE_PATH_SEPARATOR || ":").filter(Boolean);
    for (const f of scan) {
      const real = resolveLink(path.resolve(worktree, f));
      if (real === null || within(realMain, real)) throw new Error(`refused: COMPOSE_FILE names ${f}, inside the main checkout`);
    }
    runs = [{ what: env.COMPOSE_FILE ? "env names COMPOSE_FILE" : "the worktree's .env names COMPOSE_FILE", cwd: worktree, args: [] }];
  } else {
    scan = composeFiles(worktree, runner);
    const byDir = new Map();
    for (const f of scan) {
      const d = path.posix.dirname(f);
      byDir.set(d, [...(byDir.get(d) ?? []), path.posix.basename(f)]);
    }
    runs = [...byDir].map(([d, names]) => {
      const sorted = [...names].sort(composeOrder);
      return { what: `${path.posix.join(d, sorted[0])} is in the worktree`, cwd: path.join(worktree, d), args: sorted.flatMap((n) => ["-f", n]) };
    });
    hint = "; list the files the instance uses in compose_files to check only those";
  }
  if (!runs.length) return { services: [], published: [] };
  try {
    return composeProjects({ worktree, env, ports, main, realMain, config, contract, secrets, runner, scan, runs });
  } catch (e) {
    throw hint && /^refused: /.test(e.message) ? new Error(e.message + hint) : e;
  }
}

/** The forms of <MAIN> a file may spell, and the characters that may follow one where a path ends. */
const MAIN_END = /^($|[/\s"'`,\]}):#)])/;

/** True when `text` (a Compose file in `dir`) names a path inside <MAIN>: spelled out anywhere (a `${VAR:-<path>}` default too), or reached by a path. */
function namesMain(text, dir, main, realMain) {
  for (const m of new Set([path.resolve(main), realMain])) {
    for (let i = text.indexOf(m); i >= 0; i = text.indexOf(m, i + 1)) if (MAIN_END.test(text.slice(i + m.length, i + m.length + 1))) return true;
  }
  for (const m of text.matchAll(/(?<![A-Za-z0-9_.~/])((?:\/|\.\.?\/)[^\s"',\]}#]*)/g)) {
    if (/^\/\//.test(m[1])) continue; // the rest of a URL
    const real = resolveLink(path.resolve(dir, m[1]));
    if (real === null || within(realMain, real)) return true;
  }
  return false;
}

/** checkCompose's steps 2 and 3 over the chosen files: `scan` (paths from the root) and `runs` ({what, cwd, args}). */
function composeProjects({ worktree, env, ports, main, realMain, config, contract, secrets, runner, scan, runs }) {
  for (const f of scan) {
    const file = path.resolve(worktree, f);
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue; // Compose reports a missing file itself
    }
    if (namesMain(text, path.dirname(file), main, realMain)) throw new Error(`refused: ${f} names a path inside the main checkout (Compose would read the owner's file)`);
  }
  const project = env.COMPOSE_PROJECT_NAME;
  const runPorts = new Set(Object.values(ports).map(Number));
  const sockets = knownSockets(env);
  const at = { worktree, root: fs.realpathSync.native(worktree), realMain, sockets };
  const projects = runs.map(({ what, cwd, args }) => {
    const why = `refused: ${what}, but docker compose config could not read it`;
    const r = runner(["docker", "compose", ...args, "--profile", "*", "config", "--format", "json"], { cwd, env, timeout: 60_000 });
    if (r.error || r.status !== 0) throw new Error(`${why}: ${tail(redact((r.error && r.error.message) || r.stderr || `exit ${r.status}`, secrets))}`);
    let c;
    try {
      c = JSON.parse(r.stdout);
    } catch {
      c = null;
    }
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error(`${why}: its output is not JSON`);
    if (c.name !== project) throw new Error(`refused: the Compose project is named ${c.name}, not ${project} (COMPOSE_PROJECT_NAME)`);
    return { c, cwd };
  });
  const services = [...new Set(projects.flatMap(({ c }) => Object.keys(c.services ?? {})))];
  const published = new Set();
  const check = scopeChecker(readOwner(main, contract), { worktree, allowOrigins: config.allow_origins, composeServices: services, runPorts: [...runPorts] });
  for (const { c, cwd } of projects) {
    const local = { ...at, worktree: cwd };
    for (const [name, s] of Object.entries(c.services ?? {})) {
      const svc = `refused: Compose service ${name}`;
      if (s.container_name) throw new Error(`${svc} sets container_name (a fixed name collides with, or takes over, the owner's container)`);
      const mode = String(s.network_mode ?? "");
      if (mode === "host" || mode === "bridge" || mode.startsWith("container:")) throw new Error(`${svc} sets network_mode ${mode} (it would share a network the run does not own)`);
      for (const k of ["pid", "ipc", "cgroup", "uts", "userns_mode"]) {
        const v = String(s[k] ?? "");
        if (v === "host" || (["pid", "ipc", "cgroup"].includes(k) && v.startsWith("container:"))) throw new Error(`${svc} sets ${k} ${v} (it would share a namespace the run does not own)`);
      }
      for (const v of s.volumes_from ?? []) if (String(v).startsWith("container:")) throw new Error(`${svc} sets volumes_from ${v} (another container's data)`);
      if (s.privileged) throw new Error(`${svc} is privileged (it could reach the host)`);
      for (const o of s.security_opt ?? []) {
        if (/^(seccomp|apparmor)[:=]unconfined$|^label[:=]disable$|^systempaths=unconfined$/i.test(String(o).replace(/\s+/g, ""))) throw new Error(`${svc} sets security_opt ${o} (it would lift the container's confinement)`);
      }
      if (Array.isArray(s.devices) && s.devices.length) throw new Error(`${svc} maps host devices`);
      for (const cap of s.cap_add ?? []) {
        const n = String(cap).toUpperCase().replace(/^CAP_/, "");
        if (!CAPS_OK.has(n)) throw new Error(`${svc} adds capability ${n} (allowed: ${[...CAPS_OK].join(", ")})`);
      }
      for (const p of s.ports ?? []) {
        if (p.published === undefined || p.published === null || p.published === "") throw new Error(`${svc} publishes container port ${p.target} on a random host port; publish one of this run's ports ({port:<name>})`);
        const m = String(p.published).match(/^(\d+)(?:-(\d+))?$/);
        if (!m) throw new Error(`${svc} publishes host port ${p.published}, which is not one of this run's ports`);
        for (let n = Number(m[1]); n <= Number(m[2] ?? m[1]); n++) {
          if (!runPorts.has(n)) throw new Error(`${svc} publishes host port ${n}, which is not one of this run's ports`);
          published.add(n);
        }
      }
      for (const v of s.volumes ?? []) {
        const no = v.type === "bind" && v.source ? hostPathRefusal(v.source, local) : null;
        if (no) throw new Error(`${svc} bind-mounts ${no}`);
      }
      const ctxs = s.build ? [s.build.context, ...Object.values(s.build.additional_contexts ?? {})] : [];
      for (const x of ctxs) {
        if (typeof x !== "string" || /^[a-z][a-z0-9+.-]*:/i.test(x)) continue; // a URL, git or another image
        const real = resolveLink(path.resolve(cwd, x));
        if (real === null || within(realMain, real)) throw new Error(`${svc} builds from a path inside the main checkout`);
      }
      for (const e of s.extra_hosts ?? []) {
        const [h, ip] = String(e).split(/=|:(?=[^:]*$)/);
        if (ip && (ip.trim() === "host-gateway" || dockerHost(ip))) throw new Error(`${svc} maps ${h} to the Docker host (${ip.trim()})`);
      }
      check(`compose.${name}.environment`, Object.fromEntries(Object.entries(s.environment ?? {}).filter(([, v]) => v !== null && v !== undefined)), { container: true });
      for (const k of ["command", "entrypoint"]) {
        const words = (Array.isArray(s[k]) ? s[k] : []).map(String);
        // Each word, and what follows its first "=" (`--db=<url>`), under the word's index.
        check(`compose.${name}.${k}`, { ...words }, { container: true });
        check(`compose.${name}.${k}`, Object.fromEntries(words.map((w, i) => [i, w.slice(w.indexOf("=") + 1)]).filter(([i, v]) => v !== words[i])), { container: true });
      }
    }
    for (const [kind, all] of [["network", c.networks], ["volume", c.volumes]]) {
      for (const [name, x] of Object.entries(all ?? {})) {
        if (x && x.external) throw new Error(`refused: Compose ${kind} ${name} is external (the project would use one it does not own)`);
        if (x && x.name && !x.name.startsWith(`${project}_`)) throw new Error(`refused: Compose ${kind} ${name} is named ${x.name}, outside the project ${project}`);
        const opts = (x && x.driver_opts) || {};
        if (opts.device && (/\bbind\b/.test(String(opts.o ?? "")) || opts.type === "none")) {
          const no = hostPathRefusal(opts.device, local);
          if (no) throw new Error(`refused: Compose volume ${name} binds ${no}`);
        }
      }
    }
    for (const [kind, all] of [["secret", c.secrets], ["config", c.configs]]) {
      for (const [name, x] of Object.entries(all ?? {})) {
        if (!x || !x.file) continue;
        const real = resolveLink(path.resolve(cwd, x.file));
        if (real === null || within(realMain, real)) throw new Error(`refused: Compose ${kind} ${name} reads a file inside the main checkout`);
      }
    }
  }
  return { services, published: [...published].sort((a, b) => a - b) };
}

/**
 * The daemon's clock now, epoch ms (`docker info`), or null without docker or a running daemon. `up`
 * records it when it starts, as the runtime gate's `since`, so the two clocks never differ.
 */
export function daemonNow({ env, runner = run }) {
  const r = runner(["docker", "info", "--format", "{{json .SystemTime}}"], { env, timeout: 30_000 });
  if (r.error || r.status !== 0) return null;
  let t;
  try {
    t = Date.parse(JSON.parse(r.stdout));
  } catch {
    t = NaN;
  }
  return Number.isFinite(t) ? t : null;
}

/**
 * Container actions on an object the run does not own that the gate refuses (an exec, a stop, a removal,
 * a `docker cp`…). Not `die`: a deliberate end comes as kill, stop or destroy, and a `die` alone is a
 * container ending by itself (the owner's crashing during the cycle).
 */
const CONTAINER_ACTIONS = new Set(["create", "start", "restart", "kill", "stop", "destroy", "pause", "unpause", "update", "rename", "exec_create", "exec_start", "archive-path", "extract-to-dir"]);

/**
 * True for the testcontainers reaper (Ryuk: image `testcontainers/ryuk*`, or the label
 * `org.testcontainers.ryuk=true`): it bind-mounts the Docker socket to remove its own session's
 * containers, so a sweep whose tests use testcontainers can run beside a cycle. It is exempt from the
 * socket rule alone. Not `org.testcontainers=true`: every container testcontainers starts carries it.
 */
function testcontainersReaper(c) {
  const config = (c && c.Config) || {};
  return /^([^/]+\/)*testcontainers\/ryuk[^/]*$/.test(String(config.Image ?? "")) || (config.Labels || {})["org.testcontainers.ryuk"] === "true";
}

/** The command line a container's healthcheck execs, as `docker events` spells it, or null. */
function healthcheckCmd(c) {
  const t = c && c.Config && c.Config.Healthcheck && c.Config.Healthcheck.Test;
  if (!Array.isArray(t) || t.length < 2) return null;
  if (t[0] === "CMD-SHELL") return `/bin/sh -c ${t.slice(1).join(" ")}`;
  return t[0] === "CMD" ? t.slice(1).join(" ") : null;
}

/** The label Compose puts on every container, volume and network of a project. */
const PROJECT_LABEL = "com.docker.compose.project";

/** The event types the gate judges. */
const EVENT_FILTERS = ["--filter", "type=container", "--filter", "type=volume", "--filter", "type=network"];
/** The name of the events follower's group in run.json. */
export const FOLLOWER = "docker-events";

/**
 * Starts the run's events follower (spec §8 step 3): `docker events --since <since - skewMs> --format
 * {{json .}}` for containers, volumes and networks, under the run's env (its Docker client), detached
 * into its own process group recorded in `groups` (so every teardown stops it like any group), its output
 * appended to `<logs>/docker-events.jsonl` (mode 0600). `docker events --since` alone replays only the
 * daemon's last events, so over a long cycle only a follower sees them all. Returns {file, record}.
 */
export async function startEventsFollower({ env, since, logs, cwd, groups = [], skewMs = 1000 }) {
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const file = path.join(logs, "docker-events.jsonl");
  const args = ["events", "--since", ((since - skewMs) / 1000).toFixed(3), "--format", "{{json .}}", ...EVENT_FILTERS];
  const out = fs.openSync(file, "a", 0o600);
  const err = fs.openSync(path.join(logs, "docker-events.log"), "a", 0o600);
  let child;
  try {
    child = spawn("docker", args, { cwd, env, detached: true, stdio: ["ignore", out, err] });
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  await new Promise((ok, fail) => {
    child.once("spawn", ok);
    child.once("error", (e) => fail(new Error(`failed: docker events could not start: ${e.message}`)));
  });
  const record = { name: FOLLOWER, pgid: child.pid, started: startTime(child.pid), cmdline: ["docker", ...args].join(" ") };
  child.once("exit", () => {
    record.exited = true; // from now on, a process holding its pid is not ours
  });
  child.unref();
  groups.push(record);
  return { file, record };
}

/** The follower's events as lines of JSON, and the time of the last one (epoch ms) or null; a torn last line is skipped. */
function followedEvents(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`refused: the docker events follower's file ${file} cannot be read (${e.code || e.message}); the Docker runtime gate cannot see the whole cycle`);
  }
  const events = [];
  let last = null;
  for (const line of text.split("\n")) {
    let e;
    try {
      e = line.trim() ? JSON.parse(line) : null;
    } catch {
      e = null;
    }
    if (!e || typeof e !== "object") continue;
    events.push(e);
    const t = Number.isFinite(e.timeNano) ? e.timeNano / 1e6 : Number.isFinite(e.time) ? e.time * 1000 : NaN;
    if (Number.isFinite(t)) last = last === null ? t : Math.max(last, t);
  }
  return { events, last };
}

/** The real paths of the repo's linked worktrees (`git worktree list`), <MAIN> itself aside; [] when git cannot tell. */
function linkedWorktrees(main, realMain, runner) {
  const r = runner(["git", "-C", main, "worktree", "list", "--porcelain"]);
  if (r.error || r.status !== 0) return [];
  return String(r.stdout)
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => resolveLink(l.slice("worktree ".length)))
    .filter((p) => p && p !== realMain);
}

/**
 * The Docker runtime gate (spec §8 step 8, and at `renew` and `down`): what the static Compose checks
 * cannot see (a script such as `npm run docker:up`) is seen by what it left on the daemon. `since` is the
 * daemon's clock at `up` (epoch ms; `skewMs` earlier, for its whole-second volume times). The rule:
 * - The run's own objects (labelled `com.docker.compose.project=<COMPOSE_PROJECT_NAME>`; a volume may
 *   instead be a new anonymous one): a container of the run may mount only the run's volumes, join only
 *   the run's networks (or none), bind-mount nothing hostPathRefusal refuses, run unprivileged, and
 *   publish only the run's `ports` (never a random one, nor all with `-P`; asked and bound alike).
 * - An object that existed before `since` and is not the run's (the owner's state) may not be touched:
 *   a container of it started during the cycle, or any action on it in the daemon's events
 *   (CONTAINER_ACTIONS: an exec — other than its own healthcheck —, kill, stop, removal, a copy in or
 *   out…; the removal of a volume or network).
 * - An object created during the cycle that is not the run's (a sapu sweep's gate, beside the cycle) is
 *   refused only when it touches the owner's state: a container that mounts a volume that existed before
 *   `since` (listed, or a `volume mount` event, which also shows a container gone by now), joins a
 *   network that did (the default bridge and none aside), bind-mounts the main checkout (a linked
 *   worktree inside it is not the main checkout) or a container runtime or datastore socket (the
 *   testcontainers reaper aside: testcontainersReaper), or is privileged; a volume whose device binds
 *   such a path. What it does to itself is its own.
 * The events: what the follower (`eventsFile`, startEventsFollower) wrote, however long ago, then a
 * catch-up from the last event it saw (`docker events --since <last> --until <daemon now>`); without a
 * follower, the window from `since`. A `follower` group (its run.json record) that no longer runs leaves
 * the gate blind: refused. Runs docker under `env` (the instance's: its DOCKER_HOST). No docker, or no
 * daemon running, means nothing was created through it. Throws `refused: …` naming the object.
 */
export function checkDockerRuntime({ since, env, main, worktree, ports = {}, runner = run, skewMs = 1000, eventsFile = null, follower = null }) {
  const project = env.COMPOSE_PROJECT_NAME;
  const docker = (args) => runner(["docker", ...args], { env, timeout: 60_000 });
  const failed = (args, r) => new Error(`refused: docker ${args.join(" ")} failed: ${tail((r.error && r.error.message) || r.stderr || `exit ${r.status}`)}`);
  const list = (args) => {
    const r = docker(args);
    if (r.error || r.status !== 0) throw failed(args, r);
    return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  };
  const inspect = (args, ids) => {
    if (!ids.length) return [];
    const r = docker([...args, ...ids]);
    let j;
    try {
      j = JSON.parse(r.stdout); // an object removed meanwhile makes it exit 1 with the others listed
    } catch {
      j = null;
    }
    if (!Array.isArray(j)) throw failed(args, r);
    return j;
  };
  const ps = ["ps", "-aq", "--no-trunc"];
  const first = docker(ps);
  if (first.error && first.error.code === "ENOENT") return;
  if (!first.error && first.status !== 0 && /cannot connect to the docker daemon|is the docker daemon running/i.test(first.stderr || "")) return;
  if (first.error || first.status !== 0) throw failed(ps, first);
  if (follower) {
    let now;
    try {
      now = membersOf(processTable(runner), follower.pgid, {});
    } catch (e) {
      throw new Error(`refused: the docker events follower cannot be checked (${e.message}); the Docker runtime gate cannot see the whole cycle`);
    }
    if (!now.length || !sameGroup(follower, now)) throw new Error(`refused: the docker events follower (process group ${follower.pgid}) no longer runs; the Docker runtime gate cannot see the whole cycle`);
  }
  const recent = (t) => {
    const ms = Date.parse(t);
    return Number.isFinite(ms) && ms >= since - skewMs;
  };
  const ours = (labels) => Boolean(labels) && labels[PROJECT_LABEL] === project;
  const volumes = inspect(["volume", "inspect"], list(["volume", "ls", "-q"]));
  const networks = inspect(["network", "inspect"], list(["network", "ls", "-q", "--no-trunc"]));
  const volumeByName = new Map(volumes.map((v) => [v.Name, v]));
  const networkByName = new Map(networks.map((n) => [n.Name, n]));
  const volumeOk = (v) => ours(v.Labels) || (Boolean(v.Labels) && "com.docker.volume.anonymous" in v.Labels && recent(v.CreatedAt));
  const runVolumes = new Set(volumes.filter(volumeOk).map((v) => v.Name));
  const runNetworks = new Set(networks.filter((n) => ours(n.Labels)).map((n) => n.Name));
  const realMain = fs.realpathSync.native(main);
  const at = { worktree, root: fs.realpathSync.native(worktree), realMain, sockets: knownSockets(env) };
  let ownerAt = null;
  const forOthers = () => ownerAt ?? (ownerAt = { ...at, exempt: linkedWorktrees(main, realMain, runner) });
  const runPorts = new Set(Object.values(ports).map(Number));
  const containers = inspect(["inspect", "--type", "container"], first.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
  for (const c of containers) {
    const created = recent(c.Created);
    if (!created && !recent(c.State && c.State.StartedAt)) continue;
    const name = String(c.Name || c.Id).replace(/^\//, "");
    const host = c.HostConfig || {};
    if (!ours(c.Config && c.Config.Labels)) {
      if (!created) throw new Error(`refused: container ${name} existed before the cycle, is not the run's, and was started during it`);
      const why = `refused: container ${name}, created during the cycle outside the run's Compose project ${project},`;
      if (host.Privileged) throw new Error(`${why} is privileged`);
      for (const m of c.Mounts ?? []) {
        const v = m.Type === "volume" ? volumeByName.get(m.Name) : null;
        if (m.Type === "volume" && (!v || !recent(v.CreatedAt))) throw new Error(`${why} mounts volume ${m.Name}, which existed before the cycle`);
        const no = m.Type === "bind" ? hostPathRefusal(m.Source, { ...forOthers(), socketsOk: testcontainersReaper(c) }) : null;
        if (no) throw new Error(`${why} bind-mounts ${no}`);
      }
      for (const n of Object.keys((c.NetworkSettings && c.NetworkSettings.Networks) || {})) {
        if (n === "bridge" || n === "none") continue;
        const net = networkByName.get(n);
        if (!net || !recent(net.Created)) throw new Error(`${why} joins network ${n}, which existed before the cycle`);
      }
      continue;
    }
    if (host.Privileged) throw new Error(`refused: container ${name} is privileged`);
    if (host.PublishAllPorts) throw new Error(`refused: container ${name} publishes every exposed port on a random host port (-P)`);
    // What was asked (PortBindings) and what the daemon bound (NetworkSettings.Ports; null = exposed, not published).
    const bindings = [host.PortBindings, c.NetworkSettings && c.NetworkSettings.Ports].flatMap((x) => Object.entries(x || {}));
    for (const [target, binds] of bindings) {
      for (const b of binds || []) {
        const p = String((b && b.HostPort) || "");
        if (!p) throw new Error(`refused: container ${name} publishes container port ${target} on a random host port`);
        const m = p.match(/^(\d+)(?:-(\d+))?$/);
        for (let n = Number(m ? m[1] : NaN); m && n <= Number(m[2] ?? m[1]); n++) if (!runPorts.has(n)) throw new Error(`refused: container ${name} publishes host port ${n}, which is not one of this run's ports`);
        if (!m) throw new Error(`refused: container ${name} publishes host port ${p}, which is not one of this run's ports`);
      }
    }
    for (const m of c.Mounts ?? []) {
      if (m.Type === "volume" && !runVolumes.has(m.Name)) throw new Error(`refused: container ${name} mounts volume ${m.Name}, which is not the run's`);
      const no = m.Type === "bind" ? hostPathRefusal(m.Source, at) : null;
      if (no) throw new Error(`refused: container ${name} bind-mounts ${no}`);
    }
    for (const n of Object.keys((c.NetworkSettings && c.NetworkSettings.Networks) || {})) {
      if (n !== "none" && !runNetworks.has(n)) throw new Error(`refused: container ${name} joins network ${n}, which is not the run's`);
    }
  }
  for (const v of volumes) {
    if (!recent(v.CreatedAt) || volumeOk(v)) continue;
    const o = v.Options || {};
    const no = o.device && (/\bbind\b/.test(String(o.o ?? "")) || o.type === "none") ? hostPathRefusal(o.device, forOthers()) : null;
    if (no) throw new Error(`refused: volume ${v.Name}, created during the cycle outside the run's Compose project ${project}, binds ${no}`);
  }
  const followed = eventsFile ? followedEvents(eventsFile) : { events: [], last: null };
  const from = Math.max(since - skewMs, followed.last === null ? -Infinity : followed.last - skewMs);
  const now = daemonNow({ env, runner }) ?? Date.now();
  const evArgs = ["events", "--since", (from / 1000).toFixed(3), "--until", (now / 1000).toFixed(3), "--format", "{{json .}}", ...EVENT_FILTERS];
  const er = docker(evArgs);
  if (er.error || er.status !== 0) throw failed(evArgs, er);
  const events = [...followed.events];
  for (const line of er.stdout.split("\n")) {
    try {
      if (line.trim()) events.push(JSON.parse(line));
    } catch {
      // not an event
    }
  }
  const byId = new Map(containers.map((c) => [c.Id, c]));
  // New during the cycle: created in the window (its create event), or listed with a recent creation time.
  const createdNow = new Set([...events.filter((e) => e.Action === "create").map((e) => e.Actor && e.Actor.ID), ...containers.filter((c) => recent(c.Created)).map((c) => c.Id)]);
  // The run's containers, and every container's name, from the listing and from the events (a container
  // gone by now, `docker run --rm`, is in the events alone; container events carry its labels).
  const runContainers = new Set(containers.filter((c) => ours(c.Config && c.Config.Labels)).map((c) => c.Id));
  const nameOf = new Map(containers.map((c) => [c.Id, String(c.Name || c.Id).replace(/^\//, "")]));
  for (const e of events) {
    const a = (e.Type === "container" && e.Actor && e.Actor.Attributes) || {};
    if (a[PROJECT_LABEL] === project) runContainers.add(e.Actor.ID);
    if (a.name && !nameOf.has(e.Actor.ID)) nameOf.set(e.Actor.ID, a.name);
  }
  for (const e of events) {
    const id = (e.Actor && e.Actor.ID) || "";
    const a = (e.Actor && e.Actor.Attributes) || {};
    const action = String(e.Action || "");
    const verb = action.split(":")[0].trim();
    if (e.Type === "volume" && verb === "mount" && !runContainers.has(a.container)) {
      // A container that is not the run's mounted a volume (one gone by now is seen here alone): refused
      // when the volume existed before `since` and is not the run's. One removed since is judged by name.
      const v = volumeByName.get(id);
      const old = v ? !recent(v.CreatedAt) : !createdNow.has(id);
      const runs = v ? volumeOk(v) : String(id).startsWith(`${project}_`);
      if (old && !runs) throw new Error(`refused: during the cycle, container ${nameOf.get(a.container) ?? a.container ?? "(unnamed)"}, which is not of the run's Compose project ${project}, mounted volume ${id}, which existed before it and is not the run's`);
      continue;
    }
    if (e.Type === "container") {
      if (!CONTAINER_ACTIONS.has(verb) || a[PROJECT_LABEL] === project || createdNow.has(id)) continue;
      if (verb.startsWith("exec_") && action.slice(action.indexOf(":") + 1).trim() === healthcheckCmd(byId.get(id))) continue;
      throw new Error(`refused: during the cycle, docker ${verb} hit container ${a.name || id}, which existed before it and is not of the run's Compose project ${project}`);
    }
    if (verb !== "destroy") continue;
    const name = e.Type === "network" ? a.name || id : id;
    if (String(name).startsWith(`${project}_`) || createdNow.has(id)) continue;
    throw new Error(`refused: during the cycle, docker destroy hit ${e.Type} ${name}, which existed before it and is not the run's`);
  }
}

/** checkDockerRuntime's view of a run (`rec`: run.json, or `up`'s state) whose groups are `groups`: since, env, worktree, ports, the follower's file and group. */
export function gateOf(rec, groups = []) {
  return { since: rec.since, env: rec.env, worktree: rec.worktree, ports: rec.ports ?? {}, eventsFile: rec.events ?? null, follower: (groups ?? []).find((g) => g && g.name === FOLLOWER) ?? null };
}
