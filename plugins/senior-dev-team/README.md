# senior-dev-team

A senior software development team for Claude Code, packaged as eight subagents. Each agent has one role, a fixed method, and a "Handoffs" section that tells the main conversation which agent picks up the work next.

## The agents

| Agent | Use it to |
|---|---|
| `product-manager` | Turn an idea into a PRD, prioritize a backlog (RICE, Kano, MoSCoW), write user stories with acceptance criteria, decide scope or whether a feature is worth building. |
| `senior-software-architect` | Design a system or feature before building it, compare approaches, review architecture, plan migrations, write ADRs. |
| `senior-fullstack-developer` | Implement features, fix bugs, refactor, and write tests, following the repo's conventions and verifying the result. |
| `senior-fullstack-database-engineer` | Design schemas, write or review migrations, fix slow queries, add indexes, protect data integrity. |
| `senior-ui-ux-designer` | Design flows and screens, critique UI, define design tokens, check accessibility, run a formal UX audit with a score. |
| `senior-qa-analyst` | Verify a change with executed evidence: API and security checks, browser E2E, mobile and responsive behavior. |
| `senior-qa-reviewer` | Same method as the QA analyst for code and diff review without a browser; smaller startup context. |
| `senior-technical-writer` | Write READMEs, API references, guides, release notes, changelogs, and runbooks, verified against the code. |

Claude picks an agent from its description, or you can ask for one by name: "use senior-software-architect to design the import pipeline".

## Install

```bash
claude plugin marketplace add sandalkuilang/sapu
claude plugin install senior-dev-team@sapu
```

The default user scope makes the agents available in every project. If you install the `sapu` plugin, it installs `senior-dev-team` for you as a dependency.

## Optional tools and skills

No agent needs anything beyond Claude Code. Some agents use extra tools when your session has them:

- `senior-qa-analyst` drives a real browser when a browser automation MCP server (for example Playwright MCP) is configured in your session, or uses the project's own E2E runner. Without either, it reports the browser cases as untested instead of guessing.
- Agents use helper skills (test-driven development, a design-intelligence skill) only "if available". When a skill is missing, the agent applies the same discipline itself.

## When another agent dispatches them

Each agent follows the dispatching prompt's rules over its own: it stays read-only when told to, never stops to ask the user, returns exactly the structured output requested, and stays inside the given worktree. This makes the agents safe to call from orchestrators and workflows.

## Memory

Every agent uses project-scoped memory, stored in `.claude/agent-memory/senior-dev-team-<agent-name>/` in the project (the plugin name is part of the folder). Decisions, conventions, and defect patterns learned in one repository stay in that repository. Agents never store secrets.

## License

MIT. See [LICENSE](LICENSE).

**Coming from the same agents installed by hand** (as user-level or project-level agent files)? Their memory lives in `.claude/agent-memory/<agent-name>/`; move each folder to `.claude/agent-memory/senior-dev-team-<agent-name>/` in every project, then remove the hand-installed copies so only the plugin's agents remain.
