// A valid contract shaped like a typical application repo: a package-script gate with a fast
// variant, a local Postgres the workers must not touch, and a red-area classifier. Tests use it to
// prove that every rule the engine enforces is enforced through a contract.
export const FIXTURE_CONTRACT = {
  version: 1,
  repo: "owner/app",
  ghUser: "owner",
  gitEmail: "owner@example.com",
  baseBranch: "main",
  gate: {
    fast: "npm run check -- --fast",
    merge: "scripts/sapu-hooks.sh gate",
    summaryStart: "^Gate summary",
    redIf: "^⊘.*(migration-drift|cyber)",
  },
  redAreas: "node --import tsx scripts/red-area.ts",
  // A role name, resolved through `specialists` (absent here: every role uses the built-in agent).
  redAreaSpecialists: [{ match: "schema|payments|audit|invariant", agent: "db" }],
  mergeAfter: "scripts/sapu-hooks.sh after",
  labels: { tierPrefix: "risk:", inProgress: "agent:in-progress", done: "agent:done" },
  securityEpic: 42,
  invariantDomains: "money, stock, permissions/RBAC, schema/migrations, payments, auth, HR personal data",
  testResources: "your own app_test_<ID>* databases",
  guard: {
    envFiles: [] as string[],
    postgres: { ports: [6543], databases: ["app_dev"] } as { ports: number[]; databases: string[] } | null,
    deny: [
      { argv: ["npm", "run", "check"], allowWith: ["--", "--fast"], reason: "the full gate is orchestrator-only." },
      { argv: ["pnpm", "run", "check"], allowWith: ["--", "--fast"], reason: "the full gate is orchestrator-only." },
      { argv: ["yarn", "run", "check"], allowWith: ["--", "--fast"], reason: "the full gate is orchestrator-only." },
      { argv: ["npm", "run", "check:full"], reason: "check:full is orchestrator-only." },
      { argv: ["pnpm", "run", "check:full"], reason: "check:full is orchestrator-only." },
      { argv: ["yarn", "run", "check:full"], reason: "check:full is orchestrator-only." },
      // yarn and pnpm run a package script without `run`. Rule words match in order, so these
      // also cover the `run` forms; `check:full` without `run` needs rules of its own.
      { argv: ["yarn", "check"], allowWith: ["--", "--fast"], reason: "the full gate is orchestrator-only." },
      { argv: ["pnpm", "check"], allowWith: ["--", "--fast"], reason: "the full gate is orchestrator-only." },
      { argv: ["yarn", "check:full"], reason: "check:full is orchestrator-only." },
      { argv: ["pnpm", "check:full"], reason: "check:full is orchestrator-only." },
      { path: "scripts/check.ts", allowWith: ["--fast"], reason: "the full gate is orchestrator-only." },
      { argv: ["weekly-gate.sh"], reason: "the weekly/full gate is the orchestrator's." },
    ] as Array<{ argv?: string[]; path?: string; allowWith?: string[]; reason: string }>,
  },
};
