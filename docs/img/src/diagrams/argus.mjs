import { readFileSync } from "node:fs";
import { card, rect, text, lines, arrow, iconTile, brandTile, chip, badge, m, b, c, tw } from "../lib.mjs";
const A11Y = JSON.parse(readFileSync(new URL("../a11y/argus.json", import.meta.url), "utf8"));

export default {
  h: 1040,
  ...A11Y,
  eyebrow: "AUTONOMOUS QA · /argus",
  heading: "One bounded QA cycle",
  sub: "Hunt bugs, business-rule breaks, insider fraud and rendered-surface defects on the live dev app. Test, never fix.",
  body() {
    let s = "";
    s += card(32, 128, 856, 46, "k-blue", 12);
    s += iconTile("doc", 44, 134, "blue", 34);
    s += text(90, 156, `${b("Reads")}  profile ${m(".claude/sapu/argus.md")} + ${m(".argus/config.yml")} (repo, URLs, seeded accounts, scope, limits)`, "t");

    // council
    const y = 196, lw = 316, h = 444;
    s += card(32, y, lw, h, "card", 14);
    s += brandTile("users", 48, y + 16, 36);
    s += text(96, y + 32, "Council of Five", "ttl");
    s += text(96, y + 50, "each lens owes an output", "cap");
    const lenses = [
      ["U", "User", "interrupted flow", null],
      ["PM", "PM", "rule + money exposure", null],
      ["QA", "Senior QA", "boundaries, races", null],
      ["A", "Auditor", "insider fraud", ["runs every cycle", "amber"]],
      ["C", "Curator", "rendered surface", ["live mode only · measured", "blue"]],
    ];
    lenses.forEach(([k, n, what, tag], i) => {
      const yy = y + 76 + i * 62;
      s += rect(48, yy, lw - 32, 54, "sunken", 10);
      s += `<circle cx="70" cy="${yy + 27}" r="13" class="tile-violet"/>` + text(70, yy + 31, k, "chipt c-violet", "middle");
      s += text(92, yy + (tag ? 22 : 32), `${b(n)}${c(" — ", "muted")}${what}`, "t");
      if (tag) s += text(92, yy + 41, tag[0], `cap c-${tag[1]}`);
    });
    s += text(48, y + h - 22, `${b("+ six bypass classes A–F")}, every cycle`, "t");

    // cycle
    const cx0 = 32 + lw + 16, cw = 888 - cx0;
    s += card(cx0, y, cw, h, "card", 14);
    s += brandTile("refresh", cx0 + 16, y + 16, 36);
    s += text(cx0 + 64, y + 32, "The cycle", "ttl");
    s += text(cx0 + 64, y + 50, "eleven phases · each owes an artifact", "cap");
    const P = [
      ["ORIENT", "preflight passes"], ["SELECT", "ranked area to probe"], ["INTAKE", "sapu / forge residue"], ["CHARTER", "plan + assumptions first"],
      ["EXECUTE", "probe log + tier"], ["OBSERVE", "read state back"], ["MINIMIZE", "strip to minimal repro"], ["TRIAGE", "candidates + refutation"],
      ["REPORT", "file issues (gated)"], ["PERSIST", "journal + fingerprints"], ["ROTATE", "pin next cycle's lane"],
    ];
    const colW = (cw - 48) / 2;
    P.forEach(([n, what], i) => {
      const col = i < 6 ? 0 : 1, row = i < 6 ? i : i - 6;
      const x = cx0 + 16 + col * (colW + 16), yy = y + 76 + row * 60;
      s += rect(x, yy, colW, 50, "sunken", 10);
      s += badge(x + 22, yy + 25, String(i + 1), 12);
      s += text(x + 44, yy + 21, n, "tb");
      s += text(x + 44, yy + 39, what, "cap");
    });
    // ROTATE loops back
    const lx = cx0 + 16 + colW + 16, ly = y + 76 + 4 * 60 + 25;
    s += text(lx + 12, y + 76 + 5 * 60 + 30, "one invocation = one bounded cycle", "cap c-violet");

    // evidence + output
    const ey = y + h + 20, eh = 166;
    s += card(32, ey, 520, eh, "card", 14);
    s += text(48, ey + 30, "The law of evidence", "ttl");
    const T = [["T1", "observed — wire / DB / DOM", "green"], ["T2", "a command or test you ran", "blue"], ["T3", "read in source at a commit", "violet"], ["T4", "inferred from T1–T3", "neutral"]];
    T.forEach(([k, what, kind], i) => {
      const yy = ey + 46 + i * 26;
      s += chip(48, yy, k, kind)[0] + text(98, yy + 15, what, "t");
    });
    s += rect(330, ey + 46, 206, 98, "k-amber", 10);
    s += text(346, ey + 72, "S1 / S2 need", "tb c-amber");
    s += text(346, ey + 92, "≥ 1 T1 item", "tb c-amber");
    s += text(346, ey + 122, "falsify before filing", "cap");

    s += card(568, ey, 320, eh, "k-green", 14);
    s += iconTile("flag", 584, ey + 16, "green", 34);
    s += text(630, ey + 38, "Output", "ttl");
    s += lines(584, ey + 76, ["· de-duplicated GitHub issues", "· the root cause fingerprinted", "· one defect per issue", `· state under ${m(".argus/")}`], "t", 21);

    // hard limits
    const hy = ey + eh + 20;
    s += card(32, hy, 856, 168, "k-red", 14);
    s += iconTile("stop", 44, hy + 16, "red", 34);
    s += text(90, hy + 30, `${b("Hard limits", "tb c-red")}`, "t");
    s += lines(90, hy + 54, [
      "· You test; you don't fix — no product-code edits, commits or PRs.",
      "· Asked to fix mid-cycle → end the cycle first, then hand to /forge in a separate session.",
      "· Dev / local only, seeded accounts only — never production, never real customer or employee data.",
      "· mode=static (servers down) caps every severity at S3 and needs a reachability chain.",
      "· A subagent returns a candidate, never a finding — the orchestrator re-runs the repro itself.",
      "· File only what you'd bet 4:1 a maintainer reproduces — a wrong issue gets implemented.",
    ], "cap", 18);
    return s;
  },
};
