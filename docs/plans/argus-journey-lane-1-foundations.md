# Argus journey lane — Phase 1: Foundations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the contract, guard and merge-gate changes the journey lane depends on, before any
of the lane itself exists.

**Architecture:** Three existing scripts change. `sapu-contract.mjs` learns the `journey` skill and
the `labels.needsOwner` label. `sapu-guard.mjs` protects that label as it protects the acceptance
label, and confines the future `sapu:ui-explorer` agent through two pure, exported functions wired
into `decide()`. `sapu-merge.sh` marks a gate run that overlapped a journey cycle (from
`<MAIN>/.git/sapu-live.log`, which phase 2 writes) with ` live=1` and keeps such runs out of flake
proofs.

**Tech Stack:** Node ESM (`.mjs`, no dependencies), Bash, vitest (`npx vitest run`).

Spec: [docs/specs/argus-journey-lane.md](../specs/argus-journey-lane.md) §4, §8, §10, §11.
Roadmap: [argus-journey-lane-roadmap.md](argus-journey-lane-roadmap.md).

---

## File structure

| File | Change |
|---|---|
| `plugins/sapu/scripts/sapu-contract.mjs` | `journey` in `SKILLS`; `DEFAULT_NEEDS_OWNER_LABEL`, `needsOwnerLabel()`; `labels.needsOwner` validation |
| `plugins/sapu/scripts/sapu-guard.mjs` | `ownerLabels` (accepted + needs-owner) replacing the single acceptance label; `EXPLORER_AGENT`, `WRAPPER`, `checkExplorerBash()`, `checkExplorerRead()`, their wiring in `decide()`; three new block reasons |
| `plugins/sapu/scripts/sapu-merge.sh` | gate wall-clock start and end; `live_overlap`; ` live=1` on the gates-log line; the flake-proof awk skips `live=1` lines |
| `tests/sapu-contract.test.ts` | new describe: journey lane contract fields |
| `tests/sapu-guard.test.ts` | new describes: needs-owner label; explorer Bash; explorer reads |
| `tests/sapu-merge.test.ts` | new describe: gates beside a journey cycle |

Before starting: `git switch -c feat/argus-journey-lane` from `main`, and run `npx vitest run` once to
confirm a green baseline.

---

### Task 1: `journey` skill and `labels.needsOwner` in the contract

**Files:**
- Modify: `plugins/sapu/scripts/sapu-contract.mjs` (`SKILLS`, after `acceptedLabel`, the `labels` validation block)
- Test: `tests/sapu-contract.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/sapu-contract.test.ts`, add `SKILLS`, `DEFAULT_NEEDS_OWNER_LABEL` and `needsOwnerLabel` to
the existing import list from `../plugins/sapu/scripts/sapu-contract.mjs`, then append:

```ts
describe("journey lane — the contract fields (2.9.0)", () => {
  it("journey is a skill a policy can allow, and `allowed journey` follows the policy", () => {
    expect(SKILLS).toContain("journey");
    expect(validate({ ...clone(), policy: { skills: ["argus", "journey"] } })).toEqual([]);
    const repo = join(root, "policy-journey");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    commit(repo, { ".claude/sapu.json": JSON.stringify({ ...FIXTURE_CONTRACT, policy: { skills: ["argus"] } }) });
    const no = cli(repo, ["allowed", "journey"]);
    expect(no.status).toBe(1);
    expect(no.err).toMatch(/journey is not allowed in this repo/);
  });

  it("labels.needsOwner is optional; absent, the label is argus:needs-owner", () => {
    expect(DEFAULT_NEEDS_OWNER_LABEL).toBe("argus:needs-owner");
    expect(needsOwnerLabel(FIXTURE_CONTRACT)).toBe("argus:needs-owner");
    const c = clone();
    c.labels.needsOwner = "owner:decide";
    expect(validate(c)).toEqual([]);
    expect(needsOwnerLabel(c)).toBe("owner:decide");
  });

  it.each([
    ["an empty label", ""],
    ["a blank label", "  "],
    ["a number", 3],
    ["null", null],
  ])("refuses labels.needsOwner as %s", (_what, v) => {
    const c = clone();
    c.labels.needsOwner = v;
    expect(validate(c).join("\n")).toMatch(/labels\.needsOwner must be a non-empty label name/);
  });

  it("refuses a needs-owner label equal to the acceptance label, whatever the case", () => {
    const c = clone();
    c.labels.needsOwner = "Sapu:Accepted";
    expect(validate(c).join("\n")).toMatch(/labels\.needsOwner must differ from the acceptance label/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/sapu-contract.test.ts -t "journey lane"`
Expected: FAIL — `SKILLS` lacks `journey`; `needsOwnerLabel` is not exported.

- [ ] **Step 3: Implement**

In `plugins/sapu/scripts/sapu-contract.mjs`:

```js
/** The skills a policy can allow (`policy.skills`). */
export const SKILLS = ["sapu", "forge", "argus", "journey", "momus", "nemesis", "inspector", "dream"];
```

Directly below the existing `export const acceptedLabel = …` line:

```js
/** The label marking a finding only the owner can rule on (argus journey lane); sapu skips it in B2. */
export const DEFAULT_NEEDS_OWNER_LABEL = "argus:needs-owner";
export const needsOwnerLabel = (c) => (c && c.labels && isStr(c.labels.needsOwner) ? c.labels.needsOwner : DEFAULT_NEEDS_OWNER_LABEL);
```

In the `labels` validation block, replace the `keys(...)` line and add two checks after the
`accepted` check:

```js
    keys(c.labels, "labels", ["tierPrefix", "inProgress", "done"], ["accepted", "acceptors", "needsOwner"]);
```

```js
    if ("needsOwner" in c.labels) need(isStr(c.labels.needsOwner), `labels.needsOwner must be a non-empty label name (omit it for ${DEFAULT_NEEDS_OWNER_LABEL})`);
    need(needsOwnerLabel(c).toLowerCase() !== acceptedLabel(c).toLowerCase(), "labels.needsOwner must differ from the acceptance label");
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/sapu-contract.test.ts`
Expected: PASS, the whole file (the existing `policy.skills` messages now list `journey` too).

- [ ] **Step 5: Commit**

```bash
git add plugins/sapu/scripts/sapu-contract.mjs tests/sapu-contract.test.ts
git commit -m "feat(sapu): journey skill and labels.needsOwner in the contract"
```

---

### Task 2: the guard protects the needs-owner label as it protects the acceptance label

**Files:**
- Modify: `plugins/sapu/scripts/sapu-guard.mjs` (import, `compileRules` return, `namesLabel`, `BLOCK.acceptLabel` text, the two `rules.acceptLabel` uses)
- Test: `tests/sapu-guard.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/sapu-guard.test.ts`:

```ts
describe("sapu-guard — the needs-owner label is the owner's, like the acceptance label", () => {
  const reviewer = (command: string, r = rules) => check({ command, cwd: wt, main, rules: r, worker: false });
  it.each([
    ["gh issue edit 8 --add-label argus:needs-owner"],
    ["gh issue edit 8 --remove-label=argus:needs-owner"],
    ['gh issue edit 8 --remove-label "bug,Argus:Needs-Owner"'],
    ["gh pr edit 8 --add-label argus:needs-owner"],
    ["gh label create argus:needs-owner"],
    ["gh label delete argus:needs-owner --yes"],
    ["gh api -X DELETE repos/o/r/issues/8/labels/argus%3Aneeds-owner"],
    ['gh api -X POST repos/o/r/issues/8/labels -f "labels[]=argus:needs-owner"'],
  ])("refuses %s for every subagent", (cmd) => {
    expect(reviewer(cmd)).toMatch(/needs-owner label/);
    expect(blocked(cmd)).toMatch(/needs-owner label/);
  });

  it("lets a non-worker subagent file an issue carrying it", () => {
    expect(reviewer("gh issue create --title t --body b --label argus:needs-owner")).toBeNull();
  });

  it("follows labels.needsOwner, and still protects the acceptance label", () => {
    const custom = compileRules({ ...FIXTURE_CONTRACT, labels: { ...FIXTURE_CONTRACT.labels, needsOwner: "owner:decide" } });
    expect(reviewer("gh issue edit 8 --remove-label owner:decide", custom)).toMatch(/needs-owner label/);
    expect(reviewer("gh issue edit 8 --add-label sapu:accepted", custom)).toMatch(/acceptance label/);
    expect(reviewer("gh issue edit 8 --add-label argus:needs-owner", custom)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/sapu-guard.test.ts -t "needs-owner label"`
Expected: FAIL — the commands are allowed today.

- [ ] **Step 3: Implement**

In `plugins/sapu/scripts/sapu-guard.mjs`:

Import the new helper:

```js
import { acceptedLabel, checkoutRoot, findMain, loadContract, needsOwnerLabel } from "./sapu-contract.mjs";
```

In `compileRules`, replace the `acceptLabel:` entry and its comment with:

```js
    // The labels only the owner applies (compared without case, as GitHub does): the one accepting an
    // outsider's issue, and the one marking a finding only the owner can rule on.
    ownerLabels: [acceptedLabel(contract), needsOwnerLabel(contract)].map((l) => l.toLowerCase()),
```

Replace `namesLabel`:

```js
/** The words of `v` a label name could be (URL-decoded, lower case): does one of them name one of `labels`? */
const namesLabel = (v, labels) => {
  let s = v;
  try {
    s = decodeURIComponent(v);
  } catch {
    /* not URL-encoded */
  }
  const words = s.toLowerCase().split(/[\s,="'/[\]{}()]+/);
  return [].concat(labels).some((l) => words.includes(l));
};
```

Replace `const L = rules.acceptLabel;` with `const L = rules.ownerLabels;`, and in the MCP-tool
check replace `namesLabel(x, rules.acceptLabel)` with `namesLabel(x, rules.ownerLabels)`.

Replace the `acceptLabel:` text in `BLOCK`:

```js
  acceptLabel:
    "the acceptance label and the needs-owner label are the owner's own acts: no agent applies, removes, creates, renames, deletes or clones them — every agent works under the owner's token, so GitHub would record the change as the owner's decision. Report the issue instead.",
```

Then search the file and the tests for any other `acceptLabel` property read
(`grep -n "rules.acceptLabel\|\.acceptLabel" plugins/sapu/scripts/sapu-guard.mjs tests/*.ts`) and
switch it to `ownerLabels`; `BLOCK.acceptLabel` keeps its name.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/sapu-guard.test.ts`
Expected: PASS, the whole file (the existing acceptance-label cases still match `/acceptance label/`).

- [ ] **Step 5: Commit**

```bash
git add plugins/sapu/scripts/sapu-guard.mjs tests/sapu-guard.test.ts
git commit -m "feat(sapu): the guard protects the needs-owner label like the acceptance label"
```

---

### Task 3: the explorer's Bash runs only its wrapper

**Files:**
- Modify: `plugins/sapu/scripts/sapu-guard.mjs` (new exports near `SAPU_AGENT`; `BLOCK`; `decide()`)
- Test: `tests/sapu-guard.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `checkExplorerBash`, `EXPLORER_AGENT` and `WRAPPER` to the import from
`../plugins/sapu/scripts/sapu-guard.mjs` in `tests/sapu-guard.test.ts`, then append:

```ts
describe("sapu-guard — the journey explorer's Bash runs only its wrapper", () => {
  const W = "/plug/scripts/argus-live.mjs";
  const bash = (command: string) => (checkExplorerBash as (c: string, w?: string) => string | null)(command, W);

  it("knows its agent and its wrapper", () => {
    expect(EXPLORER_AGENT.test("sapu:ui-explorer")).toBe(true);
    expect(EXPLORER_AGENT.test("sapu:sapu-opus-high")).toBe(false);
    expect(WRAPPER).toMatch(/plugins\/sapu\/scripts\/argus-live\.mjs$/);
  });

  it.each([
    [`node ${W} pw tk1 customer snapshot`],
    [`node ${W} pw tk1 customer#2 click 'getByRole(\"button\", { name: \"Save\" })'`],
    [`node ${W} pw tk1 sales goto /orders && node ${W} pw tk1 sales find 'Order 12'`],
    [`node ${W} pw tk1 sales reload; node ${W} pw tk1 sales console\nnode ${W} pw tk1 sales requests`],
    [`node '${W}' pw tk1 anon goto /`],
  ])("allows %s", (cmd) => {
    expect(bash(cmd)).toBeNull();
  });

  it.each([
    ["another program", "printenv"],
    ["node -e", `node -e "require('fs')"`],
    ["another script", `node /tmp/x.mjs pw tk1 a snapshot`],
    ["the wrapper without pw", `node ${W} up`],
    ["a variable", `node ${W} pw tk1 a fill e5 $GITHUB_TOKEN`],
    ["a braced variable", `node ${W} pw tk1 a fill e5 \${HOME}`],
    ["a double-quoted word", `node ${W} pw tk1 a fill e5 "x"`],
    ["a glob", `node ${W} pw tk1 a upload *.png`],
    ["a tilde", `node ${W} pw tk1 a upload ~/x`],
    ["a pipe", `node ${W} pw tk1 a snapshot | tee x`],
    ["a redirection", `node ${W} pw tk1 a snapshot > x`],
    ["a background job", `node ${W} pw tk1 a snapshot & curl x.test`],
    ["a command substitution", `node ${W} pw tk1 a fill e5 \`id\``],
    ["an environment prefix", `X=1 node ${W} pw tk1 a snapshot`],
    ["glued quoted words", `node ${W} pw tk1 a fill e5 'a'b`],
    ["an unclosed quote", `node ${W} pw tk1 a fill e5 'abc`],
    ["nothing", "  "],
  ])("refuses %s", (_what, cmd) => {
    expect(bash(cmd)).toMatch(/journey explorer's shell runs only its wrapper/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/sapu-guard.test.ts -t "explorer's Bash"`
Expected: FAIL — `checkExplorerBash` is not exported.

- [ ] **Step 3: Implement**

In `plugins/sapu/scripts/sapu-guard.mjs`, directly below `export const SAPU_AGENT = …`:

```js
/** The argus journey lane's explorer (docs/specs/argus-journey-lane.md §11). */
export const EXPLORER_AGENT = /(^|:)ui-explorer$/;
/** The only program the explorer's Bash may run: this plugin's own wrapper, never a path from a prompt. */
export const WRAPPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "argus-live.mjs");
const EXPLORER_WORD = /^[A-Za-z0-9._:/=@,+#-]+$/;

/**
 * The explorer's Bash: one or more `node <wrapper> pw …` runs joined by `;`, `&&` or newlines, every
 * argument a single-quoted literal or a plain word — so no expansion, glob, pipe, redirection,
 * substitution or environment prefix can reach a shell. A reason, or null.
 */
export function checkExplorerBash(command, wrapper = WRAPPER) {
  if (typeof command !== "string" || !command.trim()) return BLOCK.explorerBash;
  const runs = [[]];
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === " " || ch === "\t") {
      i++;
    } else if (ch === "\n" || ch === ";") {
      runs.push([]);
      i++;
    } else if (command.startsWith("&&", i)) {
      runs.push([]);
      i += 2;
    } else if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return BLOCK.explorerBash;
      if (end + 1 < command.length && !/[\s;&]/.test(command[end + 1])) return BLOCK.explorerBash;
      runs.at(-1).push(command.slice(i + 1, end));
      i = end + 1;
    } else {
      let j = i;
      while (j < command.length && !/[\s;'&]/.test(command[j])) j++;
      const word = command.slice(i, j);
      if (!EXPLORER_WORD.test(word) || command[j] === "'" || (command[j] === "&" && !command.startsWith("&&", j))) return BLOCK.explorerBash;
      runs.at(-1).push(word);
      i = j;
    }
  }
  const real = runs.filter((r) => r.length);
  if (!real.length || real.some((r) => r[0] !== "node" || r[1] !== wrapper || r[2] !== "pw")) return BLOCK.explorerBash;
  return null;
}
```

Add to `BLOCK`:

```js
  explorerBash:
    "the journey explorer's shell runs only its wrapper: `node <plugin>/scripts/argus-live.mjs pw …`, joined by `;`, `&&` or newlines, every argument a single-quoted literal or a plain word (no $, double quotes, globs, ~, pipes, redirections, substitutions or environment prefixes).",
  explorerTool: "the journey explorer has only Bash (its wrapper), Read, Grep and Glob.",
```

In `decide()`, directly after `const ti = input.tool_input || {};`, add (the read check arrives in
Task 4; until then every non-Bash tool of the explorer is refused):

```js
  if (EXPLORER_AGENT.test(input.agent_type || "")) {
    const why = tool === "Bash" ? checkExplorerBash(ti.command) : BLOCK.explorerTool;
    if (why) return why;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/sapu-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/sapu/scripts/sapu-guard.mjs tests/sapu-guard.test.ts
git commit -m "feat(sapu): the journey explorer's Bash runs only its wrapper"
```

---

### Task 4: the explorer reads only tracked files of the run's worktree

**Files:**
- Modify: `plugins/sapu/scripts/sapu-guard.mjs` (new export below `checkExplorerBash`; `BLOCK`; the explorer branch in `decide()`)
- Test: `tests/sapu-guard.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `checkExplorerRead` to the import, then append:

```ts
describe("sapu-guard — the journey explorer reads only tracked files of the run's worktree", () => {
  const w = realpathSync(mkdtempSync(join(tmpdir(), "explorer-wt-")));
  const g = (...a: string[]) => execFileSync("git", ["-C", w, "-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { stdio: "ignore" });
  g("init", "-q");
  mkdirSync(join(w, "src/orders"), { recursive: true });
  mkdirSync(join(w, ".argus"), { recursive: true });
  writeFileSync(join(w, "src/orders/route.ts"), "export const x = 1;\n");
  writeFileSync(join(w, ".argus/config.yml"), "test_accounts: {}\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  writeFileSync(join(w, "src/orders/untracked.ts"), "secret\n");
  const outside = join(tmpdir(), "explorer-outside.txt");
  writeFileSync(outside, "x\n");
  symlinkSync(outside, join(w, "src/link.txt"));
  afterAll(() => rmSync(w, { recursive: true, force: true }));
  const read = (tool: string, input: Record<string, string>, worktree: string | null = w) =>
    (checkExplorerRead as (i: object) => string | null)({ tool, input, worktree, cwd: w });

  it("allows a tracked file, and a Grep or Glob below the worktree root", () => {
    expect(read("Read", { file_path: join(w, "src/orders/route.ts") })).toBeNull();
    expect(read("Read", { file_path: "src/orders/route.ts" })).toBeNull();
    expect(read("Grep", { pattern: "export", path: join(w, "src") })).toBeNull();
    expect(read("Glob", { pattern: "**/*.ts", path: join(w, "src/orders") })).toBeNull();
  });

  it.each([
    ["an untracked file", "Read", { file_path: join(w, "src/orders/untracked.ts") }],
    ["the tracked argus config", "Read", { file_path: join(w, ".argus/config.yml") }],
    ["a file outside the worktree", "Read", { file_path: outside }],
    ["a symlink leaving the worktree", "Read", { file_path: join(w, "src/link.txt") }],
    ["a missing file", "Read", { file_path: join(w, "src/none.ts") }],
    ["a Grep of the worktree root (it holds .argus/)", "Grep", { pattern: "x", path: w }],
    ["a Grep with no path", "Grep", { pattern: "x" }],
    ["a Grep of .argus/", "Grep", { pattern: "x", path: join(w, ".argus") }],
    ["a Glob climbing out", "Glob", { pattern: "../**", path: join(w, "src") }],
  ])("refuses %s", (_what, tool, input) => {
    expect(read(tool, input)).toMatch(/journey explorer reads only tracked files/);
  });

  it("refuses every read when no run is live", () => {
    expect(read("Read", { file_path: join(w, "src/orders/route.ts") }, null)).toMatch(/journey explorer reads only tracked files/);
  });
});
```

Make sure `realpathSync`, `mkdtempSync`, `symlinkSync`, `rmSync`, `writeFileSync`, `mkdirSync`,
`tmpdir`, `execFileSync` and `afterAll` are imported at the top of the test file (most already are).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/sapu-guard.test.ts -t "reads only tracked files"`
Expected: FAIL — `checkExplorerRead` is not exported.

- [ ] **Step 3: Implement**

Below `checkExplorerBash` in `plugins/sapu/scripts/sapu-guard.mjs`:

```js
/** The worktree of the live journey run (`<MAIN>/.argus/live/run.json`), real path, or null. */
function liveWorktree(main) {
  try {
    const w = JSON.parse(fs.readFileSync(path.join(main, ".argus/live/run.json"), "utf8")).worktree;
    return typeof w === "string" && w ? fs.realpathSync(w) : null;
  } catch {
    return null;
  }
}

/**
 * The explorer's Read, Grep and Glob: only paths whose real path lies in the run's worktree, outside
 * `.argus/`; a Read only of a file tracked at HEAD; a Grep or Glob only of a path below the worktree
 * root (the root holds `.argus/`). Page content reaches the explorer only through the wrapper.
 */
export function checkExplorerRead({ tool, input, worktree, cwd }) {
  if (!worktree) return BLOCK.explorerRead;
  const raw = tool === "Read" ? input.file_path : input.path;
  if (typeof raw !== "string" || !raw) return BLOCK.explorerRead;
  let real;
  try {
    real = fs.realpathSync(path.resolve(cwd, raw));
  } catch {
    return BLOCK.explorerRead;
  }
  const rel = path.relative(worktree, real);
  if (rel === "" && tool !== "Read") return BLOCK.explorerRead;
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel === ".argus" || rel.startsWith(`.argus${path.sep}`)) return BLOCK.explorerRead;
  if (tool === "Read" || fs.statSync(real).isFile()) {
    try {
      execFileSync("git", ["-C", worktree, "ls-files", "--error-unmatch", "--", rel], { stdio: "ignore" });
    } catch {
      return BLOCK.explorerRead;
    }
  }
  if (tool === "Glob" && typeof input.pattern === "string" && (/(^|\/)\.\.(\/|$)/.test(input.pattern) || input.pattern.startsWith("/"))) return BLOCK.explorerRead;
  return null;
}
```

Add to `BLOCK`:

```js
  explorerRead:
    "the journey explorer reads only tracked files of the run's worktree, outside .argus/, and a Grep or Glob must name a path below the worktree root; page content comes through the wrapper.",
```

Replace the explorer branch added in Task 3:

```js
  if (EXPLORER_AGENT.test(input.agent_type || "")) {
    const m = findMain(input.cwd || process.cwd());
    const why =
      tool === "Bash"
        ? checkExplorerBash(ti.command)
        : tool === "Read" || SEARCH_TOOLS.has(tool)
          ? checkExplorerRead({ tool, input: ti, worktree: m ? liveWorktree(m) : null, cwd: input.cwd || process.cwd() })
          : BLOCK.explorerTool;
    if (why) return why;
  }
```

`SEARCH_TOOLS` is declared further down the file as a `const`; `decide()` runs only after the module
has loaded, so the reference is safe.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/sapu-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/sapu/scripts/sapu-guard.mjs tests/sapu-guard.test.ts
git commit -m "feat(sapu): the journey explorer reads only tracked files of the run's worktree"
```

---

### Task 5: gates that overlapped a journey cycle are marked and never prove a flake

**Files:**
- Modify: `plugins/sapu/scripts/sapu-merge.sh` (at `GATE_START=$SECONDS`; the gates-log block; the `PROVEN` awk)
- Test: `tests/sapu-merge.test.ts`

The live log is written by phase 2 (`argus-live.mjs`), one line per event, epoch seconds:
`<run id> start <epoch> deadline <epoch>` and `<run id> end <epoch>`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/sapu-merge.test.ts`:

```ts
describe("sapu-merge.sh — a gate beside a journey cycle is marked live=1 and never proves a flake", () => {
  const gates = (h: { MAIN: string }) => readFileSync(join(h.MAIN, ".git/sapu-gates.log"), "utf8").split("\n").filter(Boolean);
  const live = (h: { MAIN: string }, ...lines: string[]) => writeFileSync(join(h.MAIN, ".git/sapu-live.log"), lines.map((l) => `${l}\n`).join(""));
  const now = () => Math.floor(Date.now() / 1000);

  it("marks a gate that ran while a journey run was open", () => {
    const h = harness();
    live(h, `r1 start ${now() - 60} deadline ${now() + 600}`);
    h.run();
    expect(gates(h).at(-1)).toMatch(/ green gate=\d+s failed=- tree=[0-9a-f]{40} live=1$/);
  });

  it("does not mark a gate after the run ended, nor after an unended run's deadline", () => {
    const h = harness();
    live(h, `r1 start ${now() - 7200} deadline ${now() - 3600}`, `r2 start ${now() - 900} deadline ${now() + 900}`, `r2 end ${now() - 300}`);
    h.run();
    expect(gates(h).at(-1)).not.toMatch(/live=1/);
  });

  it("a red-then-green proof made beside a journey cycle proves nothing", () => {
    const h = harness();
    writeFileSync(
      join(h.MAIN, ".git/sapu-gates.log"),
      [
        "2026-10-01T01:00:00Z 5 aaa red gate=400s failed=apps/a.test.ts tree=t5 verdict=unknown live=1",
        "2026-10-01T01:10:00Z 5 bbb green gate=400s failed=- tree=t5",
      ].map((l) => `${l}\n`).join(""),
    );
    const r = h.run({ HX_GATE_RC: "1", HX_GATE_OUT: " FAIL  apps/a.test.ts > t" });
    expect(r.err).toMatch(/verdict: unknown/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/sapu-merge.test.ts -t "beside a journey cycle"`
Expected: FAIL — no ` live=1` is written, and the `live=1` red still proves the flake.

- [ ] **Step 3: Implement**

In `plugins/sapu/scripts/sapu-merge.sh`, next to `GATE_START=$SECONDS`:

```bash
GATE_T0="$(date +%s)"
```

Directly after the line `TREE="$(git -C "$WT" rev-parse …)"` in the gates-log block, add:

```bash
# A gate that overlapped a journey cycle ran beside its browsers and dev servers (argus-live.mjs
# appends `<run> start <epoch> deadline <epoch>` and `<run> end <epoch>` to <MAIN>/.git/sapu-live.log;
# a run with no end line counts until its deadline). Its line says live=1, and no flake proof uses it.
LIVE_LOG="$MAIN/.git/sapu-live.log"
live_overlap() { # <gate start epoch> <gate end epoch>
  [ -f "$LIVE_LOG" ] || return 1
  awk -v s="$1" -v e="$2" '
    $2 == "start" { st[$1] = $3; dl[$1] = $5 }
    $2 == "end" { en[$1] = $3 }
    END { for (r in st) { stop = (r in en) ? en[r] : dl[r]; if (st[r] <= e && stop >= s) hit = 1 } exit !hit }' "$LIVE_LOG" 2>/dev/null
}
LIVE=""
if live_overlap "$GATE_T0" "$(date +%s)"; then LIVE=1; fi
```

Replace `gate_record`'s `printf` so the field comes last:

```bash
gate_record() { # <green|red|setup-failed> <failed tests or -> [verdict] [failed steps]
  { printf '%s %s %s %s gate=%ss failed=%s tree=%s%s%s%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PR" "$SHA" "$1" "$GATE_SECS" "$2" "$TREE" "${3:+ verdict=$3}" "${4:+ steps=${4// /_}}" "${LIVE:+ live=1}" >>"$GATES_LOG"; } 2>/dev/null \
    || say "warning: could not record the gate run in $GATES_LOG"
}
```

Update the format comment above it to end with `[ steps=<✗ summary steps>][ live=1]`.

In the `PROVEN` awk, make its first condition skip such lines:

```bash
    $0 !~ / live=1$/ && $2 != pr && $7 ~ /^tree=/ && $7 != "tree=-" {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/sapu-merge.test.ts tests/sapu-metrics.test.ts`
Expected: PASS (`sapu-metrics --gates-log` reads the fields by name, so a trailing ` live=1` changes
nothing there).

- [ ] **Step 5: Commit**

```bash
git add plugins/sapu/scripts/sapu-merge.sh tests/sapu-merge.test.ts
git commit -m "feat(sapu): gates beside a journey cycle are marked live=1 and never prove a flake"
```

---

### Task 6: the whole suite, and the contract documentation for the new fields

**Files:**
- Modify: `plugins/sapu/CONTRACT.md` (the `labels` example and text; the version-coupling paragraph; the gates-log format; the guard limits)

- [ ] **Step 1: Document**

In `plugins/sapu/CONTRACT.md`:
- in the contract example's `labels` object, add `"needsOwner": "argus:needs-owner"` with the comment
  `// optional; a finding only the owner can rule on (argus journey lane); sapu skips it`;
- in the version-coupling paragraph, add: `journey` in `policy.skills` and `labels.needsOwner` need
  plugin **≥ 2.9.0**; an older plugin rejects the contract;
- where the gates log is described, add the trailing ` live=1` field and its meaning (the gate
  overlapped a journey cycle in `<MAIN>/.git/sapu-live.log`; such a line never counts toward a flake
  proof);
- in the guard section, add the needs-owner label beside the acceptance label, and a paragraph on
  `sapu:ui-explorer`: its Bash runs only `node <plugin>/scripts/argus-live.mjs pw …` with
  single-quoted or plain-word arguments; its Read, Grep and Glob reach only tracked files of the live
  run's worktree, outside `.argus/`; it has no other tool.

- [ ] **Step 2: Run the whole suite**

Run: `npx vitest run`
Expected: PASS, every file (the English and size checks in `tests/engine.test.ts` included).

- [ ] **Step 3: Commit**

```bash
git add plugins/sapu/CONTRACT.md
git commit -m "docs(sapu): contract fields, guard limits and the live=1 gates-log field for the journey lane"
```

---

## Self-review

- Spec coverage for this phase: §4 policy (`journey` in `SKILLS`, `allowed journey`, version
  coupling) — Tasks 1, 6; §10 needs-owner label and its guard protection — Tasks 1, 2, 6; §11 the
  explorer's Bash allowlist and read limits — Tasks 3, 4, 6; §8 "beside a sapu sweep" — Task 5.
  Deferred on purpose to their phases: argus SELECT's `allowed journey` check and the inspector
  exclusion (phase 5, skill text), `/sapu:init` creating the label (phase 5), B2's SKIP of the label
  (phase 5), the writer of `sapu-live.log` (phase 2).
- Names used across tasks: `SKILLS`, `DEFAULT_NEEDS_OWNER_LABEL`, `needsOwnerLabel`,
  `rules.ownerLabels`, `EXPLORER_AGENT`, `WRAPPER`, `checkExplorerBash`, `checkExplorerRead`,
  `liveWorktree`, `BLOCK.explorerBash`, `BLOCK.explorerRead`, `BLOCK.explorerTool`, `live_overlap`,
  `LIVE`, `GATE_T0` — each defined once, in the task that introduces it.
