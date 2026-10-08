#!/usr/bin/env node
// sapu-contract.mjs — load, validate and scope-lock a repo's sapu contract (.claude/sapu.json).
// The contract format is CONTRACT.md at the plugin root.
//
// USAGE (from anywhere inside the repo or one of its worktrees)
//   sapu-contract.mjs check       scope lock (gh account, git email, origin; plus the machine config's
//                                 allowed roots and project-scope rule when it sets them) + schema;
//                                 prints the contract JSON. Every skill that writes to GitHub runs it first.
//   sapu-contract.mjs show        schema only, no network; prints the contract JSON
//   sapu-contract.mjs wave-args   prints {main, pluginRoot, profiles, contract} for the sapu-wave and inspector
//                                 workflows' args (contract.specialists = the resolved role map)
//   sapu-contract.mjs specialists prints the resolved role -> subagent type map (resolveSpecialists)
//   sapu-contract.mjs trusted     prints the trusted set as JSON [{login, id}]: the active gh account
//                                 (which must be ghUser) + trustedAuthors (resolveTrusted)
//   sapu-contract.mjs issue-trust <N> [--text] [--comments]
//                                 ALWAYS prints a JSON verdict on stdout and exits by it: 0 when issue/PR
//                                 <N> may steer sapu (issueTrust: a trusted author, or the acceptance label
//                                 applied by a trusted id and nothing edited by an outsider since), else 1.
//                                 --text adds its title and body FROM THE SNAPSHOT THE VERDICT JUDGED,
//                                 --comments its comments by trusted ids only; neither for a refusal. The
//                                 only way skills read issue text or comments.
//   sapu-contract.mjs pr-trust <N> [--text]
//                                 the same for PR <N> (prTrust: not a fork, author and every commit author
//                                 trusted, signatures when requireSignedCommits, every issue it closes or
//                                 refs passing issueTrust); the verdict carries the PR facts sapu-merge.sh
//                                 uses. A refusal prints only {trusted, pr, author, rule, reason}.
//   sapu-contract.mjs home        prints {mode: "repo"|"local", dir}: where this repo's contract and
//                                 profiles live (<dir>/<skill>.md). local = ~/.config/sapu/repos/<owner>__<name>/,
//                                 outside the repo, used when a sapu.json is there (localHome)
//   sapu-contract.mjs policy      prints the repo's policy with every absent field at its default
//                                 (resolvePolicy: merge, reviewers, issues, fileIssues, traces, skills, prePr)
//   sapu-contract.mjs pr-reviews <N>  PR <N>'s reviews + inline review comments by the trusted set and
//                                 policy.reviewers only (prReviews); others are counted as withheld
//   sapu-contract.mjs allowed <skill>  exit 0 when policy.skills allows <skill>, else 1 with the reason
//   sapu-contract.mjs lanes       prints {lanes, ceiling, busy, gateWorkers, gateWorkersBeside, cpus, ramGB,
//                                 load1, memFreePct}: how many Phase B lanes this machine carries now
//                                 (safeLanes) and the merge gate's workers (gateWorkers); no contract needed
//   sapu-contract.mjs tuning      prints the repo's resolved tuning (resolveTuning: the step budget, the
//                                 context window and the context limits in tokens) with the gate workers
//   sapu-contract.mjs sweep hold|release <run-marker>   one /sapu sweep per repo (ONE SWEEP PER REPO):
//                                 hold = take or refresh <MAIN>/.git/sapu-sweep.json (the heartbeat), exit 1
//                                 while another session's heartbeat is fresh; release = remove it, holder only
//   sapu-contract.mjs sweep status|clear   print the marker; remove it whoever holds it (the person's)
//   sapu-contract.mjs main        prints <MAIN>, the main checkout (findMain: also for a submodule or a
//                                 --separate-git-dir checkout, where git lists its git directory first)
//   sapu-contract.mjs stack       the guard /sapu:init proposes for the checkout (detectStack): its
//                                 ecosystems' guard.deny rules and the dev databases of guard.postgres/databases
//   sapu-contract.mjs protect [--ref <rev>] -- <words>   which repo file a contract command pins
//                                 (protectedCommand), as JSON {words, index, file, why}
//   sapu-contract.mjs get <a.b>   prints one value (strings raw, anything else as JSON)
//   sapu-contract.mjs profiles    every .claude/sapu/<skill>.md carries the sections its skill reads
//                                 (`--list` prints them; /sapu:init writes them)
//   sapu-contract.mjs preflight   facts for /sapu:init (allowed root? machine config? origin? account?
//                                 user-scope install?)
//   show|profiles --working-tree  the files as they are in the checkout the command runs in, for
//                                 /sapu:init to verify what it wrote on its branch before committing
//   show|check|get|trusted|issue-trust|pr-trust --ref <ref>
//                                 the contract committed at <ref> instead of HEAD (sapu-merge.sh reads
//                                 a freshly fetched origin/<base>, never <MAIN>'s local refs)
// EXIT: 0 ok; 1 = stop, reason on stderr.
//
// The contract (and the profiles) are read from <MAIN>'s COMMITTED HEAD (`git show
// HEAD:.claude/sapu.json`, <MAIN> = the first `git worktree list` entry), never from a working
// tree: a worker can write any file of <MAIN>'s working tree or of its own worktree, but it cannot
// move <MAIN>'s HEAD without a merge, and only the orchestrator merges.
//
// WHERE sapu may run is not the contract's call either: the optional MACHINE CONFIG
// (~/.config/sapu/config.json, that one path only — never $XDG_CONFIG_HOME, which a repo's
// committed .claude/settings.json `env` can set) belongs to the person on this machine and is
// never read from a repo, so no contract can widen it:
//   {"allowedRoots": ["~/projects", "/abs/path"], "projectScopeOnly": true}
// Both keys optional; any other key or a wrong type is an error. No file = no root restriction and
// no user-scope refusal — but only a genuinely absent path: a file that cannot be read, a symlink
// on the way to it, or a config inside the repo's own checkout stops instead.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRACT_PATH = ".claude/sapu.json";

const isStr = (v) => typeof v === "string" && v.trim() !== "";
const isRegex = (v) => {
  if (!isStr(v)) return false;
  try {
    new RegExp(v);
    return true;
  } catch {
    return false;
  }
};
const strArray = (v) => Array.isArray(v) && v.every(isStr);

/**
 * The specialist roles the engine dispatches by name. Each defaults to an agent of the
 * senior-dev-team plugin (a dependency of sapu, installed with it; DEFAULT_SPECIALISTS); a repo
 * may map any of them to an agent of its own through the optional contract field `specialists`.
 */
export const SPECIALIST_ROLES = ["qa", "architect", "db", "developer", "ux", "writer", "product"];
/** The roles that may be the domain half of the 🔴 review pair (qa is always the other half). */
export const DOMAIN_ROLES = ["architect", "db", "developer", "ux"];
/** Each role's default agent, from the senior-dev-team plugin. */
export const DEFAULT_SPECIALISTS = {
  qa: "senior-dev-team:senior-qa-reviewer",
  architect: "senior-dev-team:senior-software-architect",
  db: "senior-dev-team:senior-fullstack-database-engineer",
  developer: "senior-dev-team:senior-fullstack-developer",
  ux: "senior-dev-team:senior-ui-ux-designer",
  writer: "senior-dev-team:senior-technical-writer",
  product: "senior-dev-team:product-manager",
};
const builtIn = (role) => DEFAULT_SPECIALISTS[role];
/** A worker of the plugin's ladder, under any plugin prefix (the same pattern as SAPU_AGENT in sapu-guard.mjs). */
export const LADDER_AGENT = /(^|:)sapu-(sonnet|opus)-(low|medium|high)$/;
/**
 * Why `t` cannot be a specialist, or null. A reviewer must be a dedicated agent with its own
 * model: `general-purpose` inherits the session's, and a ladder worker is a worker, not a reviewer.
 */
/** The plugin's former built-in role agents, which it no longer ships: a contract still naming one dispatches nothing. */
const REMOVED_ROLE_AGENT = /(^|:)sapu-(qa|architect|db|developer|ux|writer|product)$/;
const notSpecialist = (t) =>
  t === "general-purpose" ? "general-purpose inherits the session model"
  : LADDER_AGENT.test(t) ? "a worker of the sapu ladder is not a reviewer"
  : REMOVED_ROLE_AGENT.test(t) ? "sapu no longer ships its own role agents; omit the role to use its senior-dev-team default" : null;

/**
 * The full role -> subagent type map for `c`: the contract's `specialists` entry where it names
 * one, the senior-dev-team default otherwise. `specialists` is optional on purpose (the one
 * documented exception to "no silent defaults"): a contract written before the field existed
 * stays valid, so plugin and contract never have to be updated in lockstep.
 */
export function resolveSpecialists(c) {
  const own = c && c.specialists && typeof c.specialists === "object" ? c.specialists : {};
  return Object.fromEntries(SPECIALIST_ROLES.map((r) => [r, isStr(own[r]) ? own[r] : builtIn(r)]));
}

/** Characters the guard's label matcher splits command text on (or URL-decodes), so a label holding one can never be recognised. */
const UNRECOGNISABLE_LABEL = /[\s,="'/[\]{}()%]/;

/** The acceptance label when the contract's optional `labels.accepted` names none. */
export const DEFAULT_ACCEPTED_LABEL = "sapu:accepted";
/** A login as `trustedAuthors` writes it: letters, digits, hyphens; an app as `app/<name>` or `<name>[bot]`. */
const GH_LOGIN = /^(?:app\/)?[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/;
const lc = (s) => (typeof s === "string" ? s.toLowerCase() : "");
/** The REST spelling of a login: gh prints an app as `app/<name>`, REST as `<name>[bot]` — one account, one id. */
export const restLogin = (login) => (login.startsWith("app/") ? `${login.slice(4)}[bot]` : login);
const isId = (v) => Number.isInteger(v) && v > 0;

/** The label a trusted login applies to accept an outsider's issue: `labels.accepted`, else the default. */
export const acceptedLabel = (c) => (c && c.labels && isStr(c.labels.accepted) ? c.labels.accepted : DEFAULT_ACCEPTED_LABEL);
/** The label marking a finding only the owner can rule on (argus journey lane); sapu skips it in B2. */
export const DEFAULT_NEEDS_OWNER_LABEL = "argus:needs-owner";
export const needsOwnerLabel = (c) => (c && c.labels && isStr(c.labels.needsOwner) ? c.labels.needsOwner : DEFAULT_NEEDS_OWNER_LABEL);

/**
 * The trusted set for contract `c` and the active owner account `owner` ({login, id}): the owner
 * first, then the optional `trustedAuthors`, each ACCOUNT once. Identity is the immutable numeric
 * GitHub user id, never the login: a released login can be re-registered by anyone. Optional on
 * purpose, like `specialists`: a contract without the field trusts the owner alone.
 */
export function trustedSet(c, owner) {
  const out = [{ login: owner.login, id: owner.id }];
  for (const e of c && Array.isArray(c.trustedAuthors) ? c.trustedAuthors : []) {
    if (e && isId(e.id) && !out.some((x) => x.id === e.id)) out.push({ login: e.login, id: e.id });
  }
  return out;
}

/** The skills a policy can allow (`policy.skills`). */
export const SKILLS = ["sapu", "forge", "argus", "journey", "momus", "nemesis", "inspector", "dream"];
/** Severities a pre-PR review command reports, highest first. */
export const SEVERITIES = ["critical", "medium", "low"];

/**
 * How sapu behaves in this repo: who merges, which issues it takes, what it may leave on GitHub.
 * Every field is the owner's choice (/sapu:init asks each one); an absent policy or field keeps the
 * behaviour sapu had before policies existed, so the default is never a hidden restriction.
 */
export const DEFAULT_POLICY = { merge: "sapu", reviewers: [], issues: "trusted", fileIssues: true, traces: "visible", skills: SKILLS, prePr: null, cleanup: "finish" };

/** The policy with every absent field at its default. */
export function resolvePolicy(c) {
  return { ...DEFAULT_POLICY, ...((c && c.policy) || {}) };
}

function policyProblems(p) {
  const errs = [];
  if (!p || typeof p !== "object" || Array.isArray(p)) return ["policy must be an object"];
  for (const k of Object.keys(p)) if (!(k in DEFAULT_POLICY)) errs.push(`policy: unknown key "${k}"`);
  const one = (k, ok, msg) => k in p && !ok(p[k]) && errs.push(`policy.${k} ${msg}`);
  one("merge", (v) => v === "sapu" || v === "human", 'must be "sapu" (sapu merges after a green gate) or "human" (sapu hands the PR to reviewers)');
  one("reviewers", (v) => Array.isArray(v) && v.every((x) => typeof x === "string" && GH_LOGIN.test(x)), "must be an array of GitHub logins");
  one("issues", (v) => v === "trusted" || v === "assigned" || (v && typeof v === "object" && Object.keys(v).join() === "label" && isStr(v.label)), 'must be "trusted", "assigned" or {"label": "<name>"}');
  one("fileIssues", (v) => typeof v === "boolean", "must be true or false");
  one("traces", (v) => v === "visible" || v === "none", 'must be "visible" or "none"');
  one("cleanup", (v) => v === "finish" || v === "session" || v === "never", 'must be "finish" (at the end of the sweep), "session" (also at the end of every session) or "never"');
  one("skills", (v) => Array.isArray(v) && v.length > 0 && v.every((x) => SKILLS.includes(x)), `must be a non-empty array of ${SKILLS.join(", ")}`);
  one(
    "prePr",
    (v) =>
      v === null ||
      (v && typeof v === "object" && Object.keys(v).every((k) => ["run", "severities", "paste"].includes(k)) && isStr(v.run) && v.run.startsWith("/") &&
        Array.isArray(v.severities) && v.severities.length > 0 && v.severities.every((x) => SEVERITIES.includes(x)) && (v.paste === "body" || v.paste === "comment")),
    `must be null or {"run": "/<command> [args]", "severities": [${SEVERITIES.map((x) => `"${x}"`).join(", ")}] (each must reach 0), "paste": "body" | "comment"}`,
  );
  if ((p.merge ?? "sapu") === "sapu" && Array.isArray(p.reviewers) && p.reviewers.length) errs.push('policy.reviewers only applies with merge "human"');
  return errs;
}

/** The database engines `guard.databases` protects (the guard knows each one's clients, flags and URLs). */
export const DB_ENGINES = ["postgres", "mysql", "mongodb", "redis", "sqlite"];

/**
 * Every protected port and database name of a contract guard, whatever the engine: `guard.postgres`
 * and each `guard.databases` entry (sqlite files aside). For checks that compare values, not commands.
 */
export function protectedDatabases(guard) {
  const all = [...(guard && guard.postgres ? [guard.postgres] : []), ...(guard && Array.isArray(guard.databases) ? guard.databases.filter((d) => d.engine !== "sqlite") : [])];
  return { ports: [...new Set(all.flatMap((d) => d.ports))], databases: [...new Set(all.flatMap((d) => d.databases))] };
}

/** Every schema error in `c` (empty = valid). Unknown keys are errors: a typo must not silently drop a rule. */
export function validate(c) {
  const errs = [];
  const need = (cond, msg) => cond || errs.push(msg);
  const keys = (obj, where, allowed, optional = []) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k) && !optional.includes(k)) errs.push(`${where}: unknown key "${k}"`);
    for (const k of allowed) if (!(k in obj)) errs.push(`${where}: missing "${k}" (write null when a field does not apply)`);
  };
  if (!c || typeof c !== "object" || Array.isArray(c)) return ["the contract must be a JSON object"];
  // traces "none" puts no sapu label anywhere, so its labels block is optional.
  const noTraces = c.policy && typeof c.policy === "object" && c.policy.traces === "none";
  keys(
    c,
    "sapu.json",
    ["version", "repo", "ghUser", "gitEmail", "baseBranch", "gate", "redAreas", "redAreaSpecialists", "mergeAfter", ...(noTraces && !("labels" in c) ? [] : ["labels"]), "securityEpic", "invariantDomains", "testResources", "guard"],
    ["specialists", "trustedAuthors", "requireSignedCommits", "policy", "labels", "mergeMethod", "host", "tuning"],
  );
  if ("mergeMethod" in c) need(MERGE_METHODS.includes(c.mergeMethod), `mergeMethod must be "squash", "merge" or "rebase" (the method the repo allows; omit it for squash)`);
  if ("host" in c) need(typeof c.host === "string" && HOSTNAME.test(c.host), 'host must be a hostname, e.g. "github.example.com" (the GitHub Enterprise host; omit it for github.com)');
  need(c.version === 1, "version must be 1");
  need(typeof c.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(c.repo), "repo must be owner/name");
  need(isStr(c.ghUser), "ghUser must be a non-empty string");
  need(typeof c.gitEmail === "string" && /^[^@\s]+@[^@\s]+$/.test(c.gitEmail), "gitEmail must be an email");
  need(typeof c.baseBranch === "string" && /^[\w./-]+$/.test(c.baseBranch), "baseBranch must be a branch name");
  if (c.gate && typeof c.gate === "object") {
    keys(c.gate, "gate", ["fast", "merge", "summaryStart", "redIf"], ["infra"]);
    need(!("infra" in c.gate) || c.gate.infra === null || isStr(c.gate.infra), "gate.infra must be a command or null");
    need(isStr(c.gate.fast), "gate.fast must be a command");
    need(isStr(c.gate.merge), "gate.merge must be a command");
    need(isRegex(c.gate.summaryStart), "gate.summaryStart must be a valid regex");
    need(c.gate.redIf === null || isRegex(c.gate.redIf), "gate.redIf must be a valid regex or null");
    // The merge gate is denied to workers; a fast gate equal to it would leave them no gate at all.
    if (isStr(c.gate.fast) && isStr(c.gate.merge)) {
      const norm = (x) => x.trim().split(/\s+/).join(" ");
      need(norm(c.gate.fast) !== norm(c.gate.merge), "gate.fast must differ from gate.merge (workers may never run the merge gate)");
    }
  } else errs.push("gate must be an object");
  need(c.redAreas === null || isStr(c.redAreas), "redAreas must be a command or null");
  const pairShaped = need(
    Array.isArray(c.redAreaSpecialists) && c.redAreaSpecialists.every((s) => s && isRegex(s.match) && isStr(s.agent) && Object.keys(s).length === 2),
    "redAreaSpecialists must be [{match: <regex>, agent: <role or subagent type>}]",
  );
  if ("specialists" in c) {
    const s = c.specialists;
    if (!s || typeof s !== "object" || Array.isArray(s)) errs.push(`specialists must be an object mapping roles (${SPECIALIST_ROLES.join(", ")}) to subagent types; omit it to use the senior-dev-team defaults`);
    else
      for (const [k, v] of Object.entries(s)) {
        if (!SPECIALIST_ROLES.includes(k)) errs.push(`specialists: unknown role "${k}" (roles: ${SPECIALIST_ROLES.join(", ")})`);
        else if (need(isStr(v), `specialists.${k} must be a non-empty subagent type (omit the role to use ${builtIn(k)})`) === true && notSpecialist(v)) errs.push(`specialists.${k}: "${v}" cannot be a specialist (${notSpecialist(v)})`);
      }
  }
  // A list of accounts: the id is what is compared; the login is what `check` re-resolves to prove
  // the id still belongs to it. A bare login would trust whoever registers that name next.
  const accounts = (t, where, omitted) => {
    if (!Array.isArray(t)) return errs.push(`${where} must be an array of {"login": "<GitHub login>", "id": <numeric user id>}; ${omitted}`);
    t.forEach((e, i) => {
      const shaped = e && typeof e === "object" && !Array.isArray(e) && Object.keys(e).sort().join(",") === "id,login" && typeof e.login === "string" && GH_LOGIN.test(e.login) && isId(e.id);
      need(shaped, `${where}[${i}] must be {"login": "<GitHub login, no @>", "id": <numeric user id; gh api users/<login> --jq .id>}: ${JSON.stringify(e)}`);
    });
  };
  if ("trustedAuthors" in c) accounts(c.trustedAuthors, "trustedAuthors", "omit it to trust only ghUser");
  if (c.labels && typeof c.labels === "object" && "acceptors" in c.labels) accounts(c.labels.acceptors, "labels.acceptors", "omit it to let the trusted set accept");
  if ("requireSignedCommits" in c) need(typeof c.requireSignedCommits === "boolean", "requireSignedCommits must be true or false (omit it for false)");
  // The 🔴 pair is qa + one domain role: both halves resolving to one agent is one review, not two.
  const R = resolveSpecialists(c);
  for (const d of DOMAIN_ROLES) if (R[d] === R.qa) errs.push(`specialists: qa and ${d} both resolve to "${R.qa}", so the red pair would be one agent twice`);
  // `agent` is a domain role (resolved through `specialists`) or a literal subagent type. qa is
  // already the other half of the pair; writer and product are not domain reviewers — by role
  // name or by the agent type those roles resolve to.
  if (pairShaped === true) {
    const offDomain = ["qa", "writer", "product"];
    c.redAreaSpecialists.forEach((s, i) => {
      const where = `redAreaSpecialists[${i}].agent`;
      if (SPECIALIST_ROLES.includes(s.agent)) {
        if (!DOMAIN_ROLES.includes(s.agent)) errs.push(`${where}: role "${s.agent}" cannot be the domain half of the red pair (use ${DOMAIN_ROLES.join(", ")}, or a subagent type)`);
        return;
      }
      const role = offDomain.find((r) => R[r] === s.agent);
      if (role) errs.push(`${where}: "${s.agent}" is the ${role} agent, so it cannot be the domain half of the red pair`);
      else if (notSpecialist(s.agent)) errs.push(`${where}: "${s.agent}" cannot be a specialist (${notSpecialist(s.agent)})`);
    });
  }
  need(c.mergeAfter === null || isStr(c.mergeAfter), "mergeAfter must be a command or null");
  if (c.labels && typeof c.labels === "object") {
    keys(c.labels, "labels", ["tierPrefix", "inProgress", "done"], ["accepted", "acceptors", "needsOwner"]);
    for (const k of ["tierPrefix", "inProgress", "done"]) need(isStr(c.labels[k]), `labels.${k} must be a non-empty string`);
    if ("accepted" in c.labels) need(isStr(c.labels.accepted), `labels.accepted must be a non-empty label name (omit it for ${DEFAULT_ACCEPTED_LABEL})`);
    if ("needsOwner" in c.labels) need(isStr(c.labels.needsOwner), `labels.needsOwner must be a non-empty label name (omit it for ${DEFAULT_NEEDS_OWNER_LABEL})`);
    for (const k of ["accepted", "needsOwner"]) if (isStr(c.labels[k])) need(!UNRECOGNISABLE_LABEL.test(c.labels[k]), `labels.${k} must not contain spaces or any of , = " ' / [ ] { } ( ) % (the guard could not recognise it)`);
    if (!("needsOwner" in c.labels) || isStr(c.labels.needsOwner)) need(needsOwnerLabel(c).toLowerCase() !== acceptedLabel(c).toLowerCase(), `labels.needsOwner must differ from the acceptance label: both are "${needsOwnerLabel(c)}"`);
    // Each owner label (or its default) apart from the workflow and tier labels, in any case.
    for (const [k, label] of [["accepted", acceptedLabel(c)], ["needsOwner", needsOwnerLabel(c)]]) {
      if (k in c.labels && !isStr(c.labels[k])) continue;
      const low = label.toLowerCase();
      for (const o of ["inProgress", "done"]) if (isStr(c.labels[o])) need(low !== c.labels[o].toLowerCase(), `labels.${k} must differ from labels.${o}: both are "${label}"`);
      if (isStr(c.labels.tierPrefix)) need(!low.startsWith(c.labels.tierPrefix.toLowerCase()), `labels.${k} must not start with labels.tierPrefix ("${c.labels.tierPrefix}"): it would read as a risk tier`);
    }
  } else if (!(noTraces && !("labels" in c))) errs.push("labels must be an object");
  need(c.securityEpic === null || (Number.isInteger(c.securityEpic) && c.securityEpic > 0), "securityEpic must be an issue number or null");
  need(isStr(c.invariantDomains), "invariantDomains must be a non-empty string");
  need(isStr(c.testResources), "testResources must be a non-empty string");
  if ("policy" in c) policyProblems(c.policy).forEach((e) => errs.push(e));
  if ("tuning" in c) tuningProblems(c.tuning).forEach((e) => errs.push(e));
  const g = c.guard;
  if (g && typeof g === "object") {
    keys(g, "guard", ["envFiles", "postgres", "deny"], ["databases"]);
    // Optional, like postgres per engine: a dev database other sessions use, of any engine the guard reads.
    if ("databases" in g) {
      if (!Array.isArray(g.databases)) errs.push(`guard.databases must be an array of {engine, ports, databases} (engines: ${DB_ENGINES.join(", ")}); omit it for none`);
      else
        g.databases.forEach((d, i) => {
          const where = `guard.databases[${i}]`;
          const shaped = need(
            d && typeof d === "object" && !Array.isArray(d) && Object.keys(d).sort().join() === "databases,engine,ports" && Array.isArray(d.ports) && d.ports.every((n) => Number.isInteger(n) && n > 0 && n < 65536) && strArray(d.databases),
            `${where} must be {engine, ports: [int], databases: [name]} (sqlite: databases are files, absolute or relative to the main checkout)`,
          );
          if (shaped !== true) return;
          if (!DB_ENGINES.includes(d.engine)) errs.push(`${where}.engine must be one of ${DB_ENGINES.join(", ")}`);
          else if (d.engine === "sqlite" && d.ports.length) errs.push(`${where}: sqlite protects files, not ports`);
          need(d.ports.length + d.databases.length > 0, `${where} must name at least one port or database`);
        });
    }
    need(strArray(g.envFiles), "guard.envFiles must be an array of file names ([] adds nothing to .env/.env.local)");
    // The guard compares basenames: a path would silently protect nothing.
    if (strArray(g.envFiles)) for (const f of g.envFiles) need(!f.includes("/"), `guard.envFiles entries are file names, not paths: "${f}"`);
    if (g.postgres !== null) {
      const p = g.postgres;
      const shaped = need(
        p && typeof p === "object" && Array.isArray(p.ports) && p.ports.every((n) => Number.isInteger(n) && n > 0 && n < 65536) && strArray(p.databases) && Object.keys(p).length === 2,
        "guard.postgres must be {ports: [int], databases: [name]} or null",
      );
      // An empty block protects nothing while reading as if it did: write null instead.
      if (shaped === true) need(p.ports.length + p.databases.length > 0, "guard.postgres must name at least one port or database (null = no protected database)");
    }
    if (Array.isArray(g.deny)) {
      g.deny.forEach((r, i) => {
        const where = `guard.deny[${i}]`;
        if (!r || typeof r !== "object") return errs.push(`${where} must be an object`);
        const extra = Object.keys(r).filter((k) => !["argv", "path", "allowWith", "reason"].includes(k));
        if (extra.length) errs.push(`${where}: unknown key(s) ${extra.join(", ")}`);
        need(("argv" in r) !== ("path" in r), `${where} needs exactly one of argv / path`);
        if ("argv" in r) need(strArray(r.argv) && r.argv.length > 0, `${where}.argv must be a non-empty array of words`);
        if ("path" in r) need(isStr(r.path), `${where}.path must be a path`);
        if ("allowWith" in r) need(strArray(r.allowWith) && r.allowWith.length > 0, `${where}.allowWith must be a non-empty array of words`);
        need(isStr(r.reason), `${where}.reason must say why (it is the block message)`);
      });
    } else errs.push("guard.deny must be an array");
  } else errs.push("guard must be an object");
  return errs;
}

/**
 * The repository's common git directory for checkout `main` — where sapu keeps its locks, ledgers
 * and counters (`<MAIN>/.git/…` in the docs): `<main>/.git` in a plain clone; the directory a `.git`
 * FILE names (a submodule, `--separate-git-dir`), through its `commondir`; `main` itself when it is
 * a bare repository. Read from the files, no git process (the guard calls it on every tool call);
 * null when no such directory exists.
 */
export function gitCommonDir(main) {
  if (!main) return null;
  const dotgit = path.join(main, ".git");
  let dir = null;
  try {
    const st = fs.statSync(dotgit);
    if (st.isDirectory()) dir = dotgit;
    else {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotgit, "utf8"));
      if (m) dir = path.resolve(main, m[1]);
    }
  } catch {
    if (fs.existsSync(path.join(main, "HEAD")) && fs.existsSync(path.join(main, "objects"))) dir = main;
  }
  if (!dir) return null;
  try {
    const common = fs.readFileSync(path.join(dir, "commondir"), "utf8").trim();
    if (common) dir = path.resolve(dir, common);
  } catch {}
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/**
 * <MAIN> = the main checkout seen from `cwd`: the first `git worktree list` entry; null outside a
 * repo. Where `.git` is a file (a submodule, `--separate-git-dir`) git names its git DIRECTORY
 * there, so the checkout is that directory's `core.worktree` (a submodule records it); without one,
 * the toplevel when `cwd` is in the main checkout itself, else null (`git config core.worktree
 * <checkout>` makes every worktree find it; linked worktrees ignore that key). A bare repository
 * stays as named: the scope lock and sapu-merge.sh refuse it.
 */
export function findMain(cwd) {
  let first;
  try {
    const out = execFileSync("git", ["-C", cwd, "worktree", "list", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    first = out.split("\n").find((l) => l.startsWith("worktree "));
  } catch {
    return null;
  }
  if (!first) return null;
  const p = first.slice("worktree ".length);
  const isGitDir = !fs.existsSync(path.join(p, ".git")) && fs.existsSync(path.join(p, "HEAD")) && fs.existsSync(path.join(p, "objects"));
  if (!isGitDir) return p;
  const cfg = (k) => sh("git", ["config", "--file", path.join(p, "config"), "--get", k], cwd);
  const wt = cfg("core.worktree");
  if (wt) return path.resolve(p, wt);
  if (cfg("core.bare") === "true") return p;
  const abs = (flag) => sh("git", ["-C", cwd, "rev-parse", "--path-format=absolute", flag], cwd);
  const own = abs("--git-dir");
  return own && own === abs("--git-common-dir") ? checkoutRoot(cwd) : null;
}

/** The checkout (worktree) root holding `cwd`; null outside a repo. */
export function checkoutRoot(cwd) {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * {contract} or {error, missing}. Never throws. Reads `root`'s committed HEAD, or with
 * `workingTree` the file in `root`'s working tree (only /sapu:init verifying its own branch).
 * `missing` = there is no contract at all (not a repo, no commit, file absent) — as opposed to one
 * that exists and is broken.
 */
export function loadContract(root, { workingTree = false, ref = "HEAD" } = {}) {
  if (!root) return { error: "not inside a git repository", missing: true };
  const local = localContractFile(root);
  if (local) return loadLocalContract(root, local, { workingTree, ref });
  let raw;
  let where;
  if (workingTree) {
    where = path.join(root, CONTRACT_PATH);
    try {
      raw = fs.readFileSync(where, "utf8");
    } catch {
      return { error: `${where} not found: this checkout has no sapu contract (run /sapu:init)`, missing: true };
    }
  } else {
    where = `${root} ${ref}:${CONTRACT_PATH}`;
    const r = spawnSync("git", ["-C", root, "show", `${ref}:${CONTRACT_PATH}`], { encoding: "utf8" });
    if (r.status !== 0) return { error: `${CONTRACT_PATH} is not committed at ${root}'s ${ref}: this repo has no sapu contract there (run /sapu:init and merge its PR)`, missing: true };
    raw = r.stdout;
  }
  let c;
  try {
    c = JSON.parse(raw);
  } catch (e) {
    return { error: `${where} is not valid JSON: ${e.message}` };
  }
  const errs = validate(c);
  return errs.length ? { error: `${where} is invalid:\n  - ${errs.join("\n  - ")}` } : { contract: c };
}

/**
 * Where a LOCAL contract for `root` would live: ~/.config/sapu/repos/<owner>__<name>/ (that path only,
 * like the machine config; the repo is named by its origin remote). The contract and the profiles
 * then never enter the repository: nothing in its history or working tree shows sapu.
 */
export function localHome(nwo) {
  return path.join(os.homedir(), ".config", "sapu", "repos", nwo.replace("/", "__"));
}

/** The local contract file for `root` when one exists (or a broken link stands there), else null. */
function localContractFile(root) {
  // any host: a GitHub Enterprise repo names its host in the contract, and the scope lock pins it
  const nwo = parseRemote(sh("git", ["-C", root, "remote", "get-url", "origin"], root))?.nwo;
  if (!nwo) return null;
  const f = path.join(localHome(nwo), "sapu.json");
  try {
    fs.lstatSync(f);
    return { file: f, nwo };
  } catch {
    return null;
  }
}

/**
 * A local contract, judged like a committed one plus: no symlink between it and the home directory,
 * not inside the checkout, `repo` equal to the origin it was found by, and no committed contract
 * beside it (two contracts = which one rules is unclear, so neither does).
 */
function loadLocalContract(root, { file, nwo }, { workingTree, ref }) {
  const committed = workingTree ? fs.existsSync(path.join(root, CONTRACT_PATH)) : spawnSync("git", ["-C", root, "cat-file", "-e", `${ref}:${CONTRACT_PATH}`]).status === 0;
  if (committed) return { error: `two sapu contracts: ${file} and ${CONTRACT_PATH} in the repo — keep one` };
  let link;
  try {
    link = symlinkOnTheWay(file, path.resolve(os.homedir()));
  } catch (e) {
    return { error: e.message };
  }
  if (link) return { error: `local contract ${file} sits behind a symlink (${link}): sapu reads it only as a plain file` };
  const m = realThroughAncestors(root);
  const f = realThroughAncestors(file);
  if (f === m || f.startsWith(m + path.sep)) return { error: `local contract ${file} resolves inside the repository (${f})` };
  let c;
  try {
    c = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { error: `${file} cannot be read as JSON: ${e.message}` };
  }
  const errs = validate(c);
  if (c && c.repo !== nwo) errs.push(`repo is "${c.repo}" but this checkout's origin is ${nwo}`);
  return errs.length ? { error: `${file} is invalid:\n  - ${errs.join("\n  - ")}` } : { contract: c, home: { mode: "local", dir: path.dirname(file) } };
}

/** Where this checkout's contract and profiles live: {mode: "repo"|"local", dir} (profiles are <dir>/<skill>.md). */
export function contractHome(root) {
  const local = root && localContractFile(root);
  return local ? { mode: "local", dir: path.dirname(local.file) } : { mode: "repo", dir: root ? path.join(root, ".claude", "sapu") : null };
}

// .native canonicalises letter case too: on a case-insensitive disk `~/documents` is `~/Documents`.
const real = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};

/** The real path of `p` through its deepest existing ancestor (`p` itself may not exist). */
function realThroughAncestors(p) {
  const tail = [];
  for (let head = path.resolve(p); ; head = path.dirname(head)) {
    try {
      return path.join(fs.realpathSync.native(head), ...tail);
    } catch {
      if (path.dirname(head) === head) return path.resolve(p);
      tail.unshift(path.basename(head));
    }
  }
}

/** True when `dir` lies strictly inside one of `roots` (symlinks resolved on both sides; a root itself is not inside). */
export function underAllowedRoot(dir, roots) {
  const d = real(dir);
  return roots.some((root) => {
    const r = real(root);
    // "/" already ends in a separator; appending one would make every prefix test fail.
    const prefix = r.endsWith(path.sep) ? r : r + path.sep;
    return d !== r && (d + path.sep).startsWith(prefix);
  });
}

/**
 * Where the machine config lives: ~/.config/sapu/config.json, nowhere else. Not $XDG_CONFIG_HOME:
 * a repo's committed .claude/settings.json `env` reaches every subprocess, so honouring it would let
 * a repo move the lookup to a missing file (no restriction) or to a permissive file of its own.
 */
export function machineConfigPath() {
  return path.join(os.homedir(), ".config", "sapu", "config.json");
}

/** Every error in a parsed machine config (empty = valid). Strict like the contract: an unknown key is a typo that must not silently drop a restriction. */
export function validateMachineConfig(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return ["the machine config must be a JSON object"];
  const errs = [];
  for (const k of Object.keys(c)) if (!["allowedRoots", "projectScopeOnly"].includes(k)) errs.push(`unknown key "${k}"`);
  if ("allowedRoots" in c) {
    const r = c.allowedRoots;
    if (!Array.isArray(r) || r.length === 0) errs.push("allowedRoots must be a non-empty array of directories (omit the key for no restriction)");
    else
      for (const p of r) {
        if (typeof p !== "string" || !(path.isAbsolute(p) || p === "~" || p.startsWith("~/"))) errs.push(`allowedRoots entries must be absolute or ~/ paths: ${JSON.stringify(p)}`);
      }
  }
  if ("projectScopeOnly" in c && typeof c.projectScopeOnly !== "boolean") errs.push("projectScopeOnly must be true or false");
  return errs;
}

/**
 * The nearest symlink on the way from `file` up to `stop` (exclusive), as "<link> -> <target>", or
 * null. lstat does not follow the entry it names, so a dangling link shows up as a link.
 */
function symlinkOnTheWay(file, stop) {
  for (let p = path.resolve(file); p !== stop && path.dirname(p) !== p; p = path.dirname(p)) {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw new Error(`${file} cannot be checked: ${e.message}`);
    }
    if (st.isSymbolicLink()) return `${p} -> ${fs.readlinkSync(p)}`;
  }
  return null;
}

/**
 * The machine config as {path, allowedRoots (absolute, ~ expanded), projectScopeOnly}. Only a
 * genuinely absent file = {path: null, allowedRoots: [], projectScopeOnly: false}: no restriction.
 * Throws with the reason when the file, resolved, lies inside `main` (the repo's main checkout; a
 * repo never supplies its own machine config, present or absent); when it cannot be read (EACCES,
 * EISDIR, ENOTDIR, ...); when it is missing behind a symlink between it and the home directory (a
 * dangling link, or a link whose target lacks the rest: the owner pointed somewhere, so nothing
 * there is not "no config"); when it is not JSON; or when it fails validateMachineConfig.
 */
export function loadMachineConfig(file = machineConfigPath(), { main = null } = {}) {
  if (main) {
    const m = realThroughAncestors(main);
    const f = realThroughAncestors(file);
    if (f === m || f.startsWith(m + path.sep)) {
      throw new Error(`machine config ${file} is inside the repository ${main} (resolved: ${f}): a repo never supplies its own machine config`);
    }
  }
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") {
      const link = symlinkOnTheWay(file, path.resolve(os.homedir()));
      if (link) throw new Error(`machine config ${file} is missing behind a symlink (${link}): restore its target or remove the link; write {} at ${file} for no restriction`);
      return { path: null, allowedRoots: [], projectScopeOnly: false };
    }
    throw new Error(`machine config ${file} cannot be read: ${e.message}`);
  }
  let c;
  try {
    c = JSON.parse(raw);
  } catch (e) {
    throw new Error(`machine config ${file} is not valid JSON: ${e.message}`);
  }
  const errs = validateMachineConfig(c);
  if (errs.length) throw new Error(`machine config ${file} is invalid:\n  - ${errs.join("\n  - ")}`);
  const expand = (p) => (p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
  return { path: file, allowedRoots: (c.allowedRoots ?? []).map(expand), projectScopeOnly: c.projectScopeOnly === true };
}

/** The GitHub host the contract's repo lives on: `host` (GitHub Enterprise), else github.com. */
export const DEFAULT_HOST = "github.com";
export const hostOf = (c) => (c && isStr(c.host) ? c.host.toLowerCase() : DEFAULT_HOST);
/** How sapu-merge.sh merges a PR: `mergeMethod`, else a squash merge. */
export const MERGE_METHODS = ["squash", "merge", "rebase"];
export const mergeMethodOf = (c) => (c && MERGE_METHODS.includes(c.mergeMethod) ? c.mergeMethod : "squash");
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

/**
 * The host an SSH host alias stands for, as `ssh -G <alias>` resolves it from the person's ssh
 * config (it prints the configuration, never connects); null when ssh cannot say.
 */
export function sshHostname(alias) {
  const r = spawnSync("ssh", ["-G", alias], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? (/^hostname\s+(\S+)\s*$/m.exec(r.stdout || "")?.[1] ?? null) : null;
}

/**
 * {host, nwo} of a remote URL (`https://[user@]host/o/r`, `[user@]host:o/r`, `ssh://[user@]host[:port]/o/r`,
 * each with an optional `.git`), or null. An SSH host is read through `resolve` (an alias in the
 * ssh config: the host the push really goes to); an https host is taken as written.
 */
export function parseRemote(url, resolve = sshHostname) {
  const u = String(url || "");
  const path2 = String.raw`([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$`;
  const https = new RegExp(String.raw`^https:\/\/(?:[^@/\s]+@)?([^/@:\s]+)\/${path2}`, "i").exec(u);
  if (https) return HOSTNAME.test(https[1]) ? { host: https[1].toLowerCase(), nwo: `${https[2]}/${https[3]}` } : null;
  const ssh = new RegExp(String.raw`^ssh:\/\/(?:[\w.-]+@)?([^/@:\s]+)(?::\d+)?\/${path2}`, "i").exec(u) || new RegExp(String.raw`^(?:[\w.-]+@)?([^/@:\s]+):${path2}`, "i").exec(u);
  // an alias that looks like an option is never handed to ssh
  if (!ssh || !HOSTNAME.test(ssh[1])) return null;
  const named = ssh[1].toLowerCase();
  // github.com itself needs no lookup; a name ssh cannot resolve is taken as written (never wider)
  const host = (named === DEFAULT_HOST ? named : resolve(ssh[1]) || named).toLowerCase();
  // ssh.github.com is GitHub's documented SSH endpoint on port 443
  return { host: host === `ssh.${DEFAULT_HOST}` ? DEFAULT_HOST : host, nwo: `${ssh[2]}/${ssh[3]}` };
}

/**
 * owner/name from a remote URL on `host` (github.com unless the contract names a GitHub Enterprise
 * host), or null. The host is pinned: a URL that merely contains it is not it, and an SSH host alias
 * counts only when ssh resolves it to that host.
 */
export function nwoFromRemote(url, host = DEFAULT_HOST, resolve = sshHostname) {
  // the host itself needs no ssh lookup (the common case, and no process spawned for it)
  const r = parseRemote(url, (alias) => (alias.toLowerCase() === host.toLowerCase() ? alias : resolve(alias)));
  return r && r.host === host.toLowerCase() ? r.nwo : null;
}

function sh(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/**
 * How many Phase B lanes (each = one worker running tests) a machine carries right now: a ceiling
 * from its size, one less while it is already loaded (the merge gate, another app, a slow suite).
 */
export function safeLanes({ cpus, ramGB, load1, memFreePct }) {
  // ponytail: ~4 cores and ~3 GB per lane, 8 GB kept for the merge gate, the OS and the app; caps
  // at 4 because merges are one at a time. Retune from pilot data (load, flakes, gate time).
  const ceiling = Math.max(1, Math.min(4, Math.floor(cpus / 4), Math.floor((ramGB - 8) / 3)));
  const busy = load1 > cpus || memFreePct < 20;
  return { lanes: busy ? Math.max(1, ceiling - 1) : ceiling, ceiling, busy };
}

/**
 * The merge gate's test workers for a machine of `cpus` cores: most of them when the gate runs
 * alone (`gateWorkers`), about half that beside a lane that is running tests (`gateWorkersBeside`),
 * and the smaller figure while the machine is already busy.
 */
export function gateWorkers({ cpus, busy }) {
  const beside = Math.max(1, Math.floor(cpus * 0.4));
  return { gateWorkers: busy ? beside : Math.max(1, Math.floor(cpus * 0.8)), gateWorkersBeside: beside };
}

/**
 * What a repo may tune (contract `tuning`, every key optional) and its defaults: the worker step
 * budget the guard enforces (a reminder at `soft` tool calls, every `every` up to `hard`, every
 * `everyLate` past it), and the orchestrator's context limits as fractions of the model's context
 * window (`contextWindow` tokens), for a session (`session`) and for the end of Phase A (`phaseA`).
 */
export const DEFAULT_TUNING = { stepBudget: { soft: 120, every: 15, hard: 170, everyLate: 5 }, contextWindow: 1_000_000, contextLimits: { session: 0.75, phaseA: 0.6 } };

/** The contract's tuning with every absent key at its default; context limits in tokens. */
export function resolveTuning(c) {
  const t = (c && c.tuning) || {};
  const window = t.contextWindow ?? DEFAULT_TUNING.contextWindow;
  const frac = { ...DEFAULT_TUNING.contextLimits, ...(t.contextLimits || {}) };
  return {
    stepBudget: { ...DEFAULT_TUNING.stepBudget, ...(t.stepBudget || {}) },
    contextWindow: window,
    contextLimits: { session: Math.round(window * frac.session), phaseA: Math.round(window * frac.phaseA) },
  };
}

function tuningProblems(t) {
  const errs = [];
  if (!t || typeof t !== "object" || Array.isArray(t)) return ["tuning must be an object (omit it for the defaults)"];
  const known = (obj, where, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k)).forEach((k) => errs.push(`${where}: unknown key "${k}"`));
  known(t, "tuning", Object.keys(DEFAULT_TUNING));
  if ("stepBudget" in t) {
    const s = t.stepBudget;
    if (!s || typeof s !== "object" || Array.isArray(s)) errs.push("tuning.stepBudget must be an object");
    else {
      known(s, "tuning.stepBudget", Object.keys(DEFAULT_TUNING.stepBudget));
      for (const k of Object.keys(DEFAULT_TUNING.stepBudget)) if (k in s && !(Number.isInteger(s[k]) && s[k] >= 1)) errs.push(`tuning.stepBudget.${k} must be a whole number of tool calls, at least 1`);
      const r = { ...DEFAULT_TUNING.stepBudget, ...s };
      if (Number.isInteger(r.hard) && Number.isInteger(r.soft) && r.hard < r.soft) errs.push("tuning.stepBudget.hard must not be below soft");
    }
  }
  if ("contextWindow" in t && !(Number.isInteger(t.contextWindow) && t.contextWindow >= 10_000)) errs.push("tuning.contextWindow must be a token count (the model's context window, at least 10000)");
  if ("contextLimits" in t) {
    const l = t.contextLimits;
    if (!l || typeof l !== "object" || Array.isArray(l)) errs.push("tuning.contextLimits must be an object");
    else {
      known(l, "tuning.contextLimits", Object.keys(DEFAULT_TUNING.contextLimits));
      for (const k of Object.keys(DEFAULT_TUNING.contextLimits)) if (k in l && !(typeof l[k] === "number" && l[k] > 0 && l[k] <= 1)) errs.push(`tuning.contextLimits.${k} must be a fraction of the context window (0 < x ≤ 1)`);
    }
  }
  return errs;
}

/** This machine's figures for safeLanes. Free memory = what the OS can hand out without swapping. */
export function machineNow() {
  let memFreePct = (os.freemem() / os.totalmem()) * 100;
  if (process.platform === "darwin") {
    const level = Number(sh("sysctl", ["-n", "kern.memorystatus_level"], "/"));
    if (level > 0) memFreePct = level;
  } else {
    try {
      const m = fs.readFileSync("/proc/meminfo", "utf8");
      const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(m)?.[1]);
      if (kb("MemAvailable") > 0) memFreePct = (kb("MemAvailable") / kb("MemTotal")) * 100;
    } catch {}
  }
  return { cpus: os.cpus().length, ramGB: Math.round(os.totalmem() / 2 ** 30), load1: Math.round(os.loadavg()[0] * 10) / 10, memFreePct: Math.round(memFreePct) };
}

/**
 * The scope lock: every reason this checkout may not run sapu (empty = allowed). The identity
 * checks come from the contract; the allowed roots and the project-scope rule from the machine
 * config (loadMachineConfig), which no contract can widen.
 */
export function lockProblems(main, c, machine = loadMachineConfig(machineConfigPath(), { main })) {
  const p = [];
  // A bare repository has no files to compare against origin and no branch to fast-forward.
  if (sh("git", ["-C", main, "rev-parse", "--is-bare-repository"], main) === "true") {
    p.push(`${main} is a bare repository: sapu needs a main checkout of the base branch as the first worktree (git worktree list), not a bare clone`);
  }
  if (machine.allowedRoots.length && !underAllowedRoot(main, machine.allowedRoots)) {
    p.push(`${main} is outside the allowed roots in ${machine.path} (${machine.allowedRoots.join(", ")})`);
  }
  const login = sh("gh", ["api", "user", "--jq", ".login"], main);
  if (login !== c.ghUser) p.push(`active gh account is "${login || "none"}", the contract needs "${c.ghUser}"`);
  // --local: a global email that happens to match must not pass for this repo's identity.
  const email = sh("git", ["-C", main, "config", "--local", "user.email"], main);
  if (email !== c.gitEmail) p.push(`git user.email is "${email || "unset"}", the contract needs "${c.gitEmail}"`);
  const origin = nwoFromRemote(sh("git", ["-C", main, "remote", "get-url", "origin"], main), hostOf(c));
  if (!origin || origin.toLowerCase() !== c.repo.toLowerCase()) p.push(`origin is "${origin || "none"}" on ${hostOf(c)}, the contract says "${c.repo}"`);
  // A trusted login renamed and re-registered by someone else would still pass by id elsewhere, but
  // the contract would name the wrong person: the recorded login must still resolve to its id.
  const lists = [["trustedAuthors", c.trustedAuthors], ["labels.acceptors", c.labels && c.labels.acceptors]];
  for (const [where, list] of lists) {
    for (const e of Array.isArray(list) ? list : []) {
      const id = sh("gh", ["api", `users/${restLogin(e.login)}`, "--jq", ".id"], main);
      if (id !== String(e.id)) {
        p.push(`${where}: "${e.login}" now resolves to ${id ? `id ${id}` : "no account"}, the contract records ${e.id} — renamed, deleted or re-registered: confirm who that account is, then fix the entry`);
      }
    }
  }
  if (machine.projectScopeOnly) {
    // Only a definite "project/local scope" answer passes: an answer we cannot read is not a no.
    const userScope = userScopeInstall();
    if (userScope === true) {
      p.push(
        `the sapu plugin is installed at USER scope, so every repo on this machine loads it, and ${machine.path} sets projectScopeOnly: ` +
          "`claude plugin uninstall sapu@sapu --scope user`, then install it with --scope project in each repo that opts in",
      );
    } else if (userScope !== false) {
      p.push(
        `cannot confirm the plugin's install scope (\`claude plugin list --json\` failed, timed out, or lists no sapu@ install at project or local scope), and ${machine.path} sets projectScopeOnly: ` +
          "check `claude plugin list` and install sapu with --scope project in this repo",
      );
    }
  }
  return p;
}

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * The `## <section>` headings each engine skill reads from its profile `.claude/sapu/<skill>.md`
 * (tests/engine.test.ts proves every entry is still referenced as `§<section>` by that skill).
 * A profile marked optional may be absent; a present one must carry every section. A large profile
 * may be split into topic files `<skill>-<topic>.md`; the sections of all of them count.
 */
export const PROFILE_SECTIONS = {
  sapu: { optional: false, sections: ["Context", "Security", "Context economy", "Step 0", "Verification", "Merge", "Wave", "End-of-wave net", "Finish"] },
  worker: { optional: false, sections: ["Setup", "Red areas", "Test DB", "Protected targets", "Test", "Verification", "Teardown"] },
  forge: { optional: false, sections: ["Token discipline", "Labels", "Worktree", "Tests", "Merge gate", "After merge", "Team", "Invariant domains", "Invariants", "Security bar", "Bypass classes", "Research dossier", "Inline review", "Decisions", "Incidents"] },
  argus: {
    optional: true,
    sections: [
      "Repo & account", "Written rules", "Glossary", "Actors", "Database", "Prohibitions", "Cycle", "Bypass classes", "Navigation", "Operator realism", "Cold-start", "Controls", "S5", "Filing", "Oracle", "Template", "Provenance",
      "Coverage", "Test design", "Derived oracles", "Concurrency",
      "Fraud: rules", "Fraud: schemes", "Fraud: SoD matrix", "Fraud: rotation", "Fraud: vectors", "Fraud: thresholds", "Fraud: detection", "Fraud: BUSL-07",
      "Curator: UI rules", "Curator: instruments", "Curator: slop", "Curator: product",
    ],
  },
  momus: { optional: true, sections: ["Glossary", "Reference incidents", "Decision documents", "Security bar", "Scope", "Database", ..."ABCDEFGHI".split("").map((x) => `Area ${x}`), "Tracker"] },
  nemesis: { optional: true, sections: ["Security bar", "Scope", "Surfaces", "Test resources", "Grown-surface map", "Verify gates", "Pass hooks", "Severity", "Filing", "Chaining playbooks", "References", "Real precedent"] },
  dream: { optional: true, sections: ["Findings routing"] },
};

/** Reads files of `root` at git revision `rev`, or from its working tree when `rev` is null. */
function repoFiles(root, rev) {
  if (!rev) {
    return {
      list: (d) => {
        try {
          return fs.readdirSync(path.join(root, d));
        } catch {
          return [];
        }
      },
      read: (f) => fs.readFileSync(path.join(root, f), "utf8"),
    };
  }
  return {
    list: (d) => sh("git", ["-C", root, "ls-tree", "--name-only", `${rev}:${d}`], root).split("\n").filter(Boolean),
    read: (f) => execFileSync("git", ["-C", root, "show", `${rev}:${f}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
  };
}

/**
 * Missing profile sections per skill, e.g. {forge: ["Invariants"]}; an absent optional profile is
 * fine. Reads `root`'s committed HEAD by default; `{rev: null}` reads its working tree.
 */
export function profileProblems(root, skills = Object.keys(PROFILE_SECTIONS), { rev = "HEAD" } = {}) {
  const out = {};
  // A local home is outside git: its files are read as they are, whatever `rev` says.
  const home = contractHome(root);
  const files = home.mode === "local" ? repoFiles(home.dir, null) : repoFiles(root, rev);
  const dir = home.mode === "local" ? "." : ".claude/sapu";
  for (const s of skills) {
    const spec = PROFILE_SECTIONS[s];
    const names = files.list(dir).filter((f) => f === `${s}.md` || (f.startsWith(`${s}-`) && f.endsWith(".md")));
    if (!names.includes(`${s}.md`)) {
      if (!spec.optional) out[s] = ["(file missing)"];
      continue;
    }
    const text = names.map((f) => files.read(`${dir}/${f}`)).join("\n");
    const heads = new Set(text.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.slice(3).trim()));
    const missing = spec.sections.filter((h) => !heads.has(h));
    if (missing.length) out[s] = missing;
  }
  return out;
}

// A segment of a handoff command: a cd, a git look or WIP commit (git's global options allowed), an
// echo without substitution, a teardown (up to two words before it: `npm run teardown`, `bash scripts/teardown.sh`). Quoted text is dropped before splitting, so a `;` in
// a commit message does not split it; a pipe, `$( )` or backtick never counts as handoff.
const HANDOFF_SEGMENT = /^(cd\s+\S+|git(\s+(-C|-c)\s+\S+|\s+--no-pager)*\s+(add|commit|status|log|diff|rev-parse|show|branch)\b.*|echo\b.*|true|(\S+\s+){0,2}\S*teardown\S*(\s.*)?)$/;
/** Is `command` a handoff command, which the guard's step budget never refuses (a WIP commit, a teardown)? */
export function isHandoffCommand(command) {
  // `2>&1` keeps a command a handoff; a background `&`, a pipe, `$( )` or a backtick never does.
  if (typeof command !== "string" || /\$\(|`|(^|[^|])\|(?!\|)|(^|[^&>])&(?![&>\d])/.test(command)) return false;
  const bare = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
  const segs = bare.split(/&&|\|\||;|\n/).map((s) => s.trim()).filter(Boolean);
  return segs.length > 0 && segs.every((s) => HANDOFF_SEGMENT.test(s));
}

/** The commands a profile section writes: its inline code spans and the lines of its fenced blocks. */
function sectionCommands(text, heading) {
  const m = new RegExp(`^## ${heading}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(text);
  if (!m) return [];
  const body = m[1];
  const fenced = [...body.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].flatMap((f) => f[1].split("\n").map((l) => l.trim()).filter(Boolean));
  const inline = [...body.replace(/^```[^\n]*\n[\s\S]*?^```/gm, "").matchAll(/`([^`\n]+)`/g)].map((x) => x[1].trim());
  return [...fenced, ...inline];
}

/**
 * What /sapu:init should still settle in the profiles (never a failure): worker.md §Teardown writing
 * commands of which none is a handoff command, so a worker at its step-budget reminder would have
 * that call refused once instead of tearing down. A section with no command (nothing to tear down)
 * is fine.
 */
export function profileWarnings(root, { rev = "HEAD" } = {}) {
  const home = contractHome(root);
  const files = home.mode === "local" ? repoFiles(home.dir, null) : repoFiles(root, rev);
  const dir = home.mode === "local" ? "." : ".claude/sapu";
  const out = [];
  let text = "";
  try {
    text = files.list(dir).filter((f) => f === "worker.md" || (f.startsWith("worker-") && f.endsWith(".md"))).map((f) => files.read(`${dir}/${f}`)).join("\n");
  } catch {
    return out;
  }
  const cmds = sectionCommands(text, "Teardown");
  if (cmds.length && !cmds.some(isHandoffCommand)) {
    out.push(
      "worker.md §Teardown names no command the step budget treats as a handoff (`<script> teardown <ID>`, `npm run teardown -- <ID>`, `bash scripts/teardown.sh <ID>`): put the teardown behind one such command, or a worker at its step-budget reminder has that call refused once",
    );
  }
  return out;
}

/**
 * Is sapu installed at USER scope (loaded in every repo)? true = yes; false = every sapu install
 * listed is at project or local scope; null = could not tell: `claude` missing, failing or slow,
 * output that is not the expected list, no sapu entry in it, or a scope this code does not know.
 */
export function userScopeInstall() {
  let list;
  try {
    list = JSON.parse(execFileSync("claude", ["plugin", "list", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 }));
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const sapu = list.filter((p) => p && typeof p.id === "string" && /^sapu@/.test(p.id));
  if (sapu.some((p) => p.scope === "user")) return true;
  return sapu.length > 0 && sapu.every((p) => p.scope === "project" || p.scope === "local") ? false : null;
}

/**
 * Whether the senior-dev-team plugin (sapu's dependency, the default specialists) is installed and
 * enabled here: true / false, or null when `claude plugin list --json` cannot be read.
 */
export function seniorDevTeamInstalled() {
  let list;
  try {
    list = JSON.parse(execFileSync("claude", ["plugin", "list", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 }));
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  return list.some((p) => p && typeof p.id === "string" && /^senior-dev-team@/.test(p.id) && p.enabled !== false && !(Array.isArray(p.errors) && p.errors.length));
}

/**
 * `gh <args>` parsed as one JSON document, or with `lines` as JSON Lines (a `--jq '… | @json'`
 * filter prints one per line, also across `--paginate` pages). Throws with gh's last error line:
 * the callers fail closed, since a trust answer GitHub did not give is not a yes.
 */
function ghJson(args, { lines = false } = {}) {
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error || r.status !== 0) throw new Error(`${(r.stderr || (r.error && r.error.message) || "").trim().split("\n").pop() || `gh exited ${r.status}`}`);
  const out = r.stdout.trim();
  return lines ? (out ? out.split("\n").map((l) => JSON.parse(l)) : []) : JSON.parse(out);
}

/**
 * The trusted set of contract `c` with the owner's id read from the active gh account, which must be
 * `ghUser` (the id is never written in the contract: the account that runs sapu is the owner).
 * Throws when gh cannot say, or when another account is active.
 */
export function resolveTrusted(c) {
  const me = ghJson(["api", "user", "--jq", "{login: .login, id: .id} | @json"]);
  if (!me || lc(me.login) !== lc(c.ghUser) || !isId(me.id)) {
    throw new Error(`the active gh account is "${me && me.login}", the contract's ghUser is "${c.ghUser}": the owner's id is read from the active account`);
  }
  return trustedSet(c, me);
}

// GraphQL: an account's numeric id is `databaseId` (User, Bot) — the same number as REST's `id`.
// Node ids are never compared, and neither are logins.
const WHO = "login ... on User{databaseId} ... on Bot{databaseId}";
/** A GraphQL actor as {login, id}; null for a deleted account. */
const person = (a) => (a && typeof a === "object" ? { login: typeof a.login === "string" ? a.login : null, id: isId(a.databaseId) ? a.databaseId : null } : null);
const named = (p) => (p ? `${p.login ?? "?"} (id ${p.id ?? "?"})` : "a deleted account");

// ONE query returns everything the issue verdict reads AND the text it hands out: author, labels,
// body edits, the label/title timeline, title and body. The verdict is on exactly that snapshot.
// A label event names the label as it is NOW (GraphQL resolves the live Label), so `updatedAt` is
// read too: a label renamed or edited after it was applied could be another label entirely.
const TIMELINE =
  "timelineItems(first:100,after:$after,itemTypes:[LABELED_EVENT,UNLABELED_EVENT,RENAMED_TITLE_EVENT]){pageInfo{hasNextPage endCursor} " +
  `nodes{__typename ... on LabeledEvent{createdAt actor{${WHO}} label{name updatedAt}} ... on UnlabeledEvent{createdAt actor{${WHO}} label{name updatedAt}} ... on RenamedTitleEvent{createdAt actor{${WHO}}}}}`;
const snapshotOf = (type) =>
  `... on ${type}{title body lastEditedAt author{${WHO}} editor{${WHO}} labels(first:100){totalCount nodes{name}} ` +
  `userContentEdits(first:100){totalCount nodes{editedAt deletedAt editor{${WHO}}}} ${TIMELINE}}`;
const ISSUE_QUERY =
  "query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){" +
  `__typename ${snapshotOf("Issue")} ${snapshotOf("PullRequest")}}}}`;
// The later timeline pages: the timeline alone, so a long history costs light queries, not full ones.
const TIMELINE_QUERY =
  "query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){" +
  `__typename ... on Issue{${TIMELINE}} ... on PullRequest{${TIMELINE}}}}}`;

/**
 * Issue or PR `n`: its first page (the full snapshot) and `events()`, which pages the rest of the
 * label/title timeline with the light query only when called, oldest first.
 */
function issueSnapshot(c, n) {
  const [owner, name] = c.repo.split("/");
  const page = (query, after, full) => {
    const args = ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${n}`];
    if (after) args.push("-f", `after=${after}`);
    const node = ghJson(args)?.data?.repository?.issueOrPullRequest;
    // A node missing without a gh error is not a yes: every field the verdict reads must be there.
    if (!node || typeof node !== "object" || !node.timelineItems || (full && (!node.labels || !node.userContentEdits))) throw new Error(`GitHub returned no issue or PR #${n}`);
    return node;
  };
  const first = page(ISSUE_QUERY, null, true);
  const events = () => {
    const nodes = [...first.timelineItems.nodes];
    for (let info = first.timelineItems.pageInfo, pages = 1; info && info.hasNextPage; pages++) {
      if (pages >= 50) throw new Error(`issue #${n} has more timeline events than can be checked`);
      const next = page(TIMELINE_QUERY, info.endCursor, false);
      nodes.push(...next.timelineItems.nodes);
      info = next.timelineItems.pageInfo;
    }
    return nodes
      .map((e, i) => ({ type: e && e.__typename, at: e && e.createdAt, actor: person(e && e.actor), label: e && e.label ? e.label.name : null, labelUpdatedAt: e && e.label ? e.label.updatedAt : null, i }))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.i - b.i);
  };
  return { first, events };
}

/**
 * May issue (or PR) `n` of contract `c` steer sapu? {trusted, reason, acceptedBy, snapshot}, where
 * snapshot = {kind, title, body, author, lastEditedAt, editor} is the text the verdict judged — the
 * only issue text a skill may read. Yes when its author's id is in `trusted` (decided on the first
 * page). Otherwise only when it carries acceptedLabel(c) NOW, the latest labeled/unlabeled event for
 * that label applied it, by an acceptor (labels.acceptors, else the trusted set; an issue template
 * applies labels as the issue's author), the label was not renamed or edited since (GraphQL names a
 * label as it is now), and since then NO id outside the set retitled it or edited its body — any
 * such edit refuses, even one a trusted edit followed, deleted revisions included: the acceptance
 * covers the text as it stood. Throws when GitHub cannot be read.
 */
export function issueTrust(c, n, trusted = resolveTrusted(c)) {
  const ids = new Set(trusted.map((t) => t.id));
  const ok = (p) => !!p && ids.has(p.id);
  const own = c.labels && Array.isArray(c.labels.acceptors) ? new Set(c.labels.acceptors.map((a) => a.id)) : null;
  const accepts = (p) => !!p && (own ? own.has(p.id) : ids.has(p.id));
  const label = acceptedLabel(c);
  const { first, events: timeline } = issueSnapshot(c, n);
  const snapshot = {
    kind: first.__typename === "PullRequest" ? "pr" : "issue",
    title: first.title,
    body: first.body,
    author: person(first.author),
    lastEditedAt: first.lastEditedAt ?? null,
    editor: person(first.editor),
  };
  const verdict = (yes, reason, acceptedBy = null) => ({ trusted: yes, reason, acceptedBy, snapshot });
  if (ok(snapshot.author)) return verdict(true, `author ${named(snapshot.author)} is in the trusted set`);
  const author = `author ${named(snapshot.author)} is not in the trusted set`;
  if (!first.labels.nodes.some((l) => l && l.name === label)) return verdict(false, `${author} and the issue does not carry ${label} (a trusted login applies it to accept the issue)`);
  const events = timeline();
  const last = events.filter((e) => e.label === label && (e.type === "LabeledEvent" || e.type === "UnlabeledEvent")).at(-1);
  if (!last || last.type !== "LabeledEvent") return verdict(false, `${author}, and no event shows who applied ${label}`);
  if (!accepts(last.actor)) {
    return verdict(false, `${author}, and ${label} was last applied by ${named(last.actor)}, who is not ${own ? "an acceptor (labels.acceptors)" : "in the trusted set"}`);
  }
  if (typeof last.labelUpdatedAt !== "string" || Date.parse(last.labelUpdatedAt) > Date.parse(last.at)) {
    return verdict(false, `${author}, and ${label} was renamed or changed after it was applied, so that event may be another label's: re-apply it`);
  }
  const since = Date.parse(last.at);
  const later = (t) => typeof t === "string" && Date.parse(t) >= since;
  const retitle = events.find((e) => e.type === "RenamedTitleEvent" && later(e.at) && !ok(e.actor));
  if (retitle) return verdict(false, `${author}, and it was retitled by ${named(retitle.actor)} after ${label} was applied`);
  const edits = first.userContentEdits;
  if (edits.totalCount > edits.nodes.length) return verdict(false, `${author}, and it has more body edits than can be checked (${edits.totalCount})`);
  const edit = [...edits.nodes.map((e) => ({ at: e && e.editedAt, by: person(e && e.editor) })), { at: snapshot.lastEditedAt, by: snapshot.editor }].find((e) => later(e.at) && !ok(e.by));
  if (edit) return verdict(false, `${author}, and its body was edited by ${named(edit.by)} after ${label} was applied`);
  return verdict(true, `${author}, but ${named(last.actor)} applied ${label} at ${last.at}`, { login: last.actor.login, id: last.actor.id, at: last.at });
}

/** Issue `n`'s comments by trusted ids, oldest first ({author, authorId, createdAt, body}), and how many others were withheld. */
export function trustedComments(c, n, trusted = resolveTrusted(c)) {
  const ids = new Set(trusted.map((t) => t.id));
  const all = ghJson(["api", "--paginate", `repos/${c.repo}/issues/${n}/comments?per_page=100`, "--jq", ".[] | {login: .user.login, id: .user.id, createdAt: .created_at, body} | @json"], { lines: true });
  const comments = all.filter((x) => ids.has(x.id)).map((x) => ({ author: x.login, authorId: x.id, createdAt: x.createdAt, body: x.body }));
  return { comments, withheld: all.length - comments.length };
}

/**
 * A PR's reviews and inline review comments by the people who may steer a fix: the trusted set plus
 * `policy.reviewers` (merge "human": the colleagues who approve). Everyone else is counted, never
 * shown. `state` = each such reviewer's latest review state (APPROVED, CHANGES_REQUESTED, ...).
 */
export function prReviews(c, n, trusted = resolveTrusted(c)) {
  const ids = new Set(trusted.map((t) => t.id));
  const logins = new Set(resolvePolicy(c).reviewers.map(lc));
  const ok = (x) => ids.has(x.id) || logins.has(lc(x.login));
  const reviews = ghJson(["api", "--paginate", `repos/${c.repo}/pulls/${n}/reviews?per_page=100`, "--jq", ".[] | {login: .user.login, id: .user.id, state, submittedAt: .submitted_at, body} | @json"], { lines: true });
  const inline = ghJson(["api", "--paginate", `repos/${c.repo}/pulls/${n}/comments?per_page=100`, "--jq", ".[] | {login: .user.login, id: .user.id, path, line, body} | @json"], { lines: true });
  const state = {};
  for (const r of reviews.filter(ok)) state[r.login] = r.state;
  return {
    state,
    reviews: reviews.filter(ok).map((r) => ({ author: r.login, state: r.state, submittedAt: r.submittedAt, body: r.body })),
    comments: inline.filter(ok).map((x) => ({ author: x.login, path: x.path, line: x.line, body: x.body })),
    withheld: reviews.length + inline.length - reviews.filter(ok).length - inline.filter(ok).length,
  };
}

// An issue as a PR body names it: #N, owner/repo#N, GH-N, or an issue/PR URL on github.com or the contract's host.
const oneRef = (host) => {
  const hosts = [...new Set([DEFAULT_HOST, host.toLowerCase()])].map((h) => h.replace(/[.-]/g, "\\$&")).join("|");
  return String.raw`(?:https?:\/\/(${hosts})\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)|(?<![\w/.-])([\w.-]+\/[\w.-]+)#(\d+)|(?<![\w&#/])#(\d+)|\bGH-(\d+))\b`;
};
const listOf = (keyword) => (one) => new RegExp(String.raw`\b(?:${keyword})\b[:\s]+(${one}(?:(?:,\s*and\s+|,\s*|\s+and\s+|\s*&\s*)${one})*)`, "gi");
const closeList = listOf(String.raw`close[sd]?|fix(?:e[sd])?|resolve[sd]?`);
const citeList = listOf(String.raw`refs?|references?`);
// A URL on another host than the repo's names another repository (`github.com/o/r` from a GitHub Enterprise PR).
const asRef = (host) => (r) => ({ repo: r[2] ? (lc(r[1]) === lc(host) ? r[2] : `${lc(r[1])}/${r[2]}`) : r[4] || null, number: Number(r[3] || r[5] || r[6] || r[7]) });

/**
 * Every issue or PR a PR body names, as {repo, number} (repo null = this repo): `closes` = those a
 * Closes/Fixes/Resolves list closes (relabelled after the merge), `refs` = every other mention —
 * `Refs #8`, `Implements #8`, `Part of #8`, a bare `#8`, `GH-8`, `owner/repo#8`, an issue URL — and
 * `cited` = those of `refs` a Refs/Ref/References list names (a deliberate reference, which pr-trust
 * refuses in another repository; any other mention of another repository is informational). Code
 * (fenced blocks, inline spans) is skipped, as GitHub skips it when it links references. `host` is
 * the repo's GitHub host (hostOf).
 */
export function bodyRefs(body, host = DEFAULT_HOST) {
  const one = oneRef(host);
  const text = String(body || "").replace(/```[\s\S]*?(```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
  const listed = (list) => [...text.matchAll(list(one))].flatMap((m) => [...m[1].matchAll(new RegExp(one, "gi"))].map(asRef(host)));
  const closes = listed(closeList);
  const key = (x) => `${lc(x.repo ?? "")}#${x.number}`;
  const closing = new Set(closes.map(key));
  const refs = [...text.matchAll(new RegExp(one, "gi"))].map(asRef(host)).filter((x) => !closing.has(key(x)));
  const cited = listed(citeList).filter((x) => !closing.has(key(x)));
  return { closes, refs, cited };
}

/**
 * What to add to a "referenced issue" refusal: the line of the PR body that carries `#n` (a quote of
 * the author's own text, cut short) and how to clear it when it was never a reference. A number
 * written with a `#` in prose ("invariant #6") is read as issue #6 and refused when that issue's
 * author is not trusted; the check stays strict, so the refusal has to be easy to act on.
 */
function mentionHint(body, n) {
  const at = new RegExp(String.raw`(?<![\w&#/])#${n}\b`);
  const line = String(body || "").replace(/```[\s\S]*?(```|$)/g, " ").split("\n").find((l) => at.test(l));
  const quote = line ? ` Mentioned in: "${line.trim().replace(/\s+/g, " ").slice(0, 100)}".` : "";
  return `${quote} If it is not a reference, write the number without the # (e.g. "invariant 6") or put it in backticks.`;
}

const PR_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){" +
  `number title body state isDraft isCrossRepository headRefName headRefOid baseRefName headRepository{nameWithOwner} author{${WHO}} ` +
  "commits(first:100){totalCount nodes{commit{oid authors(first:25){totalCount nodes{email user{login databaseId}}} signature{isValid signer{login databaseId}}}}} " +
  "closingIssuesReferences(first:50){totalCount nodes{number repository{nameWithOwner}}}}}}";

/**
 * May PR `n` of contract `c` be checked out, gated or merged? The one implementation of the PR
 * rules (sapu-merge.sh and the sapu skill both call `pr-trust`). A refusal is
 * {trusted: false, pr, author, rule, reason} — nothing of the PR's own text. Rules, in order: fork
 * (cross-repository, or a head repository that is not this one); author (its id); commit author
 * (every author of every commit, co-authors included: a trusted id, or no GitHub account and
 * gitEmail); commit signature (with requireSignedCommits: a valid signature by a trusted id); closing
 * / referenced issue (GitHub's closing references plus every issue the body names: one a
 * Closes/Fixes/Resolves or Refs list puts in another repository, or one of this repository failing
 * issueTrust; other mentions of another repository are informational). Throws when GitHub cannot be read.
 */
export function prTrust(c, n, trusted = resolveTrusted(c)) {
  const ids = new Set(trusted.map((t) => t.id));
  const ok = (p) => !!p && ids.has(p.id);
  const [owner, name] = c.repo.split("/");
  const pr = ghJson(["api", "graphql", "-f", `query=${PR_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${n}`])?.data?.repository?.pullRequest;
  if (!pr || typeof pr !== "object" || !pr.commits || !Array.isArray(pr.commits.nodes) || !pr.closingIssuesReferences) throw new Error(`GitHub returned no PR #${n}`);
  const author = person(pr.author);
  const refuse = (rule, reason) => ({ trusted: false, pr: n, author, rule, reason });
  const here = (repo) => typeof repo === "string" && lc(repo) === lc(c.repo);
  if (pr.isCrossRepository !== false) return refuse("fork", "its head branch is in another repository (isCrossRepository is not false)");
  if (!pr.headRepository || !here(pr.headRepository.nameWithOwner)) return refuse("fork", `its head repository is ${pr.headRepository ? pr.headRepository.nameWithOwner : "gone"}, not ${c.repo}`);
  if (!ok(author)) return refuse("author", `opened by ${named(author)}, who is not in the trusted set`);
  const commits = pr.commits.nodes.map((x) => x && x.commit).filter(Boolean);
  if (commits.length === 0) return refuse("commit author", "GitHub listed no commits for it, so their authors are unknown");
  if (pr.commits.totalCount > commits.length) return refuse("commit author", `${pr.commits.totalCount} commits, more than the ${commits.length} that can be checked`);
  for (const k of commits) {
    const sha = String(k.oid || "?").slice(0, 7);
    const authors = k.authors && Array.isArray(k.authors.nodes) ? k.authors.nodes : [];
    if (authors.length === 0 || k.authors.totalCount > authors.length) return refuse("commit author", `commit ${sha}: not every author can be read`);
    for (const a of authors) {
      const u = a && a.user ? person(a.user) : null;
      if (u && u.id !== null) {
        if (!ok(u)) return refuse("commit author", `commit ${sha} is by ${named(u)}, who is not in the trusted set`);
      } else if (lc(a && a.email) !== lc(c.gitEmail)) {
        // Never echo the email: it is free text the committer chose, and reasons reach agents.
        return refuse("commit author", `commit ${sha}: an author with no GitHub account and an email other than gitEmail`);
      }
    }
    if (c.requireSignedCommits === true) {
      if (!k.signature || k.signature.isValid !== true) return refuse("commit signature", `commit ${sha} has no valid signature, and the contract sets requireSignedCommits`);
      const signer = person(k.signature.signer);
      if (!ok(signer)) return refuse("commit signature", `commit ${sha} is signed by ${named(signer)}, who is not in the trusted set`);
    }
  }
  const refs = bodyRefs(pr.body, hostOf(c));
  const gh = pr.closingIssuesReferences;
  if (gh.totalCount > gh.nodes.length) return refuse("closing issue", `it closes ${gh.totalCount} issues, more than can be checked`);
  // GitHub's own reference without a repository cannot be placed: it counts as another repository's.
  const closing = [...gh.nodes.map((x) => ({ repo: x && x.repository && typeof x.repository.nameWithOwner === "string" ? x.repository.nameWithOwner : "", number: x && x.number })), ...refs.closes];
  const outside = (list) => list.find((x) => x.repo !== null && !here(x.repo));
  const fc = outside(closing);
  if (fc) return refuse("closing issue", `it closes ${fc.repo || "an issue in a repository GitHub did not name"}#${fc.number}, outside ${c.repo}`);
  // A Refs list is deliberate, so one into another repository refuses like a closing one. Any other
  // mention of another repository (the plugin release a change adapts to) is informational: its
  // trust cannot be read, so it is neither checked nor relabelled, and its text is never read.
  const fr = outside(refs.cited);
  if (fr) return refuse("referenced issue", `it refs ${fr.repo}#${fr.number}, outside ${c.repo}`);
  const closes = [...new Set(closing.map((x) => x.number))].filter(isId).sort((a, b) => a - b);
  const refNums = [...new Set(refs.refs.filter((x) => x.repo === null || here(x.repo)).map((x) => x.number))].filter((x) => isId(x) && !closes.includes(x)).sort((a, b) => a - b);
  for (const [rule, nums] of [["closing issue", closes], ["referenced issue", refNums]]) {
    for (const i of nums) {
      const v = issueTrust(c, i, trusted);
      if (!v.trusted) return refuse(rule, `#${i}: ${v.reason}${rule === "referenced issue" ? mentionHint(pr.body, i) : ""}`);
    }
  }
  return {
    trusted: true,
    pr: n,
    author,
    reason: `not a fork; ${named(author)} and every commit author are trusted${c.requireSignedCommits === true ? ", every commit signed by a trusted id" : ""}; every issue it closes or refs passes issue-trust`,
    state: pr.state,
    isDraft: pr.isDraft === true,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    baseRefName: pr.baseRefName,
    commits: commits.length,
    closes,
    refs: refNums,
    title: pr.title,
    body: pr.body,
  };
}

// ONE SWEEP PER REPO. Two orchestrators on one repo would race for the same issues and merges, so
// /sapu holds a marker in <MAIN>/.git/sapu-sweep.json (never tracked, never in a worktree), named by
// its session's run marker (`sapu-run-<date-time>`) and refreshed by its heartbeat: every merge
// command and every lane launch holds it again. Another session's marker with a heartbeat younger
// than SWEEP_TTL_MS refuses the start; an older one is stale and taken over (a crashed session, a
// killed shell). The longest silence a live sweep has is one lane running with nothing else to do,
// which SWEEP_TTL_MS covers with room. A fresh marker is created atomically (O_EXCL); a takeover is
// a rename read back afterwards, so two sessions taking over one stale marker at the same instant
// is the only race left. Only the holder releases it; `sweep clear` is the person's, for a session
// that died while its marker is still fresh.
export const SWEEP_TTL_MS = 3 * 3600 * 1000;
const SWEEP_OWNER = /^[A-Za-z0-9][\w.:-]{0,99}$/;
const sweepFile = (main) => path.join(gitCommonDir(main) ?? path.join(main, ".git"), "sapu-sweep.json");

/** The marker: {owner, started, beat, host}, {corrupt: true} for one that cannot be read, or null when there is none. */
function readSweep(main) {
  let raw;
  try {
    raw = fs.readFileSync(sweepFile(main), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    return { corrupt: true };
  }
  try {
    const m = JSON.parse(raw);
    return m && typeof m.owner === "string" && Number.isFinite(Date.parse(m.beat)) ? m : { corrupt: true };
  } catch {
    return { corrupt: true };
  }
}

/** Status of the marker at `now`: {held: false} or {held: true, owner, started, beat, host, agoMin, fresh}. */
export function sweepStatus(main, now = Date.now()) {
  const m = readSweep(main);
  if (!m) return { held: false };
  if (m.corrupt) return { held: true, owner: null, corrupt: true, fresh: false };
  const ago = now - Date.parse(m.beat);
  return { held: true, owner: m.owner, started: m.started, beat: m.beat, host: m.host, agoMin: Math.max(0, Math.floor(ago / 60000)), fresh: ago < SWEEP_TTL_MS };
}

/**
 * Take or refresh the sweep marker for `owner`: {held: true, resumed, tookOver} when this session
 * holds it now, {held: false, holder, agoMin} when another session's heartbeat is fresh.
 */
export function sweepHold(main, owner, now = Date.now(), tries = 3) {
  const file = sweepFile(main);
  const cur = readSweep(main);
  const at = new Date(now).toISOString();
  const mine = (started) => `${JSON.stringify({ owner, started, beat: at, host: os.hostname() })}\n`;
  if (!cur) {
    try {
      fs.writeFileSync(file, mine(at), { flag: "wx" });
      return { held: true, resumed: false, tookOver: null };
    } catch (e) {
      if (e.code !== "EEXIST" || tries <= 0) throw e;
      return sweepHold(main, owner, now, tries - 1); // another session created it first: judge that one
    }
  }
  const ago = cur.corrupt ? Infinity : now - Date.parse(cur.beat);
  if (!cur.corrupt && cur.owner !== owner && ago < SWEEP_TTL_MS) return { held: false, holder: cur.owner, host: cur.host, agoMin: Math.max(0, Math.floor(ago / 60000)) };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, mine(cur.owner === owner && cur.started ? cur.started : at));
  fs.renameSync(tmp, file);
  const back = readSweep(main);
  if (!back || back.owner !== owner) return { held: false, holder: back && back.owner, agoMin: 0 };
  return { held: true, resumed: cur.owner === owner, tookOver: cur.owner === owner ? null : { owner: cur.owner ?? null, agoMin: Number.isFinite(ago) ? Math.floor(ago / 60000) : null } };
}

/** Remove the marker when `owner` holds it (or it is gone): {released: true}; another holder's stays: {released: false, holder}. */
export function sweepRelease(main, owner) {
  const cur = readSweep(main);
  if (cur && !cur.corrupt && cur.owner !== owner) return { released: false, holder: cur.owner };
  fs.rmSync(sweepFile(main), { force: true });
  return { released: true };
}

// THE GUARD /sapu:init PROPOSES. The engine floor knows JS package managers, Prisma and Postgres; every
// other ecosystem's destructive commands are blocked by the contract's guard.deny, and every other
// engine's dev database by guard.databases. detectStack reads the checkout (marker files, Compose
// files, Rails' database.yml; never an env file) and proposes both, for the owner to confirm.
const drop = (what) => `${what} destroys data other sessions use. Use your own throwaway test database (.claude/sapu/worker.md).`;
const variants = (progs, words, why) => progs.map((p) => ({ argv: [...p.split(" "), ...words], reason: drop(why) }));
const PY = ["python", "python3", "manage.py"];
/** Each ecosystem: the files that mark it (any one; `has` = text a file must contain), and the deny rules it gets. */
export const ECOSYSTEMS = {
  rails: {
    markers: [["bin/rails"], ["config/application.rb", /Rails::Application/]],
    deny: ["db:drop", "db:reset", "db:purge", "db:truncate_all", "db:migrate:reset", "db:schema:load", "db:seed:replant"].flatMap((t) => variants(["rails", "rake"], [t], `\`rails ${t}\``)),
  },
  django: {
    markers: [["manage.py"]],
    deny: [...variants([...PY.map((p) => (p === "manage.py" ? p : `${p} manage.py`)), "django-admin"], ["flush"], "`manage.py flush`"), ...variants(PY.map((p) => (p === "manage.py" ? p : `${p} manage.py`)), ["reset_db"], "`manage.py reset_db`"), ...variants(PY.map((p) => (p === "manage.py" ? p : `${p} manage.py`)), ["migrate", "zero"], "`manage.py migrate <app> zero`")],
  },
  alembic: { markers: [["alembic.ini"]], deny: variants(["alembic"], ["downgrade"], "`alembic downgrade`") },
  laravel: {
    markers: [["artisan"]],
    deny: ["migrate:fresh", "migrate:reset", "migrate:refresh", "db:wipe"].flatMap((t) => variants(["php artisan", "artisan", "sail artisan"], [t], `\`artisan ${t}\``)),
  },
  go: {
    markers: [["go.mod"]],
    deny: [...variants(["migrate"], ["drop"], "`migrate drop`"), ...variants(["migrate"], ["down"], "`migrate down`"), ...variants(["goose"], ["reset"], "`goose reset`"), ...variants(["goose"], ["down"], "`goose down`"), ...variants(["atlas"], ["schema", "clean"], "`atlas schema clean`")],
  },
  node: {
    // per ORM, only when package.json names it (Prisma is in the engine floor)
    markers: [["package.json"]],
    tools: {
      sequelize: [...variants(["sequelize", "sequelize-cli"], ["db:drop"], "`sequelize db:drop`"), ...variants(["sequelize", "sequelize-cli"], ["db:migrate:undo:all"], "`sequelize db:migrate:undo:all`")],
      typeorm: variants(["typeorm"], ["schema:drop"], "`typeorm schema:drop`"),
      knex: variants(["knex"], ["migrate:rollback", "--all"], "`knex migrate:rollback --all`"),
      "drizzle-kit": variants(["drizzle-kit"], ["drop"], "`drizzle-kit drop`"),
    },
    deny: [],
  },
};
const IMAGE_ENGINE = [[/(^|\/)(postgres|postgis|timescaledb)\b/, "postgres"], [/(^|\/)(mysql|mariadb|percona)\b/, "mysql"], [/(^|\/)mongo\b/, "mongodb"], [/(^|\/)(redis|valkey|keydb)\b/, "redis"]];
const DB_ENV = /^(POSTGRES_DB|MYSQL_DATABASE|MARIADB_DATABASE|MONGO_INITDB_DATABASE)$/;
const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
/** Quotes dropped, each `${X:-default}` read as its default; a value with any other substitution → null. */
const composeValue = (v) => {
  const s = String(v).trim().replace(/^(["'])(.*)\1$/, "$2").replace(/\$\{\w+:?-([^}]*)\}/g, "$1");
  return s.includes("$") ? null : s;
};

/** The dev databases a Compose file's services publish: [{engine, ports, databases}] (a line reader for the common shapes, not YAML). */
export function composeDatabases(text) {
  const out = [];
  let svcIndent = -1;
  let svc = null;
  let inPorts = false;
  for (const raw of String(text).split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      svcIndent = line === "services:" ? -2 : -1;
      continue;
    }
    if (svcIndent === -1) continue;
    if (svcIndent === -2) svcIndent = indent;
    if (indent === svcIndent) {
      svc = { image: "", ports: [], databases: [] };
      out.push(svc);
      inPorts = false;
      continue;
    }
    if (!svc) continue;
    if (inPorts && line.startsWith("-") && !/^-\s*[A-Za-z_][\w.-]*\s*:/.test(line)) {
      svc.ports.push(line.replace(/^-\s*/, ""));
      continue;
    }
    const kv = /^(?:-\s*)?([\w.-]+)\s*[:=]\s*(.*)$/.exec(line);
    if (kv && kv[1] === "image") svc.image = composeValue(kv[2]) ?? "";
    if (kv && DB_ENV.test(kv[1])) {
      const v = composeValue(kv[2]);
      if (v) svc.databases.push(v);
    }
    if (kv && kv[1] === "ports") {
      inPorts = true;
      for (const p of kv[2].replace(/^\[|\]$/g, "").split(",").filter((x) => x.trim())) svc.ports.push(p);
      continue;
    }
    if (kv && kv[1] === "published") svc.ports.push(`${composeValue(kv[2])}:0`);
    else if (kv && !["target", "published", "protocol", "mode", "host_ip", "app_protocol", "name"].includes(kv[1])) inPorts = false;
  }
  return out.flatMap((s) => {
    const engine = IMAGE_ENGINE.find(([re]) => re.test(s.image.toLowerCase()))?.[1];
    if (!engine) return [];
    // "HOST:CONTAINER", "IP:HOST:CONTAINER": the host port; a container port alone is a random host port
    const ports = s.ports.map((p) => composeValue(p)).filter(Boolean).map((p) => p.replace(/\/\w+$/, "").split(":")).filter((x) => x.length >= 2).map((x) => Number(x[x.length - 2])).filter((n) => Number.isInteger(n) && n > 0);
    return [{ engine, ports, databases: s.databases }];
  });
}

/** The development database of a Rails config/database.yml: {engine, database} or null (ERB is skipped). */
function railsDatabase(text) {
  const adapter = /^\s*adapter:\s*(\w+)/m.exec(text)?.[1];
  const engine = { postgresql: "postgres", postgis: "postgres", mysql2: "mysql", trilogy: "mysql", sqlite3: "sqlite" }[adapter];
  const dev = /^development:\s*\n((?:[ \t]+.*\n?)*)/m.exec(text)?.[1] ?? "";
  const db = /^\s*database:\s*([^\s<#]+)\s*$/m.exec(dev)?.[1];
  return engine && db ? { engine, database: db } : null;
}

/** What /sapu:init proposes for the checkout at `root`: {ecosystems, sources, guard: {postgres, databases, deny}}. */
export function detectStack(root) {
  const read = (f) => {
    try {
      return fs.readFileSync(path.join(root, f), "utf8");
    } catch {
      return null;
    }
  };
  const sources = [];
  const ecosystems = [];
  const deny = [];
  for (const [name, eco] of Object.entries(ECOSYSTEMS)) {
    const hit = eco.markers.find(([f, has]) => {
      const t = read(f);
      return t !== null && (!has || has.test(t));
    });
    if (!hit) continue;
    let rules = eco.deny;
    if (eco.tools) {
      const pkg = read(hit[0]) ?? "";
      rules = Object.entries(eco.tools).flatMap(([tool, r]) => (new RegExp(`"${tool.replace(/[.-]/g, "\\$&")}"\\s*:`).test(pkg) ? r : []));
      if (!rules.length) continue;
    }
    ecosystems.push(name);
    sources.push(hit[0]);
    deny.push(...rules);
  }
  const dbs = [];
  for (const f of COMPOSE_FILES) {
    const t = read(f);
    if (t === null) continue;
    const found = composeDatabases(t);
    if (found.length) sources.push(f);
    dbs.push(...found);
  }
  const yml = read("config/database.yml");
  const rails = yml && railsDatabase(yml);
  if (rails) {
    sources.push("config/database.yml");
    dbs.push({ engine: rails.engine, ports: [], databases: [rails.database] });
  }
  // one entry per engine, in the order found
  const merged = [];
  for (const d of dbs) {
    const m = merged.find((x) => x.engine === d.engine);
    if (m) {
      m.ports = [...new Set([...m.ports, ...d.ports])];
      m.databases = [...new Set([...m.databases, ...d.databases])];
    } else merged.push({ engine: d.engine, ports: [...new Set(d.ports)], databases: [...new Set(d.databases)] });
  }
  const pg = merged.find((d) => d.engine === "postgres");
  return {
    ecosystems,
    sources: [...new Set(sources)],
    guard: { postgres: pg ? { ports: pg.ports, databases: pg.databases } : null, databases: merged.filter((d) => d.engine !== "postgres" && d.ports.length + d.databases.length > 0), deny },
  };
}

// WHICH FILE A CONTRACT COMMAND RUNS. sapu-merge.sh runs gate.merge in the PR's worktree, so a word
// naming repo code runs the PR's copy unless it is pinned: the merge runs <MAIN>'s copy instead,
// proven identical to origin/<base>'s blob. The one implementation of "which word" is
// protectedCommand; sapu-merge.sh calls it through `protect`, and `show`/`check` warn when gate.merge
// has none.
/** Interpreters whose first non-option word is the script they run. */
const SCRIPT_INTERPRETER = /^(?:bash|sh|zsh|dash|ksh|node|tsx|ts-node|python(?:\d+(?:\.\d+)?)?|ruby|perl|php|deno|bun)$/;
/** Interpreter options whose value is the next word (node's preloads), never the script. */
const PRELOAD_OPTS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader"]);
/**
 * Runners that run the command after them (`uv run pytest`): the subcommand that does (null = the
 * runner itself), options whose value is the next word, options that move the working directory or
 * run a shell string (the rest is then no longer a command sapu can pin).
 */
const COMMAND_RUNNERS = {
  uv: { sub: "run", values: ["--with", "--with-editable", "--with-requirements", "--extra", "--group", "--only-group", "--no-group", "--package", "-p", "--python", "--env-file", "--index", "--default-index", "-i", "--index-url", "--extra-index-url", "-f", "--find-links", "--cache-dir", "--config-file", "--color"], moves: ["--directory", "--project"] },
  poetry: { sub: "run", values: [], moves: ["-C", "--directory", "-P", "--project"] },
  pipenv: { sub: "run", values: [], moves: [] },
  npx: { sub: null, values: ["-p", "--package"], moves: ["-c", "--call"] },
  pnpm: { sub: "exec", values: [], moves: ["-C", "--dir", "-c", "--shell-mode", "-r", "--recursive", "-F", "--filter"] },
  env: { sub: null, values: ["-u", "--unset"], moves: ["-C", "--chdir", "-S", "--split-string"], assignments: true },
};
/** The default makefiles GNU make reads, in its order; the default justfiles just reads. */
const MAKEFILES = ["GNUmakefile", "makefile", "Makefile"];
const JUSTFILES = ["justfile", ".justfile", "Justfile", "JUSTFILE"];
/** just's options whose value is the next word (besides --justfile and --working-directory). */
const JUST_VALUES = ["--shell", "--shell-arg", "--dotenv-filename", "--dotenv-path", "-E", "--color", "--command-color", "--chooser"];
const repoPath = (w) => typeof w === "string" && !w.startsWith("/") && w.includes("/");
const optName = (w) => (w.startsWith("--") && w.includes("=") ? w.slice(0, w.indexOf("=")) : w);
/** Does option word `w` name one of `opts` (`--dir=x`, `-Cx` included)? */
const isOpt = (w, opts) => opts.includes(optName(w)) || opts.some((o) => /^-[A-Za-z]$/.test(o) && w.length > 2 && !w.startsWith("--") && w.startsWith(o));

/**
 * `words` (a contract command split on whitespace) as sapu-merge.sh runs it, and the index of the
 * word naming the repo file it pins: {words, index, file, why}. index null = nothing pinned (`why`
 * says so); the PR's own copy of the gate logic then runs. `hasFile(path)` answers whether the base
 * holds a file (it picks make's or just's default file). Pinned: a relative word with a `/` as the
 * program; an interpreter's script (its first non-option word, node's preload values and deno/bun
 * `run` skipped) when that is relative with a `/`; make's makefile and just's justfile (`-f`, else
 * the default the base holds, written out so the pinned copy is the one read, recipes still run in
 * the cwd). Runners that run a command (`uv run`, `poetry run`, `pipenv run`, `npx`, `pnpm exec`,
 * `env`) are peeled first. An absolute program runs as is.
 */
export function protectedCommand(words, hasFile = () => false) {
  const none = (why) => ({ words: [...words], index: null, file: null, why });
  const at = (ws, index) => ({ words: ws, index, file: ws[index], why: null });
  if (!words.length) return none("an empty command");
  if (repoPath(words[0])) return at([...words], 0);
  const prog = words[0].slice(words[0].lastIndexOf("/") + 1);
  const n = words.length;
  if (SCRIPT_INTERPRETER.test(prog)) {
    let j = 1;
    while (j < n && (words[j].startsWith("-") || (words[j] === "run" && (prog === "deno" || prog === "bun")))) j += PRELOAD_OPTS.has(words[j]) ? 2 : 1;
    return j < n && repoPath(words[j]) ? at([...words], j) : none(`${prog}'s script word is ${j < n ? `\`${words[j]}\`, not a relative path with a /` : "missing"}`);
  }
  const runner = COMMAND_RUNNERS[prog];
  if (runner) {
    let j = 1;
    let inSub = !runner.sub;
    while (j < n) {
      const w = words[j];
      if (isOpt(w, runner.moves)) return none(`\`${prog} ${optName(w)}\` moves the working directory or runs a shell string`);
      if (!inSub) {
        if (w === runner.sub) inSub = true;
        else if (!w.startsWith("-")) return none(`\`${prog} ${w}\` runs no command sapu can pin (only \`${prog} ${runner.sub}\` does)`);
        j++;
        continue;
      }
      if (w === "--") {
        j++;
        break;
      }
      if (runner.assignments && /^[A-Za-z_]\w*=/.test(w)) j++;
      else if (w.startsWith("-")) j += runner.values.includes(w) ? 2 : 1;
      else break;
    }
    if (!inSub || j >= n) return none(`\`${words.join(" ")}\` names no command`);
    const inner = protectedCommand(words.slice(j), hasFile);
    return inner.index === null ? { ...inner, words: [...words.slice(0, j), ...inner.words] } : at([...words.slice(0, j), ...inner.words], j + inner.index);
  }
  if (prog === "make" || prog === "gmake") {
    const ws = [words[0]];
    const files = [];
    for (let j = 1; j < n; j++) {
      const w = words[j];
      if (isOpt(w, ["-C", "--directory"])) return none(`\`make ${optName(w)}\` reads its makefile from another directory`);
      if (["-f", "--file", "--makefile"].includes(w)) {
        files.push(ws.length + 1);
        ws.push(w, words[++j] ?? "");
      } else if (/^--(?:file|makefile)=/.test(w) || /^-f./.test(w)) {
        files.push(ws.length + 1);
        ws.push("-f", w.startsWith("--") ? w.slice(w.indexOf("=") + 1) : w.slice(2));
      } else if (/^-[^-]*f/.test(w)) return none(`\`${w}\` bundles -f with other options: write -f on its own`);
      else ws.push(w);
    }
    if (files.length > 1) return none("make reads several makefiles; sapu pins one");
    if (files.length === 1) return ws[files[0]] && !ws[files[0]].startsWith("/") ? at(ws, files[0]) : none("make's -f names an absolute path");
    const def = MAKEFILES.find((f) => hasFile(f));
    return def ? at([words[0], "-f", def, ...words.slice(1)], 2) : none(`the base has none of ${MAKEFILES.join(", ")}`);
  }
  if (prog === "just") {
    const ws = [words[0]];
    let file = -1;
    let dir = false;
    let j = 1;
    for (; j < n && words[j].startsWith("-"); j++) {
      const w = words[j];
      const name = optName(w);
      if (name === "-f" || name === "--justfile") {
        file = ws.length + 1;
        ws.push(name, w.includes("=") ? w.slice(w.indexOf("=") + 1) : (words[++j] ?? ""));
      } else if (name === "-d" || name === "--working-directory") {
        dir = true;
        ws.push(w);
        if (!w.includes("=")) ws.push(words[++j] ?? "");
      } else {
        // an option's value is no recipe: --set takes two
        const take = w.includes("=") ? 0 : name === "--set" ? 2 : JUST_VALUES.includes(name) ? 1 : 0;
        ws.push(w, ...words.slice(j + 1, j + 1 + take));
        j += take;
      }
    }
    ws.push(...words.slice(j));
    if (file < 0) {
      if (dir) return none("just's --working-directory without --justfile");
      const def = JUSTFILES.find((f) => hasFile(f));
      return def ? at([words[0], "--justfile", def, "--working-directory", ".", ...words.slice(1)], 2) : none(`the base has none of ${JUSTFILES.join(", ")}`);
    }
    if (ws[file].startsWith("/")) return none("just's --justfile names an absolute path");
    // just runs recipes in the justfile's directory unless told otherwise: keep that directory.
    if (!dir) ws.splice(file + 1, 0, "--working-directory", path.posix.dirname(ws[file]));
    return at(ws, file);
  }
  return none(`\`${prog}\` reads the PR's own files; no word names a repo file sapu can pin`);
}

/** Does the repo at `root` hold `file` at `ref` (null = in its working tree)? */
function fileAt(root, ref, file) {
  if (ref === null) return fs.existsSync(path.join(root, file));
  return spawnSync("git", ["-C", root, "cat-file", "-e", `${ref}:${file}`], { stdio: "ignore" }).status === 0;
}

/** The warning `show`/`check` print when gate.merge pins no repo file, or null. */
export function gateProtectionWarning(contract, hasFile) {
  const merge = contract && contract.gate && contract.gate.merge;
  if (!isStr(merge)) return null;
  const p = protectedCommand(merge.trim().split(/\s+/), hasFile);
  if (p.index !== null) return null;
  return `gate.merge (\`${merge}\`) pins no repo file (${p.why}): sapu-merge.sh runs the PR's own copy of the gate's logic, so a PR can change the gate that judges it. Write it as a repo script run by path or by an interpreter (\`scripts/gate.sh\`, \`bash scripts/gate.sh\`, \`node scripts/gate.mjs\`, \`uv run python scripts/gate.py\`), or as \`make <target>\`/\`just <recipe>\` with the makefile or justfile on the base branch.`;
}

function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === "protect") {
    // protect [--ref <rev>] -- <word>...: before the option parsing below, which would eat a gate's own `--text`.
    const sep = args.indexOf("--");
    const opts = sep < 0 ? args : args.slice(0, sep);
    const ref = opts[0] === "--ref" && opts.length === 2 ? opts[1] : opts.length === 0 ? "HEAD" : null;
    const root = findMain(process.cwd());
    if (sep < 0 || ref === null || !/^[\w./@^~][\w./@^~-]*$/.test(ref) || !root) {
      process.stderr.write("sapu-contract: usage (inside the repo): sapu-contract.mjs protect [--ref <rev>] -- <word>...\n");
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify(protectedCommand(args.slice(sep + 1), (f) => fileAt(root, ref, f)))}\n`);
    return;
  }
  const workingTree = args.includes("--working-tree");
  const withComments = args.includes("--comments");
  const withText = args.includes("--text");
  // --ref <ref> | --ref=<ref>
  let ref = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--ref") ref = args[++i] ?? "";
    else if (args[i].startsWith("--ref=")) ref = args[i].slice("--ref=".length);
    else if (!["--working-tree", "--comments", "--text"].includes(args[i])) rest.push(args[i]);
  }
  const arg = rest[0];
  const fail = (msg) => {
    process.stderr.write(`sapu-contract: ${msg}\n`);
    process.exit(1);
  };
  if (!["check", "show", "wave-args", "specialists", "trusted", "issue-trust", "pr-trust", "get", "preflight", "profiles", "lanes", "home", "policy", "allowed", "pr-reviews", "sweep", "main", "stack", "tuning"].includes(cmd)) {
    fail("usage: sapu-contract.mjs check|show|wave-args|specialists|trusted|issue-trust <N> [--text] [--comments]|pr-trust <N> [--text]|get <a.b>|preflight|lanes|home|policy|allowed <skill>|pr-reviews <N>|sweep hold|release <run-marker>|sweep status|clear|main|stack|tuning|protect [--ref <rev>] -- <words>|profiles [--list] (show|profiles [--working-tree])");
  }
  // Everything that acts on the contract reads <MAIN>'s HEAD. Only /sapu:init, verifying the files
  // it just wrote on its own branch, reads a working tree — the one the command runs in.
  if (workingTree && cmd !== "show" && cmd !== "profiles") fail("--working-tree is only for `show` and `profiles` (/sapu:init verification); everything else reads the committed contract");
  if (withComments && cmd !== "issue-trust") fail("--comments is only for `issue-trust <N>`");
  if (withText && cmd !== "issue-trust" && cmd !== "pr-trust") fail("--text is only for `issue-trust <N>` and `pr-trust <N>`");
  if (ref !== null && (workingTree || !["show", "check", "get", "trusted", "issue-trust", "pr-trust"].includes(cmd) || !/^[\w./@^~][\w./@^~-]*$/.test(ref))) {
    fail("--ref <ref> is for `show`, `check`, `get`, `trusted`, `issue-trust` and `pr-trust`, with a plain git revision, and never with --working-tree");
  }
  if (cmd === "lanes") {
    const m = machineNow();
    const l = safeLanes(m);
    process.stdout.write(`${JSON.stringify({ ...l, ...gateWorkers({ cpus: m.cpus, busy: l.busy }), ...m })}\n`);
    return;
  }
  const mainDir = findMain(process.cwd());
  const here = workingTree ? checkoutRoot(process.cwd()) : mainDir;
  if (cmd === "stack") {
    const root = checkoutRoot(process.cwd());
    if (!root) fail("not inside a git repository");
    process.stdout.write(`${JSON.stringify(detectStack(root), null, 2)}\n`);
    return;
  }
  if (cmd === "main") {
    if (!mainDir) fail("cannot resolve the main checkout from here: outside a repo, or a --separate-git-dir checkout seen from a linked worktree (run `git config core.worktree <main checkout>` there once)");
    process.stdout.write(`${mainDir}\n`);
    return;
  }
  // A broken machine config stops the lock and preflight: the owner restricted this machine, and a
  // typo must not silently lift the restriction.
  const machineOrFail = () => {
    try {
      return loadMachineConfig(machineConfigPath(), { main: mainDir });
    } catch (e) {
      return fail(e.message);
    }
  };
  if (cmd === "preflight") {
    // For /sapu:init: facts only, no contract needed, never fails on them.
    const dir = mainDir || process.cwd();
    const machine = machineOrFail();
    const remote = mainDir ? parseRemote(sh("git", ["-C", dir, "remote", "get-url", "origin"], dir)) : null;
    // gh asks the origin's host (GitHub Enterprise) unless GH_HOST already names one
    if (remote && remote.host !== DEFAULT_HOST && !process.env.GH_HOST) process.env.GH_HOST = remote.host;
    const out = {
      main: mainDir,
      allowedRoot: machine.allowedRoots.length ? underAllowedRoot(dir, machine.allowedRoots) : null,
      machineConfig: machine.path,
      projectScopeOnly: machine.projectScopeOnly,
      origin: remote ? remote.nwo : null,
      host: remote ? remote.host : null,
      bare: mainDir ? sh("git", ["-C", mainDir, "rev-parse", "--is-bare-repository"], mainDir) === "true" : null,
      ghLogin: sh("gh", ["api", "user", "--jq", ".login"], dir) || null,
      gitEmail: mainDir ? sh("git", ["-C", dir, "config", "user.email"], dir) || null : null,
      userScopeInstall: userScopeInstall(),
      seniorDevTeam: seniorDevTeamInstalled(),
      hasContract: mainDir ? fs.existsSync(path.join(mainDir, CONTRACT_PATH)) : false,
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }
  if (cmd === "sweep") {
    // ONE SWEEP PER REPO (above). No contract needed: the marker lives in <MAIN>/.git.
    const [verb, owner] = rest;
    if (!["hold", "release", "status", "clear"].includes(verb) || ((verb === "hold" || verb === "release") && !SWEEP_OWNER.test(owner ?? ""))) {
      fail("usage: sapu-contract.mjs sweep hold|release <run-marker> | sweep status|clear (run-marker: letters, digits, . _ : -)");
    }
    if (!mainDir) fail("not inside a git repository");
    const script = fileURLToPath(import.meta.url);
    if (verb === "status") {
      process.stdout.write(`${JSON.stringify(sweepStatus(mainDir))}\n`);
    } else if (verb === "clear") {
      const s = sweepStatus(mainDir);
      fs.rmSync(sweepFile(mainDir), { force: true });
      process.stdout.write(s.held ? `removed ${sweepFile(mainDir)} (held by ${s.owner ?? "an unreadable marker"}${s.beat ? `, last heartbeat ${s.agoMin} min ago` : ""})\n` : "no sweep marker\n");
    } else if (verb === "release") {
      const r = sweepRelease(mainDir, owner);
      if (!r.released) fail(`the sweep marker is held by ${r.holder}, not ${owner}: left as it is`);
      process.stdout.write(`${JSON.stringify(r)}\n`);
    } else {
      const r = sweepHold(mainDir, owner);
      if (!r.held) {
        fail(`another sapu sweep holds this repo: ${r.holder}, last heartbeat ${r.agoMin} min ago${r.host ? ` on ${r.host}` : ""} (stale after ${SWEEP_TTL_MS / 60000} min). Two orchestrators would race for the same issues and merges: stop and report this. If that session is gone, the person at this machine removes the marker with \`node "${script}" sweep clear\`; never clear it yourself.`);
      }
      if (r.tookOver) process.stderr.write(`sapu-contract: took over a stale sweep marker of ${r.tookOver.owner ?? "an unreadable marker"}${r.tookOver.agoMin != null ? ` (last heartbeat ${r.tookOver.agoMin} min ago)` : ""}\n`);
      process.stdout.write(`${JSON.stringify(r)}\n`);
    }
    return;
  }
  if (cmd === "home") {
    if (!mainDir) fail("not inside a git repository");
    process.stdout.write(`${JSON.stringify(contractHome(mainDir))}\n`);
    return;
  }
  if (cmd === "profiles") {
    if (arg === "--list") {
      for (const [s, spec] of Object.entries(PROFILE_SECTIONS)) process.stdout.write(`.claude/sapu/${s}.md${spec.optional ? " (optional)" : ""}: ${spec.sections.map((h) => `## ${h}`).join(" | ")}\n`);
      return;
    }
    if (!here) fail("not inside a git repository");
    for (const w of profileWarnings(here, { rev: workingTree ? null : "HEAD" })) process.stderr.write(`sapu-contract: WARNING ${w}\n`);
    const probs = profileProblems(here, undefined, { rev: workingTree ? null : "HEAD" });
    const lines = Object.entries(probs).map(([s, m]) => `.claude/sapu/${s}.md: ${m.join(", ")}`);
    if (lines.length) fail(`profile sections missing:\n  - ${lines.join("\n  - ")}`);
    process.stdout.write("profiles OK\n");
    return;
  }
  const { contract, error } = loadContract(here, { workingTree, ref: ref ?? "HEAD" });
  if (error) fail(error);
  // Every gh call below (and in its children) goes to the contract's GitHub host.
  if (hostOf(contract) !== DEFAULT_HOST) process.env.GH_HOST = hostOf(contract);
  if (cmd === "show" || cmd === "check") {
    const warning = gateProtectionWarning(contract, (f) => fileAt(here, workingTree ? null : (ref ?? "HEAD"), f));
    if (warning) process.stderr.write(`sapu-contract: WARNING ${warning}\n`);
  }
  if (cmd === "check") {
    const problems = lockProblems(mainDir, contract, machineOrFail());
    if (problems.length) fail(`refusing to run here:\n  - ${problems.join("\n  - ")}`);
    // the default specialists come from senior-dev-team: say so before a wave dispatches nothing
    const defaults = Object.entries(resolveSpecialists(contract)).filter(([, a]) => a.startsWith("senior-dev-team:")).map(([r]) => r);
    if (defaults.length && seniorDevTeamInstalled() === false) {
      process.stderr.write(`sapu-contract: WARNING the senior-dev-team plugin is not installed or not enabled, but the roles ${defaults.join(", ")} use its agents: \`claude plugin install senior-dev-team@<marketplace>\` (the marketplace sapu came from), or map those roles in \`specialists\`.\n`);
    }
  }
  if (cmd === "get") {
    if (!arg) fail("get needs a dotted path, e.g. gate.fast");
    const v = arg.split(".").reduce((o, k) => (o == null ? undefined : o[k]), contract);
    if (v === undefined) fail(`no value at ${arg}`);
    process.stdout.write(typeof v === "string" ? `${v}\n` : `${JSON.stringify(v)}\n`);
    return;
  }
  if (cmd === "policy") {
    process.stdout.write(`${JSON.stringify(resolvePolicy(contract))}\n`);
    return;
  }
  if (cmd === "tuning") {
    const m = machineNow();
    process.stdout.write(`${JSON.stringify({ ...resolveTuning(contract), ...gateWorkers({ cpus: m.cpus, busy: safeLanes(m).busy }) })}\n`);
    return;
  }
  if (cmd === "pr-reviews") {
    if (!/^[1-9]\d*$/.test(arg ?? "")) fail("usage: sapu-contract.mjs pr-reviews <N>");
    try {
      process.stdout.write(`${JSON.stringify(prReviews(contract, Number(arg)), null, 2)}\n`);
    } catch (e) {
      fail(`cannot read the reviews of PR #${arg} (${e.message}): fix nothing on unread reviews`);
    }
    return;
  }
  if (cmd === "allowed") {
    if (!SKILLS.includes(arg)) fail(`allowed needs a skill name: ${SKILLS.join(", ")}`);
    if (!resolvePolicy(contract).skills.includes(arg)) fail(`${arg} is not allowed in this repo (policy.skills: ${resolvePolicy(contract).skills.join(", ")}); /sapu:init changes it`);
    process.stdout.write(`${arg} allowed\n`);
    return;
  }
  if (cmd === "wave-args") {
    // A lane on infrastructure that is down only burns a worker (it waited 18 min on a stopped DB):
    // the repo's own probe must pass before any lane is built.
    // `--no-infra`: a caller whose agents run no tests (the inspector) skips it.
    const infra = contract.gate && contract.gate.infra;
    if (isStr(infra) && !process.argv.includes("--no-infra")) {
      const r = spawnSync("bash", ["-c", infra], { cwd: mainDir, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
      const code = r.error && r.error.code;
      if (r.status !== 0 || code) {
        const how = code === "ETIMEDOUT" ? "timed out after 60 s" : code === "ENOENT" ? "could not run (no bash)" : code ? `failed (${code})` : `exited ${r.status}`;
        const last = (`${r.stderr || ""}`.trim() || `${r.stdout || ""}`.trim()).split("\n").pop().slice(0, 200);
        fail(`test infrastructure is down: gate.infra (${infra}) ${how}${last ? ` — ${last}` : ""}. Bring it up as the profile's Step 0 says, then build the lane again.`);
      }
    }
    const { repo, baseBranch, securityEpic, invariantDomains, testResources, redAreas, redAreaSpecialists, labels } = contract;
    const specialists = resolveSpecialists(contract);
    const out = { main: mainDir, pluginRoot: PLUGIN_ROOT, profiles: contractHome(mainDir).dir, contract: { repo, baseBranch, securityEpic, invariantDomains, testResources, redAreas, redAreaSpecialists, labels, specialists, policy: resolvePolicy(contract) } };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }
  if (cmd === "specialists") {
    process.stdout.write(`${JSON.stringify(resolveSpecialists(contract))}\n`);
    return;
  }
  if (cmd === "trusted") {
    let set;
    try {
      set = resolveTrusted(contract);
    } catch (e) {
      fail(e.message);
    }
    process.stdout.write(`${JSON.stringify(set)}\n`);
    return;
  }
  if (cmd === "issue-trust" || cmd === "pr-trust") {
    const isPr = cmd === "pr-trust";
    if (!/^[1-9]\d*$/.test(arg ?? "")) fail(`usage: sapu-contract.mjs ${cmd} <N> [--text]${isPr ? "" : " [--comments]"} [--ref <ref>]`);
    const n = Number(arg);
    // ALWAYS a JSON verdict on stdout, and the exit code says the same: a caller that pipes the
    // output still sees the refusal in the JSON, and one that branches on the exit code sees it there.
    let v;
    try {
      const trusted = resolveTrusted(contract);
      if (isPr) {
        v = prTrust(contract, n, trusted);
        if (v.trusted && !withText) {
          delete v.title;
          delete v.body;
        }
      } else {
        const r = issueTrust(contract, n, trusted);
        const s = r.snapshot;
        v = { trusted: r.trusted, number: n, kind: s.kind, author: s.author, reason: r.reason, acceptedBy: r.acceptedBy, lastEditedAt: s.lastEditedAt, editor: s.editor };
        if (r.trusted && withText) Object.assign(v, { title: s.title, body: s.body });
        if (r.trusted && withComments) {
          const cm = trustedComments(contract, n, trusted);
          Object.assign(v, { comments: cm.comments, withheldComments: cm.withheld });
        }
      }
    } catch (e) {
      // Fail closed: an answer GitHub did not give is not a yes.
      const reason = `cannot read ${isPr ? "PR" : "issue"} #${n} from GitHub (${e.message}): its trust is unknown, so it is refused`;
      v = isPr ? { trusted: false, pr: n, author: null, rule: "unreadable", reason } : { trusted: false, number: n, reason };
    }
    process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
    if (v.trusted !== true) {
      process.stderr.write(`sapu-contract: ${isPr ? "PR" : "issue"} #${n} untrusted: ${v.reason}\n`);
      process.exit(1);
    }
    return;
  }
  process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`);
}

/** True when this file is the process's entry point, however it was reached (symlink, relative path). */
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main(process.argv.slice(2));
