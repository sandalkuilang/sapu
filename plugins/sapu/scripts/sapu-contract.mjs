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
//   sapu-contract.mjs lanes       prints {lanes, ceiling, busy, cpus, ramGB, load1, memFreePct}: how many
//                                 Phase B lanes this machine carries now (safeLanes); no contract needed
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
/** The plugin's former built-in role agents (removed in 2.6.0): a contract still naming one dispatches nothing. */
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
    ["specialists", "trustedAuthors", "requireSignedCommits", "policy", "labels"],
  );
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
    if (!("needsOwner" in c.labels) || isStr(c.labels.needsOwner)) {
      const no = needsOwnerLabel(c).toLowerCase();
      need(no !== acceptedLabel(c).toLowerCase(), `labels.needsOwner must differ from the acceptance label: both are "${needsOwnerLabel(c)}"`);
      for (const k of ["inProgress", "done"]) if (isStr(c.labels[k])) need(no !== c.labels[k].toLowerCase(), `labels.needsOwner must differ from labels.${k}: both are "${needsOwnerLabel(c)}"`);
      if (isStr(c.labels.tierPrefix)) need(!no.startsWith(c.labels.tierPrefix.toLowerCase()), `labels.needsOwner must not start with labels.tierPrefix ("${c.labels.tierPrefix}"): it would read as a risk tier`);
    }
  } else if (!(noTraces && !("labels" in c))) errs.push("labels must be an object");
  need(c.securityEpic === null || (Number.isInteger(c.securityEpic) && c.securityEpic > 0), "securityEpic must be an issue number or null");
  need(isStr(c.invariantDomains), "invariantDomains must be a non-empty string");
  need(isStr(c.testResources), "testResources must be a non-empty string");
  if ("policy" in c) policyProblems(c.policy).forEach((e) => errs.push(e));
  const g = c.guard;
  if (g && typeof g === "object") {
    keys(g, "guard", ["envFiles", "postgres", "deny"]);
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

/** <MAIN> = the first `git worktree list` entry seen from `cwd`; null outside a repo. */
export function findMain(cwd) {
  try {
    const out = execFileSync("git", ["-C", cwd, "worktree", "list", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const first = out.split("\n").find((l) => l.startsWith("worktree "));
    return first ? first.slice("worktree ".length) : null;
  } catch {
    return null;
  }
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
  const nwo = nwoFromRemote(sh("git", ["-C", root, "remote", "get-url", "origin"], root));
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

/**
 * owner/name from a github.com remote URL, or null. The host is pinned: only
 * `https://[user@]github.com/o/r[.git]`, `git@github.com:o/r[.git]` and
 * `ssh://git@github.com[:port]/o/r[.git]` — never a URL that merely contains "github.com".
 */
export function nwoFromRemote(url) {
  const forms = [
    /^https:\/\/(?:[^@/\s]+@)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i,
    /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i,
    /^ssh:\/\/git@github\.com(?::\d+)?\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i,
  ];
  for (const re of forms) {
    const m = re.exec(url || "");
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
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
  if (machine.allowedRoots.length && !underAllowedRoot(main, machine.allowedRoots)) {
    p.push(`${main} is outside the allowed roots in ${machine.path} (${machine.allowedRoots.join(", ")})`);
  }
  const login = sh("gh", ["api", "user", "--jq", ".login"], main);
  if (login !== c.ghUser) p.push(`active gh account is "${login || "none"}", the contract needs "${c.ghUser}"`);
  // --local: a global email that happens to match must not pass for this repo's identity.
  const email = sh("git", ["-C", main, "config", "--local", "user.email"], main);
  if (email !== c.gitEmail) p.push(`git user.email is "${email || "unset"}", the contract needs "${c.gitEmail}"`);
  const origin = nwoFromRemote(sh("git", ["-C", main, "remote", "get-url", "origin"], main));
  if (!origin || origin.toLowerCase() !== c.repo.toLowerCase()) p.push(`origin is "${origin || "none"}", the contract says "${c.repo}"`);
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

// An issue as a PR body names it: #N, owner/repo#N, GH-N, or a github.com issue/PR URL.
const ONE_REF = String.raw`(?:https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)|(?<![\w/.-])([\w.-]+\/[\w.-]+)#(\d+)|(?<![\w&#/])#(\d+)|\bGH-(\d+))\b`;
const CLOSE_LIST = new RegExp(String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[:\s]+(${ONE_REF}(?:(?:,\s*and\s+|,\s*|\s+and\s+|\s*&\s*)${ONE_REF})*)`, "gi");
const asRef = (r) => ({ repo: r[1] || r[3] || null, number: Number(r[2] || r[4] || r[5] || r[6]) });

/**
 * Every issue or PR a PR body names, as {repo, number} (repo null = this repo): `closes` = those a
 * Closes/Fixes/Resolves list closes (relabelled after the merge), `refs` = every other mention —
 * `Refs #8`, `Implements #8`, `Part of #8`, a bare `#8`, `GH-8`, `owner/repo#8`, an issue URL. Code
 * (fenced blocks, inline spans) is skipped, as GitHub skips it when it links references.
 */
export function bodyRefs(body) {
  const text = String(body || "").replace(/```[\s\S]*?(```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
  const closes = [];
  for (const m of text.matchAll(CLOSE_LIST)) for (const r of m[1].matchAll(new RegExp(ONE_REF, "gi"))) closes.push(asRef(r));
  const key = (x) => `${lc(x.repo ?? "")}#${x.number}`;
  const closing = new Set(closes.map(key));
  const refs = [...text.matchAll(new RegExp(ONE_REF, "gi"))].map(asRef).filter((x) => !closing.has(key(x)));
  return { closes, refs };
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
 * / referenced issue (GitHub's closing references plus the body's Closes/Fixes/Resolves and Refs
 * lists, in any form: in another repository, or failing issueTrust). Throws when GitHub cannot be read.
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
  const refs = bodyRefs(pr.body);
  const gh = pr.closingIssuesReferences;
  if (gh.totalCount > gh.nodes.length) return refuse("closing issue", `it closes ${gh.totalCount} issues, more than can be checked`);
  // GitHub's own reference without a repository cannot be placed: it counts as another repository's.
  const closing = [...gh.nodes.map((x) => ({ repo: x && x.repository && typeof x.repository.nameWithOwner === "string" ? x.repository.nameWithOwner : "", number: x && x.number })), ...refs.closes];
  const outside = (list) => list.find((x) => x.repo !== null && !here(x.repo));
  const fc = outside(closing);
  if (fc) return refuse("closing issue", `it closes ${fc.repo || "an issue in a repository GitHub did not name"}#${fc.number}, outside ${c.repo}`);
  const fr = outside(refs.refs);
  if (fr) return refuse("referenced issue", `it refs ${fr.repo}#${fr.number}, outside ${c.repo}`);
  const closes = [...new Set(closing.map((x) => x.number))].filter(isId).sort((a, b) => a - b);
  const refNums = [...new Set(refs.refs.map((x) => x.number))].filter((x) => isId(x) && !closes.includes(x)).sort((a, b) => a - b);
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

function main(argv) {
  const [cmd, ...args] = argv;
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
  if (!["check", "show", "wave-args", "specialists", "trusted", "issue-trust", "pr-trust", "get", "preflight", "profiles", "lanes", "home", "policy", "allowed", "pr-reviews"].includes(cmd)) {
    fail("usage: sapu-contract.mjs check|show|wave-args|specialists|trusted|issue-trust <N> [--text] [--comments]|pr-trust <N> [--text]|get <a.b>|preflight|lanes|home|policy|allowed <skill>|pr-reviews <N>|profiles [--list] (show|profiles [--working-tree])");
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
    process.stdout.write(`${JSON.stringify({ ...safeLanes(m), ...m })}\n`);
    return;
  }
  const mainDir = findMain(process.cwd());
  const here = workingTree ? checkoutRoot(process.cwd()) : mainDir;
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
    const out = {
      main: mainDir,
      allowedRoot: machine.allowedRoots.length ? underAllowedRoot(dir, machine.allowedRoots) : null,
      machineConfig: machine.path,
      projectScopeOnly: machine.projectScopeOnly,
      origin: mainDir ? nwoFromRemote(sh("git", ["-C", dir, "remote", "get-url", "origin"], dir)) : null,
      ghLogin: sh("gh", ["api", "user", "--jq", ".login"], dir) || null,
      gitEmail: mainDir ? sh("git", ["-C", dir, "config", "user.email"], dir) || null : null,
      userScopeInstall: userScopeInstall(),
      seniorDevTeam: seniorDevTeamInstalled(),
      hasContract: mainDir ? fs.existsSync(path.join(mainDir, CONTRACT_PATH)) : false,
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
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
    const probs = profileProblems(here, undefined, { rev: workingTree ? null : "HEAD" });
    const lines = Object.entries(probs).map(([s, m]) => `.claude/sapu/${s}.md: ${m.join(", ")}`);
    if (lines.length) fail(`profile sections missing:\n  - ${lines.join("\n  - ")}`);
    process.stdout.write("profiles OK\n");
    return;
  }
  const { contract, error } = loadContract(here, { workingTree, ref: ref ?? "HEAD" });
  if (error) fail(error);
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
