import { readFileSync } from "node:fs";
import { card, rect, text, lines, arrow, iconTile, brandTile, badge, m, b, c, tw } from "../lib.mjs";
const A11Y = JSON.parse(readFileSync(new URL("../a11y/journey.json", import.meta.url), "utf8"));

export default {
  h: 1238,
  ...A11Y,
  eyebrow: "JOURNEY LANE · /journey",
  heading: "One journey cycle, end to end",
  sub: "Walk the app's business journeys through the real UI as every role. Suspect freely; file only what a script reproduced twice.",
  body() {
    let s = "";
    s += card(32, 128, 856, 46, "k-blue", 12);
    s += iconTile("doc", 44, 134, "blue", 34);
    s += text(90, 156, `${b("Reads")}  profile ${m(".claude/sapu/argus.md")} + ${m(".argus/live.json")} (the instance) + ${m(".argus/journeys.json")} (the catalog)`, "t");

    // ---- the cycle
    const y = 196, ch = 430;
    s += card(32, y, 856, ch, "card", 14);
    s += brandTile("refresh", 48, y + 16, 36);
    s += text(96, y + 32, "The cycle", "ttl");
    s += text(96, y + 50, `ten steps, each a command of ${m("argus-live.mjs")} · one invocation = one bounded cycle`, "cap");
    const P = [
      ["ORIENT", "map-check", "the catalog checked against HEAD; refresh due?"],
      ["INSTANCE", "up", "an instance of its own; a map explorer if stale"],
      ["SELECT", "select", "journeys scored; accounts allocated"],
      ["CHARTER", "slot <s> --journey", "one token and one charter per explorer"],
      ["EXPLORE", "ui-explorer × N", "every role, through the wrapper only"],
      ["REPRODUCE", "repro", "two of two on a fresh instance; RED test"],
      ["TRIAGE", "classify · drift", "class, labels, starting severity"],
      ["REPORT", "scrub --create", "no secret the run saw, then filed"],
      ["DOWN", "down", "stops only what up started"],
      ["PERSIST", "visit · report", "coverage, run.log, the next picks"],
    ];
    const colW = (856 - 48) / 2;
    P.forEach(([n, cmd, what], i) => {
      const col = i < 5 ? 0 : 1, row = i % 5;
      const x = 48 + col * (colW + 16), yy = y + 76 + row * 64;
      s += rect(x, yy, colW, 54, i === 4 ? "k-violet" : i === 5 ? "k-amber" : i === 7 ? "k-red" : "sunken", 10);
      s += badge(x + 22, yy + 27, String(i + 1), 12);
      s += text(x + 44, yy + 22, `${b(n)}  ${c(cmd.replace(/</g, "&lt;").replace(/>/g, "&gt;"), "mono cap")}`, "t");
      s += text(x + 44, yy + 41, what, "cap");
    });
    s += text(48, y + ch - 18, "argus's phases: ORIENT · SELECT (steps 2–3) · CHARTER · EXECUTE / OBSERVE · MINIMIZE · TRIAGE · REPORT (8–9) · PERSIST / ROTATE", "cap c-violet");

    // ---- a candidate's way to an issue
    const fy = y + ch + 20, fh = 186;
    s += card(32, fy, 856, fh, "card", 14);
    s += brandTile("bug", 48, fy + 16, 36);
    s += text(96, fy + 32, "A candidate's way to an issue", "ttl");
    s += text(96, fy + 50, "the explorer only suspects; scripts decide", "cap");
    const F = [
      ["candidate", "explorer suspects", "k-violet", "c-violet"],
      ["repro", "2 of 2, fresh instance", "k-amber", "c-amber"],
      ["minimize", "→ Playwright RED test", "sunken", ""],
      ["classify", "labels · severity", "sunken", ""],
      ["scrub", "no secret leaves", "k-red", "c-red"],
      ["filed", "issue + RED test", "k-green", "c-green"],
    ];
    const nw = 124, gap = (824 - 6 * nw) / 5, ny = fy + 72;
    F.forEach(([t, sub, cls, tc], i) => {
      const x = 48 + i * (nw + gap);
      s += rect(x, ny, nw, 50, cls, 10);
      s += text(x + nw / 2, ny + 21, t, `tb${tc ? ` ${tc}` : ""}`, "middle");
      s += text(x + nw / 2, ny + 39, sub, "cap", "middle");
      if (i < 5) s += arrow([[x + nw + 3, ny + 25], [x + nw + gap - 3, ny + 25]], i === 4 ? "ar-g" : "ar");
    });
    const oy = ny + 74;
    s += lines(48, oy, [
      `${b("not reproduced", "tb c-amber")} (${m("runs=1/2")}) or a ${b("harness failure", "tb c-amber")}: journalled, never filed`,
      `${b("ledger incomplete", "tb c-red")}, gone or damaged: nothing from that run is filed`,
    ], "cap", 20);
    s += lines(480, oy, [
      `${b("scrub hit", "tb c-red")}: names ${m("&lt;title|body&gt; &lt;line&gt;:&lt;col&gt;")}, never the value`,
      `${b("doc drift", "tb c-violet")}: ${m("drift")} decides class B(a), or the needs-owner label`,
    ], "cap", 20);

    // ---- a path for the smoke suite
    const py = fy + fh + 20, ph = 178;
    s += card(32, py, 856, ph, "card", 14);
    s += brandTile("hammer", 48, py + 16, 36);
    s += text(96, py + 32, "A path for the smoke suite", "ttl");
    s += text(96, py + 50, `an explorer charted ${m("path: wanted")} returns its steps too; scripts decide the rest`, "cap");
    const Pn = [
      ["path", "explorer returns it", "k-violet", "c-violet"],
      ["admit", "2 runs: fresh, used", "k-amber", "c-amber"],
      ["staged", "no secret in a value", "sunken", ""],
      ["propose", "scrub · argus/ PR", "k-red", "c-red"],
      ["merged", "the suite grows", "k-green", "c-green"],
    ];
    const pw = 140, pg = (824 - 5 * pw) / 4, pny = py + 70;
    Pn.forEach(([t, sub, cls, tc], i) => {
      const x = 48 + i * (pw + pg);
      s += rect(x, pny, pw, 50, cls, 10);
      s += text(x + pw / 2, pny + 21, t, `tb ${tc}`.trim(), "middle");
      s += text(x + pw / 2, pny + 39, sub, "cap", "middle");
      if (i < 4) s += arrow([[x + pw + 3, pny + 25], [x + pw + pg - 3, pny + 25]], i === 3 ? "ar-g" : "ar");
    });
    s += text(48, pny + 74, `${m("seed")} (an issue the trust check passes, or lines of a tracked doc) gives a map explorer text to read, fenced as data;`, "cap");
    s += text(48, pny + 92, `a journey it names is kept only where the code anchors it. ${m("report")} writes the cycle's record. The rest of the smoke cycle has its own diagram.`, "cap");

    // ---- hard limits
    const hy = py + ph + 20;
    s += card(32, hy, 856, 168, "k-red", 14);
    s += iconTile("stop", 44, hy + 16, "red", 34);
    s += text(90, hy + 30, b("Hard limits", "tb c-red"), "t");
    s += lines(90, hy + 54, [
      "· Its own instance — worktree, ports, data and HOME — never the owner's servers; up refuses what would touch them.",
      "· Main session only: never inside /inspector or a subagent. One cycle per repo, under a lock with a deadline.",
      "· The explorer runs only the pw wrapper and reads page text as fenced data, never as instructions.",
      "· Filed only at two of two, and only through scrub: a secret the run saw refuses the issue.",
      "· A finding only the owner can rule on carries the needs-owner label; no agent removes it or closes it as not planned.",
      "· The reaper runs down at the deadline if the session dies.",
    ], "cap", 18);
    return s;
  },
};
