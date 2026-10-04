import { card, rect, text, lines, arrow, brandTile, chip, chips, tier, badge, headline, m, b, c, tw } from "../lib.mjs";

const P = "senior-dev-team:";
const AGENTS = [
  ["target", "Product manager", "product-manager", "PRDs, backlog priority, user stories, scope", "product"],
  ["layers", "Software architect", "senior-software-architect", "system design, trade-offs, migrations, ADRs", "architect"],
  ["code", "Full-stack developer", "senior-fullstack-developer", "features, bug fixes, refactors and tests", "developer"],
  ["db", "Database engineer", "senior-fullstack-database-engineer", "schemas, safe migrations, slow queries, indexes", "db"],
  ["layout", "UI/UX designer", "senior-ui-ux-designer", "flows, UI critique, tokens, accessibility, UX audits", "ux"],
  ["bug", "QA analyst", "senior-qa-analyst", "executed evidence: API, security, browser E2E", null],
  ["search", "QA reviewer", "senior-qa-reviewer", "code and diff review with evidence, no browser", "qa"],
  ["pen", "Technical writer", "senior-technical-writer", "READMEs, API references, guides, release notes", "writer"],
];

export default {
  h: 954,
  title: "senior-dev-team — eight senior specialists, and how sapu uses them",
  desc:
    "senior-dev-team is a second plugin in the sapu marketplace: eight senior agents, each with one role, a fixed method and a Handoffs section. " +
    AGENTS.map(([, name, id, what, role]) => `${name} (${P}${id}): ${what}${role ? `; sapu role ${role}` : "; no default sapu role"}.`).join(" ") +
    " sapu depends on the plugin and calls its specialists by role: the qa specialist reviews every PR at Opus/high and is never its author; a red-tier issue or a red-area diff gets an adversarial Opus pair, qa plus a domain specialist; a scoped /inspector run adds a read-only team review, product and ux in parallel, then qa and tests alone. A repo can map any role to its own agent through the optional specialists field of .claude/sapu.json; roles it does not name keep the default. Every agent runs on Opus at high effort with project-scoped memory, and follows the dispatching prompt's rules: read-only when told, never stops to ask the user, returns the structured output asked for, stays in its worktree.",
  label:
    "The senior-dev-team plugin: eight senior agents — product manager, software architect, full-stack developer, database engineer, UI/UX designer, QA analyst, QA reviewer and technical writer — and how sapu dispatches them by role: qa reviews every PR, a qa plus domain-specialist Opus pair reviews the red tier, and a scoped /inspector run adds a read-only team review. A repo can map any role to its own agent.",
  eyebrow: "PLUGIN · senior-dev-team",
  heading: "Eight senior specialists, one team",
  sub: "A second plugin in this marketplace. sapu depends on it and calls its agents by role.",
  body() {
    let s = "";
    const x0 = 32, y0 = 128, w = 420, h = 96, gx = 16, gy = 14;
    AGENTS.forEach(([ico, name, id, what, role], i) => {
      const x = x0 + (i % 2) * (w + gx), y = y0 + Math.floor(i / 2) * (h + gy);
      s += card(x, y, w, h, "card", 14);
      s += brandTile(ico, x + 16, y + 16, 36);
      s += text(x + 66, y + 32, name, "ttl");
      s += text(x + 66, y + 51, what, "cap");
      s += rect(x + 16, y + 64, w - 32, 22, "sunken", 6);
      s += text(x + 26, y + 79, `${P}${id}`, "cap mono ink");
      if (role) {
        const lbl = `role: ${role}`;
        const cw = Math.round(tw(lbl, 11.5, "bold") + 20);
        s += chip(x + w - 16 - cw, y + 16, lbl, "violet")[0];
      } else {
        const lbl = "on demand";
        const cw = Math.round(tw(lbl, 11.5, "bold") + 20);
        s += chip(x + w - 16 - cw, y + 16, lbl, "neutral")[0];
      }
    });

    // how sapu dispatches
    const sy = y0 + 4 * (h + gy) + 30;
    s += badge(46, sy - 5, "→");
    s += headline(70, sy, "How sapu dispatches the team", "by role, never by a bare agent name");

    const ry = sy + 22, rh = 50, rg = 10;
    // sapu node
    s += card(32, ry, 168, 3 * rh + 2 * rg, "card", 14);
    s += brandTile("lanes", 48, ry + 18, 36);
    s += text(48, ry + 82, "sapu", "ttl");
    s += lines(48, ry + 102, ["orchestrator +", "forge workers"], "cap", 17);
    const rows = [
      [["green", "yellow"], "Every PR", "the qa specialist reviews at Opus/high, never the PR's author"],
      [["red"], "Red tier or red-area diff", "an adversarial Opus pair: qa + a domain specialist"],
      [[], "/inspector, scoped run", "read-only team review: product + ux in parallel, then qa / tests"],
    ];
    const rx = 236, rw = 888 - rx;
    rows.forEach(([tiers, ttl, what], i) => {
      const y = ry + i * (rh + rg);
      s += arrow([[200, ry + (3 * rh + 2 * rg) / 2], [216, ry + (3 * rh + 2 * rg) / 2], [216, y + rh / 2], [rx - 4, y + rh / 2]], "ar");
      s += card(rx, y, rw, rh, "card", 12);
      let cx = rx + 14;
      if (tiers.length) {
        for (const t of tiers) {
          const [cs, cw] = tier(cx, y + 14, t);
          s += cs;
          cx += cw + 6;
        }
      } else {
        const [cs, cw] = chip(cx, y + 14, "read-only", "blue");
        s += cs;
        cx += cw + 6;
      }
      s += text(cx + 8, y + 30, `${b(ttl)}${c("  ·  ", "muted")}${what}`, "t");
    });

    // override
    const oy = ry + 3 * rh + 2 * rg + 18;
    s += rect(32, oy, 856, 64, "k-blue", 12);
    s += text(48, oy + 26, `${b("Bring your own agent.", "tb")} Map a role in the optional ${m("specialists")} field of ${m(".claude/sapu.json")}; roles it does not name keep the default.`, "t");
    s += text(48, oy + 48, '"specialists": {"qa": "my-qa-agent"}', "cap mono c-blue");

    // footer
    const fy = oy + 94;
    s += text(32, fy, `${b("Every agent")}  Opus / high · project-scoped memory · a Handoffs section naming who picks up next`, "cap");
    s += text(32, fy + 20, `${b("When dispatched")}  follows the caller's rules: read-only when told, never stops to ask, returns the structured output asked for, stays in its worktree`, "cap");
    return s;
  },
};
