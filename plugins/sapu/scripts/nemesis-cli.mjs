// nemesis-cli.mjs — the two checks the model-driven `sapu:nemesis` skill cannot enforce from prose.
//   coverage <coverage.json> <surface.json>  — proves the authorization pass against the surface it should cover.
//                                              A probe is structured, not a sentence: two distinct accounts, a
//                                              seeded object of the other subject, the owner's own 2xx (the positive
//                                              control), the foreign request's status and its outcome (denied or
//                                              leaked). A leak counts as probed and is listed to file. Exit 0 = every
//                                              id-bearing endpoint has a real probe; 1 = not complete; 2 = bad input.
//   gate <url-or-host> [...]                  — resolves each authorized target, read the way the attacking clients
//                                              (WHATWG: fetch, browsers) read it, and refuses any that resolves to a
//                                              public address or to nothing. Exit 1 = a refusal; 2 = bad input.
// Pure functions (coverageReport, hostOf, hostFloor, gateVerdict) carry the logic and are unit-tested.
import dns from "node:dns";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const OUTCOMES = new Set(["denied", "leaked"]);
const isStatus = (n) => Number.isInteger(n) && n >= 100 && n <= 599;
const isEndpoint = (e) => typeof e === "string" && /^[A-Z]+ \/\S*$/.test(e);

/** The reason one probe does not count as coverage, or null when it is a real ownership probe. */
function probeIssue(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return "not a probe object";
  if (!isEndpoint(p.endpoint)) return 'endpoint must be the "METHOD /path" string exactly as surface.id_bearing lists it';
  const actors = Array.isArray(p.actors) ? new Set(p.actors.filter((a) => typeof a === "string" && a.trim()).map((a) => a.trim().toLowerCase())) : new Set();
  if (actors.size < 2) return "needs two accounts — two distinct named actors, the owner and the other subject";
  if (p.object_source !== "seeded") return 'the swapped id must be a real seeded row of the other subject (object_source "seeded"); a random, ghost or guessed id proves only that a row is absent';
  if (!isStatus(p.owner_status) || p.owner_status < 200 || p.owner_status > 299) return "no positive control — owner_status must be the owner's own 2xx on the same object, else a foreign 404 proves nothing";
  if (!isStatus(p.foreign_status)) return "record the other subject's request status as foreign_status (an HTTP status, 100-599)";
  if (!OUTCOMES.has(p.outcome)) return 'outcome must be "denied" or "leaked"';
  const got = p.foreign_status >= 200 && p.foreign_status <= 299;
  if (p.outcome === "denied" && got && p.foreign_body !== "empty") return 'outcome "denied" but the other subject got a 2xx — if that answer carried none of the object (an empty or scoped result), record foreign_body "empty"; otherwise it leaked';
  if (p.outcome === "leaked" && !got) return `outcome "leaked" but the other subject got ${p.foreign_status} — a leak is a 2xx that carries the object`;
  return null;
}

/**
 * What the authorization/BOLA pass actually covered. `coverage.probes` is the cycle's record; `surface.id_bearing` is
 * every endpoint that carries an object id. Returns {total, probed, weak, uncovered, offSurface, leaks, ok, lines}:
 * `probed` counts distinct id-bearing endpoints with at least one real probe; `weak` names each rejected probe and why;
 * `uncovered` names id-bearing endpoints with no real probe; `offSurface` names probed endpoints the surface does not list
 * (the denominator is short); `leaks` are real probes whose outcome is "leaked" — findings to file, never a reason to
 * fail coverage. `ok` holds only when the surface is non-empty and nothing is weak, uncovered or off-surface.
 */
export function coverageReport({ coverage = {}, surface = {} } = {}) {
  const isList = Array.isArray(surface.id_bearing);
  const rawSurface = isList ? surface.id_bearing : surface.id_bearing === undefined ? [] : [surface.id_bearing];
  const idBearing = isList ? rawSurface.filter(isEndpoint) : [];
  const badSurface = (isList ? rawSurface.filter((e) => !isEndpoint(e)) : rawSurface).map((e) => (isList ? "" : "id_bearing is not a list: ") + (JSON.stringify(e) ?? String(e)));
  const listed = new Set(idBearing);
  const probes = Array.isArray(coverage.probes) ? coverage.probes : [];
  const weak = [];
  const leaks = [];
  const covered = new Set();
  for (const p of probes) {
    const reason = probeIssue(p);
    if (reason) {
      weak.push({ endpoint: p && typeof p === "object" ? p.endpoint : String(p), reason });
      continue;
    }
    covered.add(p.endpoint);
    if (p.outcome === "leaked") leaks.push({ endpoint: p.endpoint, object: p.object, actors: p.actors, foreign_status: p.foreign_status });
  }
  const uncovered = idBearing.filter((e) => !covered.has(e));
  const offSurface = [...covered].filter((e) => !listed.has(e));
  const probed = idBearing.filter((e) => covered.has(e)).length;
  const ok = idBearing.length > 0 && badSurface.length === 0 && weak.length === 0 && uncovered.length === 0 && offSurface.length === 0;
  const list = (title, rows) => (rows.length ? [`${title}: ${rows.length}`, ...rows.map((r) => `  - ${r}`)] : []);
  const lines = [
    `coverage: ${probed} / ${idBearing.length} id-bearing endpoints probed for ownership`,
    ...list("LEAKED — file each as a finding", leaks.map((l) => `${l.endpoint} (${l.object ?? "object"}: other subject got ${l.foreign_status})`)),
    ...list("weak (do not count)", weak.map((w) => `${w.endpoint}: ${w.reason}`)),
    ...list("uncovered id-bearing endpoints", uncovered),
    ...list("probed but missing from surface.id_bearing — the surface is short, add them", offSurface),
    ...list('surface.id_bearing entries not a "METHOD /path" string', badSurface),
    ok
      ? "OK — every id-bearing endpoint has a real ownership probe"
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
  if (!raw || /[\s\\\x00-\x1f\x7f-\x9f]/.test(raw)) return ""; // \s also covers U+2028/U+2029
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
 * The engine host floor over already-resolved targets. `resolved` is [{host, addresses:[ip], authorizedPrivate?}].
 * Refuses a host that resolves to nothing, to any public address (one public address among loopback ones is enough),
 * or to a private address not marked dev. Loopback-only hosts, and authorized-dev private hosts, pass. Returns the
 * refusals in input order. It judges one lookup: a name that resolves differently later (DNS rebinding between this
 * check and the attack) is the network containment's to stop, not this floor's.
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
 * What `gate` prints, split from the CLI so it can be tested without DNS. The CLI knows only the targets, not
 * authorization.yml, so it hard-refuses what is wrong regardless (a public address, or none) and leaves a private
 * address as an advisory the skill reconciles against the owner-signed `authorization.yml`.
 * shortcut: private-dev addresses are not confirmed here; the skill's hard gate still checks each against
 * authorization.yml. Upgrade if the CLI ever reads that file. Returns {hard: refusals, advisory: private-only hosts}.
 */
export function gateVerdict(resolved = []) {
  const hard = hostFloor(resolved.map((t) => ({ ...t, authorizedPrivate: true })));
  const advisory = resolved.filter((t) => Array.isArray(t.addresses) && t.addresses.length > 0 && t.addresses.some(isPrivate) && !t.addresses.some((ip) => !isLoopback(ip) && !isPrivate(ip)));
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
    const [covPath, surfPath] = rest;
    if (!covPath || !surfPath) throw new InputError("usage: nemesis-cli.mjs coverage <coverage.json> <surface.json>");
    const r = coverageReport({ coverage: readJson(covPath), surface: readJson(surfPath) });
    process.stdout.write(`${r.lines.join("\n")}\n`);
    return r.ok ? 0 : 1;
  }
  if (cmd === "gate") {
    if (rest.length === 0) throw new InputError("usage: nemesis-cli.mjs gate <url-or-host> [url-or-host...]");
    const resolved = await Promise.all(
      rest.map(async (target) => {
        const host = hostOf(target);
        if (!host) return { host: JSON.stringify(target), addresses: [] };
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

// Run as a script however it was reached: a path with spaces (percent-encoded in import.meta.url) or a symlink
// (import.meta.url is the real path) must not turn the CLI into a silent exit 0.
// process.exitCode, not process.exit: a long report written to a pipe must drain before the process ends.
let invoked = "";
try {
  invoked = process.argv[1] ? pathToFileURL(fs.realpathSync(process.argv[1])).href : "";
} catch {
  // imported from somewhere whose argv[1] is not a file: not a CLI run
}
if (invoked && import.meta.url === invoked) {
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
