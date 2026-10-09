// argus-live-scrub.mjs — the last check before a journey finding leaves the machine (spec §10 "Scrub",
// decisions 14, 17): `argus-live.mjs scrub` refuses an issue whose title or body holds any secret the run
// saw or the configuration holds — in any encoding the matcher knows, naming where and never what —,
// redacts every other long letter-and-digit token the run never saw as an id, and defangs mentions,
// references and outside links outside code. It reads only files a `down` keeps (the run's ledger and
// seen ids, the configuration), so a run that is down is scrubbed the same way.
import fs from "node:fs";
import { expand, LIVE_FILE, loadLive } from "./argus-live-config.mjs";
import { normHost, ownerEnvFiles } from "./argus-live-endpoints.mjs";
import { highEntropy, MIN_SECRET, readLedger, readSeen, SECRET_KEY, secretHits } from "./argus-live-ledger.mjs";
import { lastRun } from "./argus-live-lock.mjs";
import { recordedSecrets } from "./argus-live-run.mjs";
import { loadContract } from "./sapu-contract.mjs";

/**
 * A source that mixes configuration with secrets gives only what is secret-like: a SECRET_KEY name or a
 * highEntropy value, at least MIN_SECRET long — a shorter one is a flag (`CHILD_SESSION=1`), and as a
 * whole token it would refuse every issue, as a short ledger value would.
 */
const secretLike = (name, v) => String(v).length >= MIN_SECRET && (SECRET_KEY.test(String(name)) || highEntropy(v));

/**
 * Every secret scrub refuses for run `runId` → `{secrets: [{cls, label, v}], refusal}` (decision 17;
 * `label` names the source, never the value; empty values dropped): `env file` (every value of
 * `env_file`, now and as `up` read it), `repo env file` (the owner's env files, secret-like only), `role
 * password` and `TOTP secret` (`.argus/live.json`'s roles, expanded), `environment variable <NAME>`
 * (`env`, secret-like only) and the ledger's `cookie`, `header`, `storage` and `created password`.
 * `refusal` is the line that ends scrub instead: a ledger that is gone, damaged or incomplete (decision
 * 14), or a configuration or contract that cannot be read (its secrets would be unknown).
 */
export function scrubSecrets(main, { runId, env = process.env } = {}) {
  const secrets = [];
  const add = (cls, label, v) => {
    if (typeof v === "string" && v !== "") secrets.push({ cls, label, v });
  };
  const { config, errors, secrets: envFile } = loadLive(main);
  if (!config || errors.length) return { secrets, refusal: `refused: scrub: ${LIVE_FILE}: ${errors.join("; ")}; nothing is filed` };
  const c = loadContract(main);
  if (!c.contract && !c.missing) return { secrets, refusal: `refused: scrub: ${c.error}` };
  for (const [k, v] of Object.entries({ ...recordedSecrets(main, config), ...envFile })) add("env file", `env file ${k}`, v);
  for (const { file, vars } of ownerEnvFiles(main, c.contract ?? null)) for (const [k, v] of Object.entries(vars)) if (secretLike(k, v)) add("repo env file", `${file} ${k}`, v);
  const expanded = (v) => {
    try {
      return expand(v, { ports: {}, secrets: envFile });
    } catch {
      return null; // a `${NAME}` the env file lacks: no value to look for
    }
  };
  for (const [role, r] of Object.entries(config.roles ?? {})) {
    (r && Array.isArray(r.users) ? r.users : []).forEach((u, i) => {
      if (u && typeof u.password === "string") add("role password", `${role}.${i + 1} password`, expanded(u.password));
      if (u && typeof u.totp_secret === "string") add("TOTP secret", `${role}.${i + 1} totp_secret`, expanded(u.totp_secret));
    });
  }
  for (const [k, v] of Object.entries(env ?? {})) if (typeof v === "string" && secretLike(k, v)) add(`environment variable ${k}`, k, v);
  let ledger;
  try {
    ledger = readLedger(main, runId);
  } catch (e) {
    return { secrets, refusal: e.message };
  }
  if (!ledger) return { secrets, refusal: "refused: scrub: the run's secret ledger is gone (a later up removed it); nothing from this run is filed" };
  if (ledger.incomplete !== null) return { secrets, refusal: `refused: scrub: the run's secret ledger is incomplete (${ledger.incomplete}); nothing from this run is filed` };
  for (const e of ledger.entries) if (e.c !== "incomplete") add(e.c, "ledger", e.v);
  return { secrets, refusal: null };
}

/**
 * `text` with every run of 24+ `[A-Za-z0-9_-]` that holds a letter and a digit, is not all hex (a commit
 * sha stays) and is not among `seen` (the ids the run's pages saw) → `<redacted>` → `{text, count}`.
 */
export function redactIds(text, seen) {
  let count = 0;
  const out = String(text ?? "").replace(/[A-Za-z0-9_-]{24,}/g, (m) => {
    if (!/[A-Za-z]/.test(m) || !/[0-9]/.test(m) || /^[0-9A-Fa-f]+$/.test(m) || seen.has(m)) return m;
    count += 1;
    return "<redacted>";
  });
  return { text: out, count };
}

/**
 * What GitHub would turn into a notification, a cross-reference or a link: an `http(s)` URL or a `www.`
 * host (its trailing punctuation left out), `owner/repo#<n>`, `GH-<n>`, `#<n>` and an `@user` or
 * `@org/team` mention — each with the backslashes right before it, which a code span then holds.
 */
const LIVE = /(\\*)((?:https?:\/\/|\bwww\.)[^\s<>"'`]+|\b[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+#[0-9]+|\bGH-[0-9]+\b|(?<!&)#[0-9]+|(?<![A-Za-z0-9_.+\-/])@[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)?)/g;

/** A URL's host is loopback (the run's own app): such a link stays. */
const loopbackUrl = (u) => {
  try {
    return /^https?:/.test(u) && normHost(new URL(u).hostname) === "loopback";
  } catch {
    return false;
  }
};

/**
 * One line of prose with its live tokens (LIVE) wrapped in backticks, outside code spans → `{text, n}`.
 * A code span is a backtick run closed by a run of the same length on the same line (CommonMark); a run
 * escaped by a backslash opens none. A run with no closer on its line, and a span holding a `|` (GFM
 * splits a table row there, span or not), are escaped instead: no span then crosses a line or a cell, so
 * what is code here is code on GitHub too.
 */
function defangLine(line) {
  let n = 0;
  const plain = (s) =>
    s.replace(LIVE, (m, slashes, token) => {
      const trail = /^https?:|^www\./.test(token) ? /[.,;:!?)\]]+$/.exec(token)?.[0] ?? "" : "";
      const core = token.slice(0, token.length - trail.length);
      if (loopbackUrl(core)) return m;
      n += 1;
      return `\`${slashes}${core}\`${trail}`;
    });
  let out = "";
  let last = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\\") {
      i += 2;
      continue;
    }
    if (line[i] !== "`") {
      i += 1;
      continue;
    }
    let j = i;
    while (line[j] === "`") j += 1;
    let close = -1;
    for (let k = j; k < line.length; ) {
      if (line[k] !== "`") {
        k += 1;
        continue;
      }
      let e = k;
      while (line[e] === "`") e += 1;
      if (e - k === j - i) {
        close = k;
        break;
      }
      k = e;
    }
    if (close >= 0 && !line.slice(j, close).includes("|")) {
      out += plain(line.slice(last, i)) + line.slice(i, close + (j - i));
      i = last = close + (j - i);
    } else {
      out += `${plain(line.slice(last, i))}${"\\`".repeat(j - i)}`;
      i = last = j;
    }
  }
  return { text: out + plain(line.slice(last)), n };
}

/** A fence's opening line (CommonMark): up to three spaces, three or more backticks or tildes, an info string. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** A fenced block left whole: the generated test and the repro. */
const WHOLE_INFO = ["ts", "typescript", "json"];
/** The most lines any other fenced block keeps. */
const FENCE_LINES = 20;

/**
 * Markdown `md` defanged (decision 17) → `{text, defanged, cut}`: outside fenced blocks and code spans,
 * as CommonMark reads them (defangLine), every live token wrapped in backticks but a loopback URL; a
 * fenced block (an opening run of 3+ backticks or tildes, a backtick fence's info string holding none,
 * closed by the same character at least as long, else open to the end) is left whole when its info
 * string is `ts`, `typescript` or `json`, and otherwise keeps its first 20 lines and `… <k> lines cut`.
 */
export function defang(md) {
  const lines = String(md ?? "").split("\n");
  const out = [];
  let defanged = 0;
  let cut = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_OPEN.exec(lines[i]);
    if (!m || (m[1][0] === "`" && m[2].includes("`"))) {
      const d = defangLine(lines[i]);
      defanged += d.n;
      out.push(d.text);
      continue;
    }
    const close = new RegExp(`^ {0,3}${m[1][0]}{${m[1].length},} *$`);
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j])) j += 1;
    const content = lines.slice(i + 1, j);
    const whole = WHOLE_INFO.includes((m[2].trim().split(/\s+/)[0] ?? "").toLowerCase());
    out.push(lines[i]);
    if (whole || content.length <= FENCE_LINES) out.push(...content);
    else {
      out.push(...content.slice(0, FENCE_LINES), `… ${content.length - FENCE_LINES} lines cut`);
      cut += content.length - FENCE_LINES;
    }
    if (j < lines.length) out.push(lines[j]);
    i = j;
  }
  return { text: out.join("\n"), defanged, cut };
}

/** `secretHits` on the title and the body → the refusal's lines, `<title|body> <line>:<col> <class>` then the count; none → []. */
function refusalLines(title, body, secrets) {
  const hits = [...secretHits(title, secrets).map((h) => ({ ...h, where: "title" })), ...secretHits(body, secrets).map((h) => ({ ...h, where: "body" }))];
  return hits.length ? [...hits.map((h) => `${h.where} ${h.line}:${h.col} ${h.cls}`), `refused: scrub: ${hits.length} secret(s) in the issue; nothing is filed`] : [];
}

/**
 * `argus-live.mjs scrub --title <t> --body <file>` → `{code, out}`. The run is the lock's, else the newest
 * run directory (a run that is down is read the same way). scrubSecrets' refusal → that line (exit 1); a
 * secret in the title or the body as given → one line per hit, `<title|body> <line>:<col> <class>`, then
 * `refused: scrub: <k> secret(s) in the issue; nothing is filed` (exit 1, the file untouched; never a
 * value, never the text around it); else both redacted (redactIds, the run's seen ids) and defanged, the
 * body file rewritten in place, `scrub: ok; redacted <n>, defanged <n>, cut <n> line(s)` and `title: <the
 * scrubbed title>` (exit 0).
 */
export async function scrub(main, { title, bodyFile } = {}, { env = process.env } = {}) {
  const runId = lastRun(main);
  if (!runId) return { code: 1, out: ["refused: scrub: no journey cycle has run here; nothing is filed"] };
  const t = String(title ?? "");
  if (/[\r\n]/.test(t)) return { code: 1, out: ["refused: scrub: a title is one line"] };
  const { secrets, refusal } = scrubSecrets(main, { runId, env });
  if (refusal) return { code: 1, out: [refusal] };
  let body;
  try {
    body = fs.readFileSync(bodyFile, "utf8");
  } catch (e) {
    return { code: 1, out: [`refused: scrub: the body file cannot be read (${(e && e.code) || "error"})`] };
  }
  const given = refusalLines(t, body, secrets);
  if (given.length) return { code: 1, out: given };
  const seen = readSeen(main, runId);
  const rt = redactIds(t, seen);
  const rb = redactIds(body, seen);
  const dt = defang(rt.text);
  const db = defang(rb.text);
  // What is filed is checked as well as what was given: nothing a rewrite made may carry a secret either.
  const made = refusalLines(dt.text, db.text, secrets);
  if (made.length) return { code: 1, out: made };
  fs.writeFileSync(bodyFile, db.text);
  return { code: 0, out: [`scrub: ok; redacted ${rt.count + rb.count}, defanged ${dt.defanged + db.defanged}, cut ${db.cut} line(s)`, `title: ${dt.text}`] };
}
