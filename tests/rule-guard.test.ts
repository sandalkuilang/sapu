// tests/rule-guard.test.ts — scripts/rule-guard.ts under test, end to end against a throwaway git
// repo (a diff-and-trailer check is only trustworthy if it is exercised through real `git diff` /
// `git log`). The core cases: removing a rule with no trailer -> RED; the same with a
// `Rule-Change:` trailer -> GREEN; only ADDING a rule -> GREEN. Plus the guarded enforcement
// (agent frontmatter, the files that enforce the rules, context budgets, the guard's own wiring)
// and the false-positive guards (whole words only, clause identity instead of lines, non-rule
// files ignored).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ENFORCEMENT_FILES,
  evaluateRuleGuard,
  findChangedAgentFrontmatter,
  findLostNormativeClauses,
  findLoosenedBudgets,
  findUnwiredGuard,
  gateSteps,
  isNormative,
  parseBudgetLimits,
  parseRuleChangeReasons,
  resolveBase,
  segmentText,
  splitClauses,
} from "../scripts/rule-guard";

let repo: string;

const git = (...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args],
    { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

function put(path: string, body: string) {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

function commit(message: string) {
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

const RULEBOOK = "plugins/sapu/CONTRACT.md";
const SKILL = "plugins/sapu/skills/x/SKILL.md";
const HOOKS = "plugins/sapu/hooks/hooks.json";
const ENGINE = "tests/engine.test.ts";

const RULES = "# Rules\n\nMoney is bigint. Never use float.\nPartner id wajib dari sesi.\nStyle is a matter of taste.\n";

const BUDGET = (sapu: number, skillDefault = 50_000, agent = 1_500) =>
  `describe("context budgets", () => {\n  const BUDGETS: Record<string, number> = {\n    "skills/sapu/SKILL.md": ${sapu},\n    "skills/forge/SKILL.md": 15_000,\n  };\n  const SKILL_DEFAULT = ${skillDefault};\n  const AGENT_LIMIT = ${agent};\n  expect(size).toBeLessThanOrEqual(limit);\n});\n`;

const HOOKS_JSON =
  '{\n  "hooks": {\n    "PreToolUse": [\n      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node \\"${CLAUDE_PLUGIN_ROOT}/scripts/sapu-guard.mjs\\"" }] }\n    ]\n  }\n}\n';

const GATE = "claude plugin validate plugins/sapu && node scripts/rule-guard.ts && vitest run";
const PKG = (gate = GATE) => JSON.stringify({ name: "x", scripts: { test: "vitest run", gate } }, null, 2) + "\n";

/** Base content of every file that enforces the rules (any edit of one needs a trailer). */
const ENFORCERS: Record<string, string> = {
  [HOOKS]: HOOKS_JSON,
  [ENGINE]: BUDGET(35_000),
  "scripts/rule-guard.ts": "// the guard\n",
  "tests/rule-guard.test.ts": "// the guard's tests\n",
  "plugins/sapu/scripts/sapu-guard.mjs": "// the Bash guard\n",
  "plugins/sapu/scripts/sapu-merge.sh": "#!/usr/bin/env bash\n",
  "plugins/sapu/scripts/sapu-contract.mjs": "// the contract loader\n",
  "plugins/sapu/workflows/sapu-wave.js": "// the wave\n",
  "plugins/sapu/workflows/inspector.js": "// the sequencer\n",
};
const changed = (file: string) => `${file}: changed (${ENFORCEMENT_FILES[file]})`;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "rule-guard-"));
  git("init", "-q", "-b", "main");
  put(RULEBOOK, RULES);
  put(SKILL, "Always run the gate.\nMust not skip tests.\n");
  put("README.md", "# sapu\n\nPlugin ini **tidak boleh** dipasang dengan scope user.\n");
  for (const [file, body] of Object.entries(ENFORCERS)) put(file, body);
  put("package.json", PKG());
  put("plugins/sapu/scripts/notes.md", "Never do this in code.\n");
  put("docs/notes.md", "Never do this either.\n");
  commit("base");
  git("branch", "base");
  git("switch", "-q", "-c", "work");
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("evaluateRuleGuard", () => {
  it("RED: a lost 'never' clause with no trailer, and it names the file and the line", () => {
    put(RULEBOOK, RULES.replace(" Never use float.", ""));
    commit("trim");
    const r = evaluateRuleGuard(repo, "base");
    expect(r.ok).toBe(false);
    expect(r.touched).toEqual([{ file: RULEBOOK, line: 3, text: "Never use float" }]);
  });

  it("RED: a lost 'jangan' clause", () => {
    put(RULEBOOK, RULES + "\n- Jangan merge PR merah.\n");
    commit("add");
    git("branch", "-f", "base");
    put(RULEBOOK, RULES);
    commit("drop the jangan rule");
    const r = evaluateRuleGuard(repo, "base");
    expect(r.ok).toBe(false);
    expect(r.touched.map((t) => t.text)).toEqual(["Jangan merge PR merah"]);
  });

  it("RED: a rule rewritten in place (old half of the edit) is caught, wajib -> anjuran", () => {
    put(RULEBOOK, RULES.replace("wajib", "dianjurkan"));
    commit("soften");
    const r = evaluateRuleGuard(repo, "base");
    expect(r.ok).toBe(false);
    expect(r.touched.map((t) => t.text)).toEqual(["Partner id wajib dari sesi"]);
  });

  it("GREEN: the same removal with a Rule-Change trailer on a commit in the range", () => {
    put(RULEBOOK, RULES.replace(" Never use float.", ""));
    commit("trim float rule\n\nRule-Change: superseded by the lint rule no-float-money");
    const r = evaluateRuleGuard(repo, "base");
    expect(r.ok).toBe(true);
    expect(r.touched).toHaveLength(1); // still reported, just acknowledged
    expect(r.reasons).toEqual(["superseded by the lint rule no-float-money"]);
  });

  it("GREEN: the trailer may sit on an EMPTY commit anywhere in the range", () => {
    put(RULEBOOK, RULES.replace(" Never use float.", ""));
    commit("trim");
    git("commit", "-q", "--allow-empty", "-m", "ack\n\nRule-Change: the float rule moved into the repo profile");
    expect(evaluateRuleGuard(repo, "base").ok).toBe(true);
  });

  it("RED: an EMPTY Rule-Change trailer does not count", () => {
    put(RULEBOOK, RULES.replace(" Never use float.", ""));
    commit("trim\n\nRule-Change:");
    expect(evaluateRuleGuard(repo, "base").ok).toBe(false);
  });

  it("RED: a trailer shorter than 20 characters is a rubber stamp, not a reason", () => {
    put(RULEBOOK, RULES.replace(" Never use float.", ""));
    commit("trim\n\nRule-Change: cleanup");
    const r = evaluateRuleGuard(repo, "base");
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it("GREEN: only adding new rules (and non-normative edits) is fine", () => {
    put(RULEBOOK, RULES.replace("taste", "preference") + "New: jangan simpan secret di log.\n");
    commit("add a rule");
    const r = evaluateRuleGuard(repo, "base");
    expect(r.ok).toBe(true);
    expect(r.touched).toEqual([]);
  });

  it("GREEN: a new rule file added is fine", () => {
    put("plugins/sapu/skills/y/SKILL.md", "Never merge a red PR.\n");
    commit("new skill");
    expect(evaluateRuleGuard(repo, "base").ok).toBe(true);
  });

  it("RED: deleting a whole skill file that held rules", () => {
    rmSync(join(repo, SKILL));
    commit("drop skill");
    const r = evaluateRuleGuard(repo, "base");
    expect(r.ok).toBe(false);
    expect(r.touched.map((t) => t.text)).toEqual(["Always run the gate", "Must not skip tests"]);
  });

  it("RED: the root README.md is a rule file too", () => {
    put("README.md", "# sapu\n\nPlugin ini dipasang dengan scope apa saja.\n");
    commit("relax");
    expect(evaluateRuleGuard(repo, "base").touched.map((t) => `${t.file} ${t.text}`)).toEqual([
      "README.md Plugin ini tidak boleh dipasang dengan scope user",
    ]);
  });

  it("GREEN: files outside README.md / CONTRACT.md / skills / agents are not watched", () => {
    put("plugins/sapu/scripts/notes.md", "Relaxed.\n");
    put("docs/notes.md", "Relaxed.\n");
    commit("edit unrelated docs");
    expect(evaluateRuleGuard(repo, "base").ok).toBe(true);
  });

  it("fails loudly (not silently green) when the base ref does not exist", () => {
    expect(() => evaluateRuleGuard(repo, "no-such-ref")).toThrow(/not a commit/);
  });

  it("reads old text at the merge base: a rule main added after the branch was cut is not blamed on the branch", () => {
    git("switch", "-q", "main");
    put(RULEBOOK, RULES + "Never deploy on a Friday.\n");
    commit("main gains a rule");
    git("switch", "-q", "work");
    put(RULEBOOK, RULES + "A plain note.\n"); // the branch touches the same file, without that rule
    commit("unrelated note");
    const r = evaluateRuleGuard(repo, "main");
    expect(r.touched).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("context budgets in tests/engine.test.ts", () => {
  it("RED: raising a BUDGETS entry without a trailer; GREEN with one", () => {
    put(ENGINE, BUDGET(40_000));
    commit("bump budget");
    const red = evaluateRuleGuard(repo, "base");
    expect(red.ok).toBe(false);
    expect(red.loosened).toEqual([
      changed(ENGINE),
      "tests/engine.test.ts: budget BUDGETS[skills/sapu/SKILL.md] raised 35000 -> 40000",
    ]);

    git("commit", "-q", "--allow-empty", "-m", "explain\n\nRule-Change: the sapu skill gained the wave workflow section");
    expect(evaluateRuleGuard(repo, "base").ok).toBe(true);
  });

  it("RED: raising SKILL_DEFAULT or AGENT_LIMIT", () => {
    put(ENGINE, BUDGET(35_000, 60_000, 2_000));
    commit("bump defaults");
    expect(evaluateRuleGuard(repo, "base").loosened).toEqual([
      changed(ENGINE),
      "tests/engine.test.ts: budget SKILL_DEFAULT raised 50000 -> 60000",
      "tests/engine.test.ts: budget AGENT_LIMIT raised 1500 -> 2000",
    ]);
  });

  it("RED: a budget that vanished, or the whole test file deleted", () => {
    put(ENGINE, BUDGET(35_000).replace('    "skills/forge/SKILL.md": 15_000,\n', ""));
    commit("drop a budget");
    expect(evaluateRuleGuard(repo, "base").loosened).toEqual([
      changed(ENGINE),
      "tests/engine.test.ts: budget BUDGETS[skills/forge/SKILL.md] was removed (was 15000)",
    ]);
    rmSync(join(repo, ENGINE));
    commit("drop the file");
    expect(evaluateRuleGuard(repo, "base").loosened).toEqual(["tests/engine.test.ts: deleted"]);
  });

  it("lowering or adding a budget is no budget loosening; the edit of engine.test.ts itself still needs a trailer", () => {
    put(ENGINE, BUDGET(30_000, 45_000, 1_200).replace("  };", '    "skills/argus/SKILL.md": 20_000,\n  };'));
    commit("tighten");
    expect(findLoosenedBudgets(BUDGET(35_000), BUDGET(30_000, 45_000, 1_200))).toEqual([]);
    const r = evaluateRuleGuard(repo, "base");
    expect(r.ok).toBe(false);
    expect(r.loosened).toEqual([changed(ENGINE)]);
  });

  it("parseBudgetLimits reads only the BUDGETS literal and the two defaults", () => {
    const src = BUDGET(35_000) + 'const OTHER = { "not/a/budget.md": 999_999 };\n';
    expect(parseBudgetLimits(src)).toEqual(
      new Map([
        ["BUDGETS[skills/sapu/SKILL.md]", 35_000],
        ["BUDGETS[skills/forge/SKILL.md]", 15_000],
        ["SKILL_DEFAULT", 50_000],
        ["AGENT_LIMIT", 1_500],
      ]),
    );
    expect(findLoosenedBudgets(BUDGET(1), BUDGET(1))).toEqual([]);
  });
});

describe("the hook config and the guard's own wiring", () => {
  it("RED: plugins/sapu/hooks/hooks.json changed at all; GREEN with a trailer", () => {
    put(HOOKS, HOOKS_JSON.replace('"Bash"', '"Bash|Edit"'));
    commit("widen the hook");
    const red = evaluateRuleGuard(repo, "base");
    expect(red.ok).toBe(false);
    expect(red.loosened).toEqual(["plugins/sapu/hooks/hooks.json: changed (it wires the plugin's guard hook)"]);

    git("commit", "-q", "--allow-empty", "-m", "explain\n\nRule-Change: the guard now also inspects Edit calls");
    expect(evaluateRuleGuard(repo, "base").ok).toBe(true);
  });

  it("RED: hooks.json deleted", () => {
    rmSync(join(repo, HOOKS));
    commit("drop hooks");
    expect(evaluateRuleGuard(repo, "base").loosened).toEqual(["plugins/sapu/hooks/hooks.json: deleted"]);
  });

  it("RED: the rule-guard script deleted", () => {
    rmSync(join(repo, "scripts/rule-guard.ts"));
    commit("delete guard");
    const r = evaluateRuleGuard(repo, "base");
    expect(r.ok).toBe(false);
    expect(r.loosened).toEqual(["scripts/rule-guard.ts: deleted"]);
  });

  it("RED: the gate no longer runs the guard; GREEN with a trailer", () => {
    put("package.json", PKG("claude plugin validate plugins/sapu && vitest run"));
    commit("quietly unwire");
    const r = evaluateRuleGuard(repo, "base");
    expect(r.ok).toBe(false);
    expect(r.loosened).toEqual(["package.json: the `gate` script no longer runs `node scripts/rule-guard.ts` as a step of its own"]);

    git("commit", "-q", "--allow-empty", "-m", "explain\n\nRule-Change: rule-guard moved to a pre-receive hook");
    expect(evaluateRuleGuard(repo, "base").ok).toBe(true);
  });

  it("RED: the guard step neutered while its text survives (|| true, env override, ; chain)", () => {
    const unwired = "package.json: the `gate` script no longer runs `node scripts/rule-guard.ts` as a step of its own";
    for (const gate of [
      "claude plugin validate plugins/sapu && node scripts/rule-guard.ts || true && vitest run",
      "claude plugin validate plugins/sapu && GATE_DIFF_BASE=HEAD node scripts/rule-guard.ts && vitest run",
      "claude plugin validate plugins/sapu; node scripts/rule-guard.ts; vitest run",
    ]) {
      expect(findUnwiredGuard(PKG(), PKG(gate)), gate).toContain(unwired);
    }
  });

  it("RED: a neutraliser ANYWHERE in the gate string, even with the guard's own step intact", () => {
    const masks = (op: string) =>
      `package.json: the \`gate\` script contains ${op}, which can make it exit 0 although the guard failed`;
    const cases: Array<[string, string[]]> = [
      // the reviewer's case: the whole && list is rescued by a trailing || true
      ["claude plugin validate plugins/sapu && node scripts/rule-guard.ts && vitest run || true", ["`||`"]],
      ["claude plugin validate plugins/sapu && node scripts/rule-guard.ts && vitest run; exit 0", ["`;`", "`exit`"]],
      ["claude plugin validate plugins/sapu && node scripts/rule-guard.ts && vitest run &", ["`&`"]],
      ["claude plugin validate plugins/sapu && node scripts/rule-guard.ts && vitest run\ntrue", ["a newline"]],
      ["trap 'exit 0' EXIT && node scripts/rule-guard.ts && vitest run", ["`exit`"]],
    ];
    for (const [gate, ops] of cases) expect(findUnwiredGuard(PKG(), PKG(gate)), gate).toEqual(ops.map(masks));
  });

  it("RED end to end: the reviewer's `… && vitest run || true` gate; GREEN with a trailer", () => {
    put("package.json", PKG(`${GATE} || true`));
    commit("keep going on red");
    const r = evaluateRuleGuard(repo, "base");
    expect(r.ok).toBe(false);
    expect(r.loosened).toEqual([
      "package.json: the `gate` script contains `||`, which can make it exit 0 although the guard failed",
    ]);
    git("commit", "-q", "--allow-empty", "-m", "explain\n\nRule-Change: the gate is advisory while the suite is rebuilt");
    expect(evaluateRuleGuard(repo, "base").ok).toBe(true);
  });

  it("GREEN: && alone is no neutraliser, and this repo's own gate is wired", () => {
    expect(findUnwiredGuard(PKG(), PKG())).toEqual([]);
    const own = readFileSync(join(__dirname, "../package.json"), "utf8");
    expect(findUnwiredGuard(own, own)).toEqual([]);
  });

  it("RED: package.json deleted or unreadable at HEAD", () => {
    expect(findUnwiredGuard(PKG(), "not json")).toEqual([
      "package.json: no readable `gate` script at HEAD (it ran `node scripts/rule-guard.ts`)",
    ]);
    rmSync(join(repo, "package.json"));
    commit("drop package.json");
    expect(evaluateRuleGuard(repo, "base").loosened).toEqual(["package.json: deleted"]);
  });

  it("GREEN: the gate gains or reorders other steps", () => {
    put("package.json", PKG("node scripts/rule-guard.ts && claude plugin validate plugins/sapu && claude plugin validate . && vitest run"));
    commit("more steps");
    expect(evaluateRuleGuard(repo, "base").ok).toBe(true);
    expect(gateSteps(PKG())).toEqual(["claude plugin validate plugins/sapu", "node scripts/rule-guard.ts", "vitest run"]);
  });

  it("GREEN: guarded files that do not exist at base (being introduced) are not 'deleted' or 'changed'", () => {
    git("switch", "-q", "--orphan", "bare"); // empties the tree
    put(RULEBOOK, RULES);
    commit("bare base");
    git("switch", "-q", "-c", "intro");
    for (const [file, body] of Object.entries(ENFORCERS)) put(file, body);
    put("package.json", PKG());
    commit("introduce the guards");
    const r = evaluateRuleGuard(repo, "bare");
    expect(r.loosened).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("what enforces the rules is ratcheted: any edit or deletion needs a trailer", () => {
  it("the enforcement set is exactly these files, and each exists in this repo (a typo would guard nothing)", () => {
    expect(Object.keys(ENFORCEMENT_FILES).sort()).toEqual([
      "plugins/sapu/hooks/hooks.json",
      "plugins/sapu/scripts/sapu-contract.mjs",
      "plugins/sapu/scripts/sapu-guard.mjs",
      "plugins/sapu/scripts/sapu-merge.sh",
      "plugins/sapu/workflows/inspector.js",
      "plugins/sapu/workflows/sapu-wave.js",
      "scripts/rule-guard.ts",
      "tests/engine.test.ts",
      "tests/rule-guard.test.ts",
    ]);
    for (const file of Object.keys(ENFORCEMENT_FILES)) expect(existsSync(join(__dirname, "..", file)), file).toBe(true);
  });

  it.each(Object.keys(ENFORCERS))("RED: %s changed at all; GREEN with a trailer", (file) => {
    put(file, ENFORCERS[file] + "// one more line\n");
    commit("small edit");
    const red = evaluateRuleGuard(repo, "base");
    expect(red.ok).toBe(false);
    expect(red.loosened).toEqual([changed(file)]);
    git("commit", "-q", "--allow-empty", "-m", "explain\n\nRule-Change: reviewed change to what enforces the rules");
    expect(evaluateRuleGuard(repo, "base").ok).toBe(true);
  });

  it.each(Object.keys(ENFORCERS))("RED: %s deleted", (file) => {
    rmSync(join(repo, file));
    commit("delete");
    const red = evaluateRuleGuard(repo, "base");
    expect(red.ok).toBe(false);
    expect(red.loosened).toEqual([`${file}: deleted`]);
  });
});

describe("parsing", () => {
  it("normative words match as whole words, case-insensitively, and only those", () => {
    for (const s of [
      "WAJIB ada", "Jangan lakukan", "tak pernah", "Tidak Boleh", "dilarang", "hanya owner", "selalu", "You MUST", "never",
      "harus lewat gerbang", "it is required", "Larangan keras", "you should", "Do not skip", "don't skip", "don’t skip",
      "only owners", "always run", "do  not double-space",
    ]) {
      expect(isNormative(s), s).toBe(true);
    }
    for (const s of ["mustahil", "hanyalah", "nevertheless", "janganlah", "wajibkan", "lonely", "append-only tables", "read-only", "shoulder"]) {
      expect(isNormative(s), s).toBe(false);
    }
  });

  it("segmentText: a wrapped paragraph is one segment; a heading is always a segment of its own, so are list items, tables and blank lines", () => {
    const text = "# Title\nfirst line\nsecond line\n\n- bullet a\n- bullet b\n| a | b |\nplain";
    expect(segmentText(text)).toEqual([
      { line: 1, text: "# Title" },
      { line: 2, text: "first line second line" },
      { line: 5, text: "- bullet a" },
      { line: 6, text: "- bullet b" },
      { line: 7, text: "| a | b | plain" },
    ]);
  });

  it("parseRuleChangeReasons drops empty and too-short values", () => {
    expect(parseRuleChangeReasons("\0a reason that is long enough\0 \0too short\0")).toEqual(["a reason that is long enough"]);
  });

  it("resolveBase: origin/main by default, GATE_DIFF_BASE when set, never an option", () => {
    expect(resolveBase({})).toBe("origin/main");
    expect(resolveBase({ GATE_DIFF_BASE: " generic " })).toBe("generic");
    expect(() => resolveBase({ GATE_DIFF_BASE: "--output=x" })).toThrow(/must be a git ref/);
  });
});

describe("clause-level comparison (the false-positive fixes)", () => {
  const POINT6 =
    "6. **Append-only** (jangan pernah UPDATE/DELETE/TRUNCATE): `events`, `ledger_lines` — ditegakkan trigger DB per-tabel. Koreksi = baris BARU, tak pernah UPDATE. (Dulu ada `old_images`; dihapus bersama fiturnya.)\n";
  const SEVEN = "7. Diskon = overlay. Jangan menimpa `list_prices`.\n";

  beforeEach(() => {
    put(RULEBOOK, "# Rules\n\n" + POINT6 + SEVEN);
    commit("long invariant line");
    git("branch", "base2");
  });

  it("GREEN: adding an item INSIDE the list on a long rule line", () => {
    put(RULEBOOK, "# Rules\n\n" + POINT6.replace("`ledger_lines` —", "`ledger_lines`, `new_table` —") + SEVEN);
    commit("add table");
    const r = evaluateRuleGuard(repo, "base2");
    expect(r.touched).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("GREEN: appending text at the END of a long rule line", () => {
    put(RULEBOOK, "# Rules\n\n" + POINT6.trimEnd() + " Tabel baru: `new_table` — alasan lengkap ada di docs.\n" + SEVEN);
    commit("append to #6");
    expect(evaluateRuleGuard(repo, "base2").touched).toEqual([]);
  });

  it("GREEN: a typo fixed in a NON-normative clause of a line that also holds a rule", () => {
    put(RULEBOOK, "# Rules\n\n" + POINT6.replace("ditegakkan trigger", "ditegakkan trigger-trigger") + SEVEN);
    commit("typo");
    expect(evaluateRuleGuard(repo, "base2").touched).toEqual([]);
  });

  it("RED: the normative clause itself is changed (pernah -> boleh)", () => {
    put(RULEBOOK, "# Rules\n\n" + POINT6.replace("jangan pernah UPDATE", "boleh UPDATE") + SEVEN);
    commit("weaken");
    const r = evaluateRuleGuard(repo, "base2");
    expect(r.ok).toBe(false);
    expect(r.touched.map((t) => t.text)).toEqual(["jangan pernah UPDATE/DELETE/TRUNCATE"]);
  });

  it("GREEN: a normative sentence re-wrapped over several lines with its text intact", () => {
    put(RULEBOOK, "# Rules\n\n" + POINT6 + "7. Diskon = overlay.\n   Jangan menimpa\n   `list_prices`.\n");
    commit("rewrap");
    expect(evaluateRuleGuard(repo, "base2").touched).toEqual([]);
  });

  it("GREEN: a rule moved elsewhere in the same file; RED when it moves to ANOTHER file", () => {
    put(RULEBOOK, "# Rules\n\n" + SEVEN + POINT6);
    commit("reorder");
    expect(evaluateRuleGuard(repo, "base2").touched).toEqual([]);

    put(RULEBOOK, "# Rules\n\n" + POINT6);
    put("docs/elsewhere.md", "Jangan menimpa `list_prices`.\n");
    commit("move the rule out of the rulebook");
    expect(evaluateRuleGuard(repo, "base2").touched.map((t) => t.text)).toEqual(["Jangan menimpa list_prices"]);
  });

  it("GREEN: markdown emphasis added or removed around an unchanged rule", () => {
    put(RULEBOOK, "# Rules\n\n" + POINT6 + "7. Diskon = overlay. **Jangan** menimpa list_prices.\n");
    commit("bold");
    expect(evaluateRuleGuard(repo, "base2").touched).toEqual([]);
  });

  it("splitClauses cuts at sentence ends, dashes, colons and parentheses, and drops list markers", () => {
    expect(splitClauses("- Do this: never that (but ok) — ever. Next one")).toEqual([
      "Do this",
      "never that",
      "but ok",
      "ever",
      "Next one",
    ]);
  });
});

describe("an exception appended to a rule is a changed rule (whole-clause identity, not substring)", () => {
  it("RED: 'Jangan merge PR merah.' -> '... kecuali mendesak.'", () => {
    const lost = findLostNormativeClauses("- Jangan merge PR merah.\n", "- Jangan merge PR merah kecuali mendesak.\n", RULEBOOK);
    expect(lost.map((l) => l.text)).toEqual(["Jangan merge PR merah"]);
  });

  it("RED: 'Never merge a red PR.' -> '... unless the owner is asleep.'", () => {
    const lost = findLostNormativeClauses("Never merge a red PR.\n", "Never merge a red PR unless the owner is asleep.\n", "x.md");
    expect(lost.map((l) => l.text)).toEqual(["Never merge a red PR"]);
  });

  it("RED: only the SECOND line of a wrapped clause is edited (the normative word is on the unchanged first line)", () => {
    const oldText = "Never merge a PR that is red\nand not owner-approved.\n";
    const newText = "Never merge a PR that is red\nor was skipped.\n";
    expect(findLostNormativeClauses(oldText, newText, "x.md").map((l) => l.text)).toEqual([
      "Never merge a PR that is red and not owner-approved",
    ]);
  });

  it("RED: a lone 'Never.' bullet is not safe just because the word survives in another clause", () => {
    const lost = findLostNormativeClauses("- Never.\n- Other rule.\n", "- Other rule.\n- Never merge without review.\n", "x.md");
    expect(lost.map((l) => l.text)).toEqual(["Never"]);
  });

  it("GREEN: a pure re-wrap, an appended list item, and a moved clause stay green", () => {
    expect(findLostNormativeClauses("Never merge a red PR\nwithout review.\n", "Never merge a red PR without\nreview.\n", "x.md")).toEqual([]);
    const six = "6. **Append-only** (jangan pernah UPDATE): `a`, `b` — ditegakkan trigger. Koreksi = baris BARU, tak pernah UPDATE.\n";
    expect(findLostNormativeClauses(six, six.replace("`b` —", "`b`, `c` —") + "tambahan.\n", RULEBOOK)).toEqual([]);
    expect(findLostNormativeClauses("- Jangan x.\n- Lain.\n", "- Lain.\n- Jangan x.\n", "x.md")).toEqual([]);
  });

  it("end to end through git: appending an exception to a rule is RED, and a Rule-Change trailer clears it", () => {
    put(RULEBOOK, "# Rules\n\n- Jangan merge PR merah.\n- Lain.\n");
    commit("rule");
    git("branch", "b3");
    put(RULEBOOK, "# Rules\n\n- Jangan merge PR merah kecuali mendesak.\n- Lain.\n");
    commit("add an exception");
    const red = evaluateRuleGuard(repo, "b3");
    expect(red.ok).toBe(false);
    expect(red.touched.map((t) => `${t.file}:${t.line} ${t.text}`)).toEqual([`${RULEBOOK}:3 Jangan merge PR merah`]);

    put(RULEBOOK, "# Rules\n\n- Jangan merge PR merah kecuali mendesak.\n- Lain.\n\nCatatan.\n");
    commit("explain\n\nRule-Change: owner approved an emergency exception during an incident");
    expect(evaluateRuleGuard(repo, "b3").ok).toBe(true);
  });

  it("a rename that keeps the text is green; a rename that drops a rule is red", () => {
    put("plugins/sapu/skills/x/OLD.md", "Never skip the gate.\n");
    commit("add old");
    git("branch", "b4");
    git("mv", "plugins/sapu/skills/x/OLD.md", "plugins/sapu/skills/x/NEW.md");
    commit("rename");
    expect(evaluateRuleGuard(repo, "b4").touched).toEqual([]);
    put("plugins/sapu/skills/x/NEW.md", "Skip the gate.\n");
    commit("weaken");
    expect(evaluateRuleGuard(repo, "b4").touched.map((t) => t.text)).toEqual(["Never skip the gate"]);
  });
});

describe("agent frontmatter (tools / model / effort) is guarded", () => {
  const AGENT = "plugins/sapu/agents/sapu-x.md";
  const agent = (model: string, tools = "") =>
    `---\nname: sapu-x\ndescription: something\nmodel: ${model}\neffort: high\n${tools}---\n\nBody text.\n`;

  it("findChangedAgentFrontmatter reports each changed, added or removed key", () => {
    expect(findChangedAgentFrontmatter("a.md", agent("sonnet"), agent("opus"))).toEqual([
      "a.md: frontmatter model changed: sonnet -> opus",
    ]);
    expect(findChangedAgentFrontmatter("a.md", agent("sonnet"), agent("sonnet", "tools: Bash, Read\n"))).toEqual([
      "a.md: frontmatter tools changed: (absent) -> Bash, Read",
    ]);
    expect(findChangedAgentFrontmatter("a.md", agent("sonnet"), agent("sonnet").replace("effort: high\n", ""))).toEqual([
      "a.md: frontmatter effort changed: high -> (absent)",
    ]);
    expect(findChangedAgentFrontmatter("a.md", agent("sonnet"), agent("sonnet").replace("something", "other"))).toEqual([]);
  });

  it("RED: a model change in plugins/sapu/agents/*.md; GREEN with a Rule-Change trailer; a description edit is fine", () => {
    put(AGENT, agent("sonnet"));
    commit("add agent");
    git("branch", "b5");
    put(AGENT, agent("sonnet").replace("something", "reworded description"));
    commit("reword");
    expect(evaluateRuleGuard(repo, "b5").ok).toBe(true);

    put(AGENT, agent("haiku").replace("something", "reworded description"));
    commit("downgrade");
    const red = evaluateRuleGuard(repo, "b5");
    expect(red.ok).toBe(false);
    expect(red.loosened).toEqual([`${AGENT}: frontmatter model changed: sonnet -> haiku`]);

    put(AGENT, agent("haiku").replace("something", "reworded description") + "\n");
    commit("explain\n\nRule-Change: cheaper model is enough for this mechanical agent");
    expect(evaluateRuleGuard(repo, "b5").ok).toBe(true);
  });

  it("RED: a tools list widened", () => {
    put(AGENT, agent("sonnet", "tools: Bash, Read\n"));
    commit("add agent");
    git("branch", "b5t");
    put(AGENT, agent("sonnet", "tools: Bash, Read, WebFetch\n"));
    commit("widen");
    expect(evaluateRuleGuard(repo, "b5t").loosened).toEqual([
      `${AGENT}: frontmatter tools changed: Bash, Read -> Bash, Read, WebFetch`,
    ]);
  });

  it("RED: deleting an agent definition", () => {
    put(AGENT, agent("sonnet"));
    commit("add agent");
    git("branch", "b6");
    rmSync(join(repo, AGENT));
    commit("delete agent");
    expect(evaluateRuleGuard(repo, "b6").loosened).toEqual([`${AGENT}: agent definition deleted`]);
  });
});

describe("headings never fuse with the prose right under them", () => {
  const rule = "Never merge a red PR.";

  it("GREEN: renaming a heading above an unchanged rule", () => {
    expect(findLostNormativeClauses(`## Merging\n${rule}\n`, `## Landing changes\n${rule}\n`, "x.md")).toEqual([]);
  });

  it("GREEN: inserting a heading above / between rules", () => {
    expect(findLostNormativeClauses(`## A\n${rule}\n`, `## A\n## New section\n${rule}\n`, "x.md")).toEqual([]);
    expect(findLostNormativeClauses(`${rule}\n`, `## Brand new heading\n${rule}\n`, "x.md")).toEqual([]);
  });

  it("GREEN: moving a paragraph under another heading with no blank line between", () => {
    const oldText = `## A\n${rule}\n## B\nOther text.\n`;
    const newText = `## A\n## B\nOther text.\n${rule}\n`;
    expect(findLostNormativeClauses(oldText, newText, "x.md")).toEqual([]);
  });

  it("RED: changing a heading that ITSELF holds a normative word", () => {
    const lost = findLostNormativeClauses("## Never do X\nDetails.\n", "## Sometimes do X\nDetails.\n", "x.md");
    expect(lost.map((l) => l.text)).toEqual(["Never do X"]);
    // same words, renamed heading text around them: still a different clause
    expect(findLostNormativeClauses("## Never do X\n", "## Never do X or Y\n", "x.md")).toHaveLength(1);
  });

  it("end to end: a heading rename above a rule is green without any trailer", () => {
    put(RULEBOOK, "# Rules\n\n## Merging\nNever merge a red PR.\n");
    commit("headed rule");
    git("branch", "b7");
    put(RULEBOOK, "# Rules\n\n## Landing changes\nNever merge a red PR.\n");
    commit("rename heading");
    const r = evaluateRuleGuard(repo, "b7");
    expect(r.touched).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
