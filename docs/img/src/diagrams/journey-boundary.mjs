import { readFileSync } from "node:fs";
import { card, rect, text, lines, arrow, iconTile, brandTile, chipsWrap, legend, m, b, c } from "../lib.mjs";
const A11Y = JSON.parse(readFileSync(new URL("../a11y/journey-boundary.json", import.meta.url), "utf8"));

export default {
  h: 1054,
  ...A11Y,
  eyebrow: "JOURNEY LANE · TRUST BOUNDARY",
  heading: "Yours is trusted; the pages are not",
  sub: "What each part of a journey cycle may touch. Defence in depth for honest mistakes, not a sandbox.",
  body() {
    let s = "";
    s += legend(32, 136, [["flow", "calls"], ["reads", "fenced data back"], ["produces", "files"], ["guard", "guard hook"], ["limit", "never touched"]]);

    // ---- who may do what
    const y1 = 162, h1 = 212;
    s += card(32, y1, 232, h1, "card", 14);
    s += brandTile("users", 48, y1 + 16, 36);
    s += text(96, y1 + 32, "Orchestrator", "ttl");
    s += text(96, y1 + 50, "main session · unguarded", "cap");
    s += lines(48, y1 + 88, [
      `runs ${m("up")}, ${m("repro")}, ${m("scrub")}, ${m("down")}`,
      "reads the instance only via",
      `${m("status --json")} and ${m("intake")}`,
      "dispatches one explorer per",
      "journey, with its charter",
    ], "cap", 19);

    s += rect(282, y1, 320, h1, "guard", 14);
    s += text(298, y1 + 18, "guard hook: the explorer's tools", "cap c-red");
    s += card(296, y1 + 28, 292, h1 - 42, "k-violet", 12);
    s += iconTile("search", 310, y1 + 42, "violet", 34);
    s += text(356, y1 + 58, "sapu:ui-explorer", "tb mono");
    s += text(356, y1 + 76, "subagent · walks one journey", "cap");
    s += lines(310, y1 + 108, [
      `${b("Bash", "tb c-violet")}  ${m("node &lt;wrapper&gt; pw …")} only`,
      `${b("Read", "tb c-violet")}  committed at HEAD in the run's`,
      `  worktree, outside ${m(".argus/")}`,
      "no Grep, Glob, Agent, Task, Workflow",
    ], "cap", 19);

    s += card(620, y1, 268, h1, "card", 14);
    s += iconTile("shield", 636, y1 + 16, "blue", 34);
    s += text(682, y1 + 32, "pw wrapper", "ttl");
    s += text(682, y1 + 50, "argus-live.mjs pw", "cap mono");
    s += lines(636, y1 + 88, [
      "a token per explorer; budget,",
      "loop and deadline per token",
      "allowlisted commands and flags",
      "URLs inside the run's origins",
      `no ${m("run-code")}, no ${m("eval")}`,
    ], "cap", 19);

    s += arrow([[266, y1 + 96], [294, y1 + 96]]);
    s += arrow([[590, y1 + 88], [618, y1 + 88]]);
    s += arrow([[618, y1 + 140], [590, y1 + 140]], "ar-b");
    s += arrow([[294, y1 + 160], [266, y1 + 160]], "ar-b");

    // page text is data
    const fy = y1 + h1 + 12;
    s += rect(32, fy, 570, 52, "sunken", 10);
    s += text(48, fy + 21, `${b("Page text is data.")} A page's answer comes back in ${m("&lt;&lt;&lt;PAGE-&lt;nonce&gt;")},`, "cap");
    s += text(48, fy + 40, `a return through ${m("intake")} in ${m("&lt;&lt;&lt;RETURN-&lt;nonce&gt;")}: never instructions.`, "cap");

    // ---- the instance
    const y2 = fy + 52 + 24, h2 = 200;
    s += card(32, y2, 256, h2, "k-red", 14);
    s += iconTile("stop", 48, y2 + 16, "red", 34);
    s += text(94, y2 + 32, b("Your servers and data", "tb c-red"), "t");
    s += text(94, y2 + 50, "never touched", "cap");
    s += lines(48, y2 + 86, [
      `${m("up")} refuses a base URL off`,
      "loopback, a protected store, an",
      "env value reaching what your env",
      "files name; an egress check and",
      `a Docker gate at ${m("up")} and ${m("renew")}`,
    ], "cap", 19);

    s += `<rect x="304" y="${y2}" width="584" height="${h2}" rx="14" class="card" filter="url(#sh)"/><rect x="304" y="${y2}" width="584" height="${h2}" rx="14" fill="none" stroke="url(#brand)" stroke-width="1.6"/>`;
    s += brandTile("layers", 320, y2 + 16, 36);
    s += text(368, y2 + 32, "Isolated instance", "ttl");
    s += text(368, y2 + 50, `built by ${m("up")} · one per cycle, under a lock with a deadline`, "cap");
    const N = [["browser sessions", "one per account"], ["filtering proxy", "run's origins only"], ["the app", "start entries"], ["own store", "reset: synthetic"]];
    const nw = 122, ny = y2 + 70;
    N.forEach(([t, sub], i) => {
      const x = 750 - i * (nw + 18);
      s += rect(x, ny, nw, 52, "sunken", 10);
      s += text(x + nw / 2, ny + 22, t, "tb", "middle");
      s += text(x + nw / 2, ny + 40, sub, "cap", "middle");
      if (i < 3) s += arrow([[x - 2, ny + 26], [x - 16, ny + 26]]);
    });
    s += arrow([[811, y1 + h1 + 2], [811, ny - 2]]);
    s += chipsWrap(320, y2 + 140, [["worktree at HEAD", "neutral"], ["ports from port_range", "neutral", { mono: false }], ["own HOME", "neutral"], ["own Docker client", "neutral"], ["env: only what live.json names", "neutral"]], 552)[0];

    // ---- before anything leaves
    const y3 = y2 + h2 + 24, h3 = 204;
    s += card(32, y3, 856, h3, "card", 14);
    s += brandTile("flag", 48, y3 + 16, 36);
    s += text(96, y3 + 32, "Before anything leaves the machine", "ttl");
    s += text(96, y3 + 50, `filed only through ${m("scrub")}, only at two of two`, "cap");
    const F = [["candidate", "the explorer suspects", "k-violet", "c-violet"], ["repro", "2 of 2, fresh instance", "k-amber", "c-amber"], ["scrub", "names where, never what", "k-red", "c-red"], ["GitHub issue", "with its RED test", "k-green", "c-green"]];
    const fw = 170, fg = 30, fy3 = y3 + 68;
    F.forEach(([t, sub, cls, tc], i) => {
      const x = 48 + i * (fw + fg);
      s += rect(x, fy3, fw, 50, cls, 10);
      s += text(x + fw / 2, fy3 + 21, t, `tb ${tc}`, "middle");
      s += text(x + fw / 2, fy3 + 39, sub, "cap", "middle");
      if (i < 3) s += arrow([[x + fw + 3, fy3 + 25], [x + fw + fg - 3, fy3 + 25]], i === 2 ? "ar-g" : "ar");
    });
    const ly = y3 + 142;
    s += rect(48, ly, 380, 46, "sunken", 10);
    s += text(62, ly + 19, `${m(".argus/live.env")}: kept from every agent`, "cap");
    s += text(62, ly + 36, `a command gets ${m("ARGUS_SECRET_&lt;NAME&gt;")}, never the text`, "cap");
    s += rect(448, ly, 240, 46, "sunken", 10);
    s += text(462, ly + 19, `secret ledger, ${m("0600")}`, "cap");
    s += text(462, ly + 36, "what the run met; kept by down", "cap");
    s += arrow([[533, ly - 2], [533, fy3 + 52]], "ar-b");
    // scrub reads the env file's values too (the configuration's secrets), never printing one
    s += arrow([[400, ly - 2], [400, ly - 11], [470, ly - 11], [470, fy3 + 52]], "ar-b");
    s += lines(704, ly + 19, [`${b("ledger incomplete,", "tb c-red")}`, "gone or damaged: nothing filed"], "cap", 17);

    // ---- limits
    const y4 = y3 + h3 + 20;
    s += card(32, y4, 856, 122, "k-red", 14);
    s += iconTile("shield", 44, y4 + 16, "red", 34);
    s += text(90, y4 + 30, b("Defence in depth, not a sandbox", "tb c-red"), "t");
    s += lines(90, y4 + 54, [
      "· Process groups bound every kill and listing: a process that leaves its group is neither killed nor listed.",
      "· The egress check samples, and lists no process inside a container.",
      "· An explorer's wrapper token is in the process list while a pw call runs: the lane assumes a single-user machine.",
      `· The full list: ${m("plugins/sapu/skills/journey/live.md")}, section Known limits.`,
    ], "cap", 18);
    return s;
  },
};
