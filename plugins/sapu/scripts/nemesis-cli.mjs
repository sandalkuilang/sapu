// nemesis-cli.mjs — the two checks the model-driven `sapu:nemesis` skill cannot enforce from prose.
//   coverage <coverage.json> <surface.json> --cycle <id>
//       Proves this cycle's authorization pass against the surface it should cover. A probe is structured, not a
//       sentence: the cycle it was made in, two distinct accounts, a real object (a seeded row of the other subject,
//       or a fixture this cycle created), the foreign status and the outcome. A read is judged by the owner's own 2xx
//       (the positive control) and the foreign answer; a write by the owner reading the object back after the
//       foreign attempt. A leak counts as probed and is listed to file. Exit 0 = every id-bearing endpoint has a real
//       probe from this cycle; 1 = not complete; 2 = bad input.
//   gate <url-or-host> [...]
//       Applies the engine host floor to each authorized target, read the way the attacking clients (WHATWG: fetch,
//       browsers) read it: a name must be localhost, *.localhost or *.test and resolve to loopback only; an IP
//       address must be loopback (a private one is listed for the skill's authorization.yml check); a spelling URL
//       parsers could read two ways is refused. Exit 0 = passes; 1 = a refusal; 2 = bad input.
// Pure functions (coverageReport, hostOf, hostFloor, gateVerdict) carry the logic and are unit-tested.
import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";

const OUTCOMES = new Set(["denied", "leaked"]);
const SOURCES = new Set(["seeded", "fixture"]);
const AFTER = new Set(["unchanged", "changed"]);
const isStatus = (n) => Number.isInteger(n) && n >= 100 && n <= 599;
const is2xx = (n) => isStatus(n) && n >= 200 && n <= 299;
const isEndpoint = (e) => typeof e === "string" && /^[A-Z]+ \/\S*$/.test(e);
/** read or write: as declared (a PATCH, PUT or DELETE declared a read is refused in probeIssue), else by method (GET, HEAD and OPTIONS read; everything else writes). */
const accessOf = (p) => (p.access === "read" || p.access === "write" ? p.access : /^(GET|HEAD|OPTIONS) /.test(p.endpoint) ? "read" : "write");

/** The reason one probe does not count as coverage for `cycle`, or null when it is a real ownership probe. */
function probeIssue(p, cycle) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return "not a probe object";
  if (!isEndpoint(p.endpoint)) return 'endpoint must be the "METHOD /path" string exactly as surface.id_bearing lists it';
  const sameCycle = (typeof p.cycle === "string" || typeof p.cycle === "number") && String(p.cycle) === String(cycle);
  if (cycle !== undefined && !sameCycle)
    return `recorded in cycle ${JSON.stringify(p.cycle ?? null)}, not this cycle ${JSON.stringify(cycle)} — coverage.json is rewritten every cycle; a stale probe proves nothing now`;
  const actors = Array.isArray(p.actors) ? new Set(p.actors.filter((a) => typeof a === "string" && a.trim()).map((a) => a.trim().toLowerCase())) : new Set();
  if (actors.size < 2) return "needs two accounts — two distinct named actors, the owner and the other subject";
  if (!SOURCES.has(p.object_source))
    return 'the swapped id must be a real row — a seeded row of the other subject (object_source "seeded") or a fixture this cycle created (object_source "fixture"); a random, ghost or guessed id proves only that a row is absent';
  if (p.access !== undefined && p.access !== "read" && p.access !== "write") return 'access must be "read" or "write"';
  if (p.access === "read" && /^(PATCH|PUT|DELETE) /.test(p.endpoint)) return "a PATCH, PUT or DELETE is always a write — judge it by the owner's read-back (owner_after), never declare it a read";
  if (!isStatus(p.foreign_status)) return "record the other subject's request status as foreign_status (an HTTP status, 100-599)";
  if (!OUTCOMES.has(p.outcome)) return 'outcome must be "denied" or "leaked"';
  if (accessOf(p) === "read") {
    if (!is2xx(p.owner_status)) return "no positive control — owner_status must be the owner's own 2xx on the same object, else a foreign 404 proves nothing";
    const got = is2xx(p.foreign_status);
    if (p.outcome === "denied" && got && p.foreign_body !== "empty")
      return 'outcome "denied" but the other subject got a 2xx — if that answer carried none of the object (an empty or scoped result), record foreign_body "empty"; otherwise it leaked';
    if (p.outcome === "leaked" && !got) return `outcome "leaked" but the other subject got ${p.foreign_status} — a read leaks only through a 2xx that carries the object`;
    return null;
  }
  if (!AFTER.has(p.owner_after))
    return 'a write is judged by the owner reading the object back after the foreign attempt — record owner_after "unchanged" or "changed"; the foreign response, or foreign_body, never decides it';
  if (p.object_source !== "fixture") return 'a write targets a disposable fixture this cycle created as the owner (object_source "fixture"), never shared seed data';
  if (p.owner_after === "changed" && p.outcome !== "leaked") return 'owner_after "changed" means the foreign write took effect — outcome must be "leaked"';
  if (p.owner_after === "unchanged" && p.outcome !== "denied") return 'owner_after "unchanged" means the foreign write did nothing — outcome must be "denied"';
  if (p.owner_after === "unchanged" && !is2xx(p.owner_status)) return "no positive control — owner_status must be the owner's own 2xx read-back of the untouched object";
  return null;
}

/**
 * What this cycle's authorization/BOLA pass covered. `coverage.probes` is the cycle's record; `surface.id_bearing` lists
 * every endpoint that takes an object id, as "METHOD /path" strings; `cycle` is this cycle's id (a probe from another
 * cycle is weak). Returns {total, probed, weak, uncovered, offSurface, badSurface, leaks, ok, lines}: `probed` counts
 * distinct id-bearing endpoints with at least one real probe; `weak` names each rejected probe and why; `uncovered` names
 * id-bearing endpoints with no real probe; `offSurface` names probed endpoints the surface does not list (the
 * denominator is short); `badSurface` names surface entries that are not "METHOD /path" strings; `leaks` are real probes
 * whose outcome is "leaked" — findings to file, never a reason to fail coverage. `ok` holds only when the surface is
 * non-empty and nothing is weak, uncovered, off-surface or malformed.
 */
export function coverageReport({ coverage = {}, surface = {}, cycle } = {}) {
  const isList = Array.isArray(surface.id_bearing);
  const rawSurface = isList ? surface.id_bearing : surface.id_bearing === undefined ? [] : [surface.id_bearing];
  const idBearing = isList ? [...new Set(rawSurface.filter(isEndpoint))] : [];
  const badSurface = (isList ? rawSurface.filter((e) => !isEndpoint(e)) : rawSurface).map((e) => (isList ? "" : "id_bearing is not a list: ") + (JSON.stringify(e) ?? String(e)));
  const listed = new Set(idBearing);
  const probes = Array.isArray(coverage.probes) ? coverage.probes : [];
  const weak = [];
  const leaks = [];
  const covered = new Set();
  for (const p of probes) {
    const reason = probeIssue(p, cycle);
    if (reason) {
      weak.push({ endpoint: p && typeof p === "object" ? p.endpoint : String(p), reason });
      continue;
    }
    covered.add(p.endpoint);
    if (p.outcome === "leaked") leaks.push({ endpoint: p.endpoint, object: p.object, actors: p.actors, foreign_status: p.foreign_status, access: accessOf(p) });
  }
  const uncovered = idBearing.filter((e) => !covered.has(e));
  const offSurface = [...covered].filter((e) => !listed.has(e));
  const probed = idBearing.filter((e) => covered.has(e)).length;
  const ok = idBearing.length > 0 && badSurface.length === 0 && weak.length === 0 && uncovered.length === 0 && offSurface.length === 0;
  const list = (title, rows) => (rows.length ? [`${title}: ${rows.length}`, ...rows.map((r) => `  - ${r}`)] : []);
  const lines = [
    `coverage: ${probed} / ${idBearing.length} id-bearing endpoints probed for ownership`,
    ...list(
      "LEAKED — file each as a finding",
      leaks.map((l) => `${l.endpoint} (${l.object ?? "object"}: ${l.access === "write" ? "the other subject's write took effect" : `the other subject got ${l.foreign_status}`})`),
    ),
    ...list("weak (do not count; fix or delete each)", weak.map((w) => `${w.endpoint}: ${w.reason}`)),
    ...list("uncovered id-bearing endpoints", uncovered),
    ...list("probed but missing from surface.id_bearing — the surface is short, add them", offSurface),
    ...list('surface.id_bearing entries not a "METHOD /path" string', badSurface),
    ok
      ? "OK — every id-bearing endpoint has a real ownership probe from this cycle"
      : rawSurface.length === 0
        ? "NOT PROVEN — the surface lists no id-bearing endpoints; map them from recon first (an empty surface is unproven, not 'nothing to test')"
        : "NOT COMPLETE — see the lists above",
  ];
  return { total: idBearing.length, probed, weak, uncovered, offSurface, badSurface, leaks, ok, lines };
}

/**
 * The host an authorization target names, read the way the clients that will attack it do. An http(s), ws(s) or ftp
 * URL is parsed by WHATWG with any number of slashes (`http:/evil` is evil to fetch and curl alike); a scheme-less
 * `host`, `host:port` or bare IPv6 address is read as http. Anything else is refused as ambiguous and resolves nothing
 * (""): another scheme (`file:`, `smtp:`), a `word:` prefix not followed by a port (`u:p@host` could be scheme `u`), and
 * any target with whitespace, a control character or a backslash, which parsers split differently.
 */
export function hostOf(target) {
  const raw = String(target).trim();
  if (!raw || /[\s\\\x00-\x1f\x7f-\x9f]/.test(raw)) return ""; // \s also covers the line and paragraph separators
  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):/i);
  let tries;
  if (/^[0-9a-f:.]+$/i.test(raw) && (raw.match(/:/g) ?? []).length > 1) tries = [`http://[${raw}]`]; // a bare IPv6 literal
  else if (scheme && /^(https?|wss?|ftp)$/i.test(scheme[1])) tries = [raw];
  else if (scheme && !/^\d/.test(raw.slice(scheme[0].length))) return "";
  else tries = [`http://${raw}`];
  for (const u of tries) {
    try {
      return new URL(u).hostname.replace(/^\[(.*)\]$/, "$1");
    } catch {
      // unparsable: resolves nothing
    }
  }
  return "";
}

const isLoopback = (ip) => ip === "::1" || /^127\./.test(ip);
const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || /^(fc|fd)/i.test(ip);

/**
 * The engine host floor's address rule over already-resolved targets. `resolved` is [{host, addresses:[ip],
 * authorizedPrivate?}]. Refuses a host that resolves to nothing, to any public or other non-local address (one among
 * loopback ones is enough), or to a private address not marked dev. Loopback-only hosts, and authorized-dev private
 * hosts, pass. Returns the refusals in input order. It judges one lookup; gateVerdict adds the name rule, which is what
 * keeps a name from rebinding to somewhere else between this check and the attack.
 */
export function hostFloor(resolved = []) {
  const out = [];
  for (const t of resolved) {
    const a = Array.isArray(t.addresses) ? t.addresses : [];
    if (a.length === 0) out.push({ host: t.host, reason: "resolves to no address — nothing to attack, fail closed" });
    else if (a.some((ip) => !isLoopback(ip) && !isPrivate(ip))) out.push({ host: t.host, reason: "resolves to a public or non-local address — refused even when listed" });
    else if (a.some((ip) => isPrivate(ip)) && !t.authorizedPrivate) out.push({ host: t.host, reason: "resolves to a private address not marked dev in the authorization" });
  }
  return out;
}

/**
 * What `gate` decides, split from the CLI so it can be tested without DNS. `resolved` is [{host, addresses, ambiguous?}]
 * with `host` as hostOf read it. The floor's name rule: a name passes only as localhost, *.localhost or *.test and only
 * when every address it resolves to is loopback (a public DNS name can rebind; a private dev host is named by its IP).
 * An IP address passes when loopback; a private one is an advisory, since the CLI cannot read authorization.yml and the
 * skill confirms it there. shortcut: private-dev addresses are not confirmed here; upgrade if the CLI ever reads that
 * file. Returns {hard: refusals, advisory: private IP targets}.
 */
export function gateVerdict(resolved = []) {
  const hard = [];
  const advisory = [];
  for (const t of resolved) {
    if (t.ambiguous) {
      hard.push({ host: t.host, reason: "ambiguous target — URL parsers could read it two ways, or it is not an http(s)/ws(s)/ftp URL or a host[:port]; rewrite it as http://host:port" });
      continue;
    }
    const name = String(t.host).toLowerCase().replace(/\.$/, "");
    const ip = net.isIP(name) !== 0;
    if (!ip && !(name === "localhost" || name.endsWith(".localhost") || name.endsWith(".test"))) {
      hard.push({ host: t.host, reason: "name not allowed by the floor — only localhost, *.localhost, *.test or an IP address; a public DNS name can rebind" });
      continue;
    }
    const a = Array.isArray(t.addresses) ? t.addresses : [];
    if (!ip) {
      if (a.length === 0) hard.push({ host: t.host, reason: "resolves to no address — nothing to attack, fail closed" });
      else if (!a.every(isLoopback)) hard.push({ host: t.host, reason: "a name must resolve to loopback only — name a private dev host by its IP address" });
      continue;
    }
    const [refusal] = hostFloor([{ ...t, authorizedPrivate: true }]);
    if (refusal) hard.push(refusal);
    else if (a.some(isPrivate)) advisory.push(t);
  }
  return { hard, advisory };
}

class InputError extends Error {}

function readJson(p) {
  try {
    const v = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a JSON object");
    return v;
  } catch (e) {
    throw new InputError(`cannot read ${p}: ${e.message.split("\n")[0]}`);
  }
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "coverage") {
    const eq = rest.find((a) => a.startsWith("--cycle="));
    const at = rest.indexOf("--cycle");
    const cycle = eq ? eq.slice("--cycle=".length) : at >= 0 ? rest[at + 1] : undefined;
    const [covPath, surfPath] = rest.filter((a, i) => a !== eq && (at < 0 || (i !== at && i !== at + 1)));
    if (!covPath || !surfPath || !cycle) throw new InputError("usage: nemesis-cli.mjs coverage <coverage.json> <surface.json> --cycle <this cycle's id> (or --cycle=<id>)");
    const coverage = readJson(covPath);
    const surface = readJson(surfPath);
    if (!Array.isArray(coverage.probes)) throw new InputError(`${covPath} has no "probes" list`);
    if (!("id_bearing" in surface)) throw new InputError(`${surfPath} has no "id_bearing" list — one "METHOD /path" string per id-bearing endpoint`);
    const r = coverageReport({ coverage, surface, cycle });
    process.stdout.write(`${r.lines.join("\n")}\n`);
    return r.ok ? 0 : 1;
  }
  if (cmd === "gate") {
    if (rest.length === 0) throw new InputError("usage: nemesis-cli.mjs gate <url-or-host> [url-or-host...]");
    const resolved = await Promise.all(
      rest.map(async (target) => {
        const host = hostOf(target);
        if (!host) return { host: JSON.stringify(target), addresses: [], ambiguous: true };
        try {
          const addrs = await dns.promises.lookup(host, { all: true });
          return { host, addresses: addrs.map((x) => x.address) };
        } catch {
          return { host, addresses: [] };
        }
      }),
    );
    const { hard, advisory } = gateVerdict(resolved);
    if (hard.length) {
      process.stdout.write(`host floor REFUSED ${hard.length} target(s):\n${hard.map((r) => `  - ${r.host}: ${r.reason}`).join("\n")}\n`);
      return 1;
    }
    if (advisory.length) {
      process.stdout.write(`host floor OK (no public address). Confirm authorization.yml names and marks dev each private address: ${advisory.map((t) => `${t.host} (${t.addresses.join(", ")})`).join("; ")}\n`);
      return 0;
    }
    process.stdout.write(`host floor: ${rest.length} target(s) resolve loopback — OK\n`);
    return 0;
  }
  throw new InputError("usage: nemesis-cli.mjs <coverage|gate> ...");
}

// Run as a script however it was reached — a path with spaces, a symlink, --preserve-symlinks-main — by comparing real
// paths, never URL spellings: a missed match would turn the CLI into a silent exit 0. process.exitCode, not
// process.exit, so a long report written to a pipe drains before the process ends.
let invoked = false;
try {
  invoked = Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
} catch {
  // imported from somewhere whose argv[1] is not a file: not a CLI run
}
if (invoked) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`${String(e && e.message ? e.message : e).split("\n")[0]}\n`);
      process.exitCode = e instanceof InputError ? 2 : 1;
    },
  );
}
