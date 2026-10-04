import { card, rect, text, lines, arrow, iconTile, brandTile, chip, chips, badge, legend, m, b, c, tw } from "../lib.mjs";

export default {
  h: 956,
  title: "sapu — how the pieces fit",
  desc: "The sapu plugin is an engine (skills, worker agents, guard hook, workflows, scripts) that knows no repo; its specialist agents come from the senior-dev-team plugin, installed with it and called by role. Each repo supplies a contract (.claude/sapu.json and .claude/sapu/*.md profiles, written by /sapu:init), committed in the repo or kept local under ~/.config/sapu/repos/, plus the QA configs .argus/, .momus/ and .nemesis/ config.yml; nemesis targets are not in it but in an owner-signed, gitignored authorization.yml. An optional per-machine config (~/.config/sapu/config.json: allowedRoots, projectScopeOnly) limits where sapu may run. /sapu runs one forge worker per issue in parallel lanes, a reviewer by tier that is never the author, and merges ready PRs through the merge gate sapu-merge.sh; /inspector runs momus, then argus, then nemesis, one after another; /dream runs standalone and read-only and writes one local report under dreams/. The guard hook polices every subagent but never the orchestrator, and only the orchestrator merges, through the merge gate. GitHub issues are filed by argus and nemesis; by sapu only for security gaps and a proven base flake; by momus only when asked. momus and inspector write reports; state lives in the main checkout under .argus/, .momus/, .nemesis/ and dreams/.",
  label: "How sapu fits together: a repo-agnostic engine plus a per-repo contract, optionally scope-locked by a machine config, with specialists from the senior-dev-team plugin; the sapu orchestrator runs one forge worker per issue in parallel lanes, inspector runs momus then argus then nemesis, dream runs standalone, a guard hook polices every subagent, and only the orchestrator merges through the merge gate.",
  eyebrow: "ARCHITECTURE",
  heading: "How the pieces fit",
  sub: "A repo-agnostic engine, a per-repo contract, and an optional machine scope lock.",
  body() {
    let s = "";
    s += legend(32, 136, [["reads", "reads contract / config"], ["flow", "flow / calls"], ["produces", "produces"], ["feeds", "specialists by role"], ["limit", "hard limit"], ["guard", "guard hook"]]);

    // ---- inputs
    const y1 = 160;
    s += card(32, y1, 540, 134, "k-blue", 14);
    s += iconTile("doc", 48, y1 + 16, "blue", 34);
    s += text(96, y1 + 31, "Repo contract", "ttl");
    s += text(96 + tw("Repo contract", 14, "bold") + 8, y1 + 31, "committed, or local", "cap");
    s += text(96, y1 + 50, `${m(".claude/sapu.json")} + ${m(".claude/sapu/*.md")} — drafted by /sapu:init`, "cap");
    s += lines(48, y1 + 76, [
      `or local, nothing in the repo: ${m("~/.config/sapu/repos/&lt;owner&gt;__&lt;name&gt;/")}`,
      `+ QA configs: ${m(".argus/ .momus/ .nemesis/")} config.yml`,
      `not in it: nemesis targets — owner-signed, gitignored ${m("authorization.yml")}`,
    ], "cap", 19);

    s += card(588, y1, 300, 134, "k-red", 14);
    s += iconTile("lock", 604, y1 + 16, "red", 34);
    s += text(652, y1 + 31, "Machine config", "ttl");
    s += text(652 + tw("Machine config", 14, "bold") + 8, y1 + 31, "optional", "cap");
    s += text(652, y1 + 50, "~/.config/sapu/config.json", "cap mono");
    s += lines(604, y1 + 76, [`${m("allowedRoots")} · ${m("projectScopeOnly")}`, "limits where sapu may run", "on this machine"], "cap", 19);

    const y2 = 336;
    s += arrow([[200, y1 + 136], [200, y2 - 4]], "ar-b");
    s += text(210, y1 + 160, "contract + profiles", "cap");
    s += arrow([[630, y1 + 136], [630, y2 - 4]], "ar-b");
    s += text(640, y1 + 160, "scope lock", "cap");

    // ---- engine
    s += `<rect x="32" y="${y2}" width="640" height="214" rx="16" class="card" filter="url(#sh)"/><rect x="32" y="${y2}" width="640" height="214" rx="16" fill="none" stroke="url(#brand)" stroke-width="1.6"/>`;
    s += brandTile("lanes", 48, y2 + 16, 36);
    s += text(96, y2 + 32, "sapu plugin — the engine", "ttl");
    s += text(96, y2 + 50, "knows no repo; every repo fact comes from its contract", "cap");
    s += text(48, y2 + 80, "SKILLS", "lbl");
    const sk1 = [["/sapu", "neutral", { mono: true }], ["/forge", "neutral", { mono: true }], ["/inspector", "neutral", { mono: true }], ["/momus", "neutral", { mono: true }], ["/argus", "neutral", { mono: true }], ["/nemesis", "neutral", { mono: true }], ["/dream", "neutral", { mono: true }], ["/sapu:init", "neutral", { mono: true }]];
    s += chips(48, y2 + 88, sk1, 6)[0];
    const mods = [
      ["agents/", ["the worker", "ladder only"], "card2"],
      ["hooks/ · guard", ["every subagent's", "tool calls"], "k-red"],
      ["workflows/", ["sapu-wave.js", "inspector.js"], "card2", true],
      ["scripts/", ["merge · cleanup", "checks"], "card2"],
    ];
    mods.forEach(([t, l, cls, mono], i) => {
      const x = 48 + i * 154, y = y2 + 124;
      s += rect(x, y, 144, 74, cls === "card2" ? "sunken" : cls, 10);
      s += text(x + 14, y + 24, t, "tb mono");
      s += lines(x + 14, y + 45, l, mono ? "cap mono" : "cap", 18);
    });

    // senior-dev-team
    s += card(708, y2, 180, 214, "k-violet", 16);
    s += brandTile("users", 724, y2 + 16, 36);
    s += text(724, y2 + 76, "senior-dev-team", "ttl");
    s += lines(724, y2 + 98, ["second plugin, installed", "with sapu", "", "8 senior specialists:", "reviewers and advisers,", "called by role"], "cap", 17);
    s += arrow([[706, y2 + 107], [676, y2 + 107]], "ar-v");

    // ---- how a run flows
    const y3 = y2 + 262;
    s += badge(46, y3 - 5, "▸");
    s += text(70, y3, "How a run flows", "sec");
    const r1 = y3 + 40, r2 = r1 + 74, r3 = r2 + 74, eh = 52;
    // guard region
    s += `<rect x="168" y="${r1 - 26}" width="452" height="${r2 + eh + 12 - (r1 - 26)}" rx="14" class="guard"/>`;
    s += text(184, r1 - 10, "guard hook polices every subagent — never the orchestrator", "cap c-red");

    const entry = (y, cmd, sub) => card(32, y, 118, eh, "card", 12) + text(46, y + 23, cmd, "tb mono") + text(46, y + 41, sub, "cap");
    const node = (x, y, w, t, sub, cls = "card", tcls = "tb", scls = "cap") => card(x, y, w, eh, cls, 12) + text(x + w / 2, y + 23, t, tcls, "middle") + text(x + w / 2, y + 41, sub, scls, "middle");

    s += entry(r1 + 2, "/sapu", "orchestrator");
    s += arrow([[152, r1 + 28], [182, r1 + 28]]);
    s += text(167, r1 + 18, "", "cap");
    s += node(186, r1 + 2, 196, "forge worker × N", "one lane per issue", "sunken");
    s += arrow([[384, r1 + 28], [404, r1 + 28]]);
    s += node(408, r1 + 2, 196, "reviewer by tier", "never the author", "sunken");
    s += arrow([[606, r1 + 28], [644, r1 + 28]]);
    s += node(648, r1 + 2, 130, "merge gate", "sapu-merge.sh", "k-red", "tb", "cap mono");
    s += arrow([[780, r1 + 28], [796, r1 + 28]], "ar-g");
    s += node(800, r1 + 2, 88, "merged", "to base", "k-green");

    s += entry(r2, "/inspector", "sequencer");
    s += arrow([[152, r2 + 26], [182, r2 + 26]]);
    ["momus", "argus", "nemesis"].forEach((n, i) => {
      const x = 186 + i * 142;
      s += card(x, r2 + 8, 118, 36, "sunken", 10) + text(x + 59, r2 + 31, n, "tb mono", "middle");
      if (i < 2) s += arrow([[x + 120, r2 + 26], [x + 140, r2 + 26]]);
    });
    s += text(648, r2 + 23, "one after another,", "cap");
    s += text(648, r2 + 41, "never in parallel", "cap");

    s += entry(r3 + 4, "/dream", "read-only");
    s += arrow([[152, r3 + 30], [644, r3 + 30]], "ar-g");
    s += text(398, r3 + 22, "research → hypotheses → experiments; no GitHub writes", "cap", "middle");
    s += node(648, r3 + 4, 240, "one local report", "dreams/", "k-green", "tb", "cap mono");

    // produced
    const y4 = r3 + 80;
    s += rect(32, y4, 856, 66, "sunken", 12);
    s += iconTile("flag", 46, y4 + 16, "violet", 34) ;
    s += text(94, y4 + 28, `${b("GitHub issues")}  argus, nemesis · sapu only for security gaps and a proven base flake · momus only when asked`, "cap");
    s += text(94, y4 + 48, `${b("Reports + state")}  momus, inspector write reports · state in the main checkout: ${m(".argus/ .momus/ .nemesis/ dreams/")}`, "cap");
    return s;
  },
};
