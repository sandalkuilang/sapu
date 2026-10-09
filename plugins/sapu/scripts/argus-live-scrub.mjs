// argus-live-scrub.mjs — the last check before a journey finding leaves the machine (spec §10 "Scrub",
// decisions 14, 17): `argus-live.mjs scrub` refuses an issue whose title or body holds any secret the run
// saw or the configuration holds — in any encoding the matcher knows, naming where and never what —,
// redacts every other long letter-and-digit token the run never saw as an id, and defangs mentions,
// references and outside links outside code. It reads only files a `down` keeps (the run's ledger and
// seen ids, the configuration), so a run that is down is scrubbed the same way. A screenshot's verdict is
// written here when `pw` takes it and read here when scrub decides whether to attach it; the issue is
// filed through `gh`, never a shell.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expand, LIVE_FILE, loadLive } from "./argus-live-config.mjs";
import { PatternError } from "./argus-live-fence.mjs";
import { normHost, ownerEnvFiles } from "./argus-live-endpoints.mjs";
import { highEntropy, MIN_SECRET, readLedger, readSeen, SECRET_KEY, secretHits } from "./argus-live-ledger.mjs";
import { liveDir, RUN_ID } from "./argus-live-lock.mjs";
import { run, tempBeside, within } from "./argus-live-proc.mjs";
import { readRun, recordedSecrets, worktreeHeadFile } from "./argus-live-run.mjs";
import { loadContract, resolvePolicy } from "./sapu-contract.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

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

/** A candidate's reference: `<slot>.<generation>.<k>`. */
export const REF = /^([1-9][0-9]?)\.([1-9])\.([1-9][0-9]?)$/;

/** Candidate `ref`'s two-of-two verdict in run `runId` (its `verdict.json`): `reproduced`, `intermittent`, …, or `never run`. */
export function verdictOf(main, runId, ref) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(liveDir(main), runId, "repro", ref, "verdict.json"), "utf8"));
    return v && typeof v.verdict === "string" && /^[a-z-]{1,20}$/.test(v.verdict) ? v.verdict : "never run";
  } catch {
    return "never run";
  }
}

/** Run `runId` was a map run (`up --map`): run.json says so while it names the run, else the worktree record `down` keeps. */
function mapRun(main, runId) {
  let rec = null;
  try {
    rec = readRun(main);
  } catch {
    rec = null;
  }
  if (rec && rec.runId === runId) return rec.mode === "map";
  try {
    return JSON.parse(fs.readFileSync(worktreeHeadFile(main, runId), "utf8")).mode === "map";
  } catch {
    return false;
  }
}

/**
 * The run an issue is checked against (decision 14): `run` as named, else the one run whose records hold
 * candidate `ref` → `{runId}` or `{refusal}`. Never the newest run: text from one run checked against
 * another's ledger would let the first run's secrets through. Refused: neither named, a malformed id or
 * ref, a ref no run or more than one run holds (`--run` then says which), a ref whose `verdict.json` is not
 * `reproduced` (two of two), a run with no directory here, a map run (it drained no session).
 */
export function scrubRun(main, { run = null, ref = null } = {}) {
  const no = (why) => ({ refusal: `refused: scrub: ${why}; nothing is filed` });
  if (run === null && ref === null) return no("name the run (--run <runId>) or the candidate (--ref <slot>.<generation>.<k>)");
  if (run !== null && !RUN_ID.test(String(run))) return no("--run takes a run id");
  if (ref !== null && !REF.test(String(ref))) return no("--ref takes <slot>.<generation>.<k>");
  let runId = run;
  if (ref !== null && runId === null) {
    let names = [];
    try {
      names = fs.readdirSync(liveDir(main)).filter((n) => RUN_ID.test(n) && fs.existsSync(path.join(liveDir(main), n, "repro", ref)));
    } catch {
      names = [];
    }
    if (!names.length) return no(`no run here reproduced candidate ${ref}`);
    if (names.length > 1) return no(`candidate ${ref} was reproduced in more than one run; name it with --run <runId> too`);
    runId = names[0];
  }
  if (!fs.existsSync(path.join(liveDir(main), runId))) return no(`no run ${runId} here`);
  if (ref !== null) {
    const word = verdictOf(main, runId, ref);
    if (word !== "reproduced") return no(`candidate ${ref} of run ${runId} did not reproduce two of two (${word})`);
  }
  if (mapRun(main, runId)) return { refusal: `refused: scrub: run ${runId} is a map run (up --map): it drained no session and keeps no secret ledger; nothing from it is filed` };
  return { runId };
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

/**
 * `secretHits` on the title, the body and each label (gh puts a label on the issue as given) → the refusal's
 * lines, `<title|body> <line>:<col> <class>` and `label <i> <class>` (1-based), then the count; none → [].
 * A value that could not be checked → its PatternError's one line, `refused: scrub: a <class> value could not
 * be checked; nothing is filed`, never an error's own message.
 */
function refusalLines(title, body, secrets, labels = []) {
  try {
    const hits = [...secretHits(title, secrets).map((h) => ({ ...h, where: "title" })), ...secretHits(body, secrets).map((h) => ({ ...h, where: "body" }))];
    const lines = hits.map((h) => `${h.where} ${h.line}:${h.col} ${h.cls}`);
    labels.forEach((l, i) => {
      for (const h of secretHits(String(l), secrets)) lines.push(`label ${i + 1} ${h.cls}`);
    });
    return lines.length ? [...lines, `refused: scrub: ${lines.length} secret(s) in the issue; nothing is filed`] : [];
  } catch (e) {
    // Only a PatternError's fixed words: an engine's own message quotes its pattern, which spells a value out.
    return [e instanceof PatternError ? e.message : "refused: scrub: the issue could not be checked; nothing is filed"];
  }
}

/** Where a screenshot's verdict lies: beside it, `<name>.verdict.json`. */
const verdictFile = (png) => png.replace(/\.png$/, ".verdict.json");

/**
 * Writes the verdict of screenshot `png` of run `runId` beside it (0600): `{t, sha256, passed, reasons}`
 * (decision 18; `sha256` of the PNG's bytes as written), from `shot` (the login stage's answer, read after
 * the call's drain; null when it failed). Reasons: `secret` (the text holds a scrub secret, scrubSecrets
 * refused — a gone or incomplete ledger —, a value could not be checked, a frame could not be read, the stage
 * failed or the call's drain did not run, `drained` false), `password-field`, `one-time-code-field`, `error-page`. Never the text →
 * the verdict.
 */
export function writeVerdict(main, runId, png, shot, { drained = true, env = process.env } = {}) {
  const { secrets, refusal } = scrubSecrets(main, { runId, env });
  const reasons = [];
  let secret = !shot || !drained || refusal || shot.unread;
  if (!secret) {
    try {
      secret = secretHits(String(shot.text ?? ""), secrets).length > 0;
    } catch {
      secret = true; // a value that could not be checked: the page may show it
    }
  }
  if (secret) reasons.push("secret");
  if (shot && shot.password) reasons.push("password-field");
  if (shot && shot.otp) reasons.push("one-time-code-field");
  if (shot && shot.error) reasons.push("error-page");
  const v = { t: Date.now(), sha256: sha256(fs.readFileSync(png)), passed: reasons.length === 0, reasons };
  fs.renameSync(tempBeside(verdictFile(png), JSON.stringify(v), 0o600), verdictFile(png));
  return v;
}

/** A verdict's reason, as scrub names it. */
const REASON_WORDS = { secret: "a secret on the page", "password-field": "a password field", "one-time-code-field": "a one-time-code field", "error-page": "an error page" };

/** `gh --version`'s answer is 2.99 or later (`--attach`). */
const ghAttaches = (version) => {
  const m = /(\d+)\.(\d+)/.exec(String(version ?? ""));
  return Boolean(m) && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 99));
};

/**
 * May `file` be attached to an issue of run `runId` (decision 18)? → `{attach: true, file: <its real
 * path>}` or `{attach: false, reason}`, the first that fails of: `gh older than 2.99`, `public repository`
 * (`visibility` not PRIVATE or INTERNAL), `traces none` (the policy), `a trace, never attached` (any file
 * under a `traces/` directory), `not a screenshot of this run` (not a regular `.png` right in a slot's
 * `out/` of the run, by its real path), `no verdict recorded`, `the screenshot changed after its verdict`
 * (its bytes no longer hash to the verdict's sha256), then the verdict's own reason.
 */
export function attachVerdict(main, runId, file, { ghVersion, visibility, traces }) {
  const no = (reason) => ({ attach: false, reason });
  if (!ghAttaches(ghVersion)) return no("gh older than 2.99");
  if (visibility !== "PRIVATE" && visibility !== "INTERNAL") return no("public repository");
  if (traces === "none") return no("traces none");
  const given = path.resolve(String(file));
  let real = null;
  let root = null;
  try {
    real = fs.realpathSync(given);
    root = fs.realpathSync(path.join(liveDir(main), runId));
  } catch {
    // gone: not a screenshot of this run
  }
  if ([given, real].some((p) => p && p.split(path.sep).includes("traces"))) return no("a trace, never attached");
  const rel = real && root && within(root, real) ? path.relative(root, real).split(path.sep).join("/") : null;
  if (!rel || !/^(?:[1-9][0-9]*|r|up)\/out\/[^/]+\.png$/.test(rel) || !fs.lstatSync(given).isFile()) return no("not a screenshot of this run");
  let v = null;
  try {
    v = JSON.parse(fs.readFileSync(verdictFile(real), "utf8"));
  } catch {
    v = null;
  }
  if (!v || typeof v !== "object" || typeof v.sha256 !== "string" || typeof v.passed !== "boolean" || !Array.isArray(v.reasons)) return no("no verdict recorded");
  if (sha256(fs.readFileSync(real)) !== v.sha256) return no("the screenshot changed after its verdict");
  if (!v.passed || v.reasons.length) return no(REASON_WORDS[v.reasons.find((r) => Object.hasOwn(REASON_WORDS, r))] ?? REASON_WORDS.secret);
  return { attach: true, file: real };
}

/** `p`'s real path, else `p` resolved (gone). */
const realOr = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** A file as scrub names it, in its lines and in the issue: its path from MAIN (else its base name), every character outside a path's plain ones as `_`. */
const shownPath = (main, file) => {
  const [root, p] = [realOr(main), realOr(String(file))];
  return (within(root, p) ? path.relative(root, p) : path.basename(p)).replace(/[^A-Za-z0-9._/+@-]/g, "_");
};

/** An issue or comment URL in gh's stdout. */
const ISSUE_URL = /https?:\/\/\S+\/issues\/\d+(?:#issuecomment-\d+)?/;

/**
 * `argus-live.mjs scrub (--run <runId> | --ref <slot>.<generation>.<k> | both) --title <t> --body <file>
 * [--attach <png>…] [--create [--label <l>…] | --comment <n>]` → `{code, out}`. The run is the one named, or
 * the one whose candidate `ref` reproduced two of two (scrubRun; a run that is down is read the same way);
 * its refusal, then scrubSecrets', → that line (exit 1); a secret in the title, the body or a label as
 * given → one line per hit, `<title|body> <line>:<col> <class>` or `label <i> <class>`, then `refused:
 * scrub: <k> secret(s) in the issue; nothing is filed` (exit 1, the file untouched, no gh run; never a value, never the text around it); else
 * both redacted (redactIds, the run's seen ids) and defanged, `scrub: ok; redacted <n>, defanged <n>, cut
 * <n> line(s)` and `title: <the scrubbed title>`. Each `attach` → `attach: <name>` or `local: <name>
 * (<reason>)` (attachVerdict; gh's version from `gh --version`, the visibility from `gh repo view`, `traces`
 * from the contract's policy), the local ones named in a `Local evidence:` line appended to the body (once).
 * The body file is rewritten in place. With `create`: `gh issue create --title … --body-file <file>
 * [--label <l>]… [--attach <png>]…`; with `comment`: `gh issue comment <n> --body-file <file> [--attach
 * <png>]…`; an issue URL in gh's stdout → `filed: <url>` / `commented: <url>` (exit 0, whatever gh's
 * exit); none → `failed: gh issue create|comment exited <k> before printing an issue URL` (exit 2). gh's
 * own output is never printed.
 */
export async function scrub(main, { run: named = null, ref = null, title, bodyFile, attach = [], create = false, labels = [], comment = null } = {}, { env = process.env, gh = "gh", runner = run } = {}) {
  const which = scrubRun(main, { run: named, ref });
  if (which.refusal) return { code: 1, out: [which.refusal] };
  const { runId } = which;
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
  const given = refusalLines(t, body, secrets, labels);
  if (given.length) return { code: 1, out: given };
  const seen = readSeen(main, runId);
  const rt = redactIds(t, seen);
  const rb = redactIds(body, seen);
  const dt = defang(rt.text);
  const db = defang(rb.text);
  const out = [`scrub: ok; redacted ${rt.count + rb.count}, defanged ${dt.defanged + db.defanged}, cut ${db.cut} line(s)`, `title: ${dt.text}`];
  // Attachments: what may leave as a file, by its verdict and the repo's; the rest stays local, named.
  const attached = [];
  const local = [];
  if (attach.length) {
    const ask = (argv) => {
      const r = runner([gh, ...argv], { cwd: main, env });
      return r.status === 0 ? String(r.stdout ?? "").trim() : null;
    };
    const at = { ghVersion: ask(["--version"]), visibility: ask(["repo", "view", "--json", "visibility", "--jq", ".visibility"]), traces: resolvePolicy(loadContract(main).contract ?? null).traces };
    for (const f of attach) {
      const v = attachVerdict(main, runId, f, at);
      if (v.attach) attached.push(v.file);
      else local.push(shownPath(main, f));
      out.push(v.attach ? `attach: ${shownPath(main, f)}` : `local: ${shownPath(main, f)} (${v.reason})`);
    }
  }
  let text = db.text;
  const evidence = `Local evidence: ${local.map((p) => `\`${p}\``).join(", ")}`;
  if (local.length && !text.split("\n").includes(evidence)) text = `${text.replace(/\n+$/, "")}\n\n${evidence}\n`;
  // What is filed is checked as well as what was given: nothing a rewrite made may carry a secret either.
  const made = refusalLines(dt.text, text, secrets);
  if (made.length) return { code: 1, out: made };
  fs.writeFileSync(bodyFile, text);
  if (!create && comment === null) return { code: 0, out };
  const files = attached.flatMap((f) => ["--attach", f]);
  const argv = create ? ["issue", "create", "--title", dt.text, "--body-file", bodyFile, ...labels.flatMap((l) => ["--label", l]), ...files] : ["issue", "comment", String(comment), "--body-file", bodyFile, ...files];
  const r = runner([gh, ...argv], { cwd: main, env });
  const url = ISSUE_URL.exec(String(r.stdout ?? ""));
  if (url) return { code: 0, out: [...out, `${create ? "filed" : "commented"}: ${url[0]}`] };
  return { code: 2, out: [...out, `failed: gh issue ${create ? "create" : "comment"} exited ${r.status ?? "on a signal"} before printing an issue URL`] };
}
