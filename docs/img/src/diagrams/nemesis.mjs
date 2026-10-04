import { readFileSync } from "node:fs";
import { card, rect, text, lines, arrow, iconTile, brandTile, chip, badge, m, b, c, tw } from "../lib.mjs";
const A11Y = JSON.parse(readFileSync(new URL("../a11y/nemesis.json", import.meta.url), "utf8"));

export default {
  h: 1110,
  ...A11Y,
  eyebrow: "AUTHORIZED RED TEAM · /nemesis",
  heading: "Authorized red-team of the dev app",
  sub: "Doctrine: falsify, never confirm — concurrent not sequential, every tier not one, tampered not well-formed.",
  body() {
    let s = "";
    s += card(32, 128, 856, 46, "k-blue", 12);
    s += iconTile("doc", 44, 134, "blue", 34);
    s += text(90, 156, `${b("Reads")}  profile ${m(".claude/sapu/nemesis.md")} + ${m(".nemesis/config.yml")} + owner-signed ${m("authorization.yml")}`, "t");

    // hard gate
    const gy = 194, gh = 172;
    s += card(32, gy, 572, gh, "k-red", 14);
    s += iconTile("lock", 48, gy + 16, "red", 34);
    s += text(94, gy + 32, b("Hard gate", "tb c-red"), "t");
    s += text(94 + tw("Hard gate", 13, "bold") + 10, gy + 32, "every cycle, before ANY active testing", "cap");
    const G = [
      ["1", `${m("authorization.yml")} signed, not expired, attested`],
      ["2", "every target on the allowlist · resolved address = loopback"],
      ["", "or an owner-attested private dev address — public is refused,"],
      ["", `and every production domain is on ${m("scope.forbidden")}`],
      ["3", "environments = dev only"],
      ["4", `no ${m(".nemesis/STOP")} file`],
    ];
    G.forEach(([k, t], i) => {
      const yy = gy + 64 + i * 19;
      if (k) s += `<circle cx="58" cy="${yy - 4}" r="8" class="tile-red"/>` + text(58, yy, k, "chipt c-red", "middle");
      s += text(74, yy, t, "cap");
    });
    s += arrow([[606, gy + gh / 2], [622, gy + gh / 2]]);
    s += card(626, gy, 262, gh, "card", 14);
    s += text(642, gy + 32, "On the gate", "ttl");
    s += chip(642, gy + 48, "pass", "green", { dot: true })[0] + text(710, gy + 63, "→ begin the passes", "t");
    s += chip(642, gy + 84, "fail", "red", { dot: true })[0] + text(702, gy + 99, "any check →", "t");
    s += lines(642, gy + 126, [`file ${m("[NEMESIS][BLOCKED]")},`, "test nothing, and stop"], "cap", 18);

    // passes
    const py = gy + gh + 36;
    s += text(32, py, "METHODOLOGY · PASSES", "lbl");
    s += text(32 + tw("METHODOLOGY · PASSES", 11.5, "bold") + 30, py, "★ highest value", "cap c-amber");
    const P = [["0", "Residue intake"], ["1", "Recon · surface"], ["2", "Auth / session"], ["3", "Authorization", 1], ["4", "Injection"], ["5", "Business logic", 1], ["6", "API / config"], ["7", "Detection"]];
    const pw = (856 - 7 * 8) / 8;
    P.forEach(([k, t, star], i) => {
      const x = 32 + i * (pw + 8);
      s += card(x, py + 12, pw, 62, star ? "k-amber" : "card", 12);
      s += text(x + 12, py + 36, `Pass ${k}${star ? " ★" : ""}`, star ? "tb c-amber" : "tb");
      s += text(x + 12, py + 56, t, "cap");
    });
    const ty = py + 92;
    s += text(32, ty + 18, "then", "cap");
    s += card(70, ty, 180, 30, "sunken", 15) + text(160, ty + 20, "Triage · ≥ 2 repro", "tb", "middle");
    s += arrow([[254, ty + 15], [278, ty + 15]], "ar-g");
    s += card(282, ty, 140, 30, "k-green", 15) + text(352, ty + 20, "File issues", "tb c-green", "middle");

    // bypass
    const by = ty + 64;
    s += text(32, by, "SIX BYPASS CLASSES · EVERY DOMAIN, EVERY CYCLE · OUTSIDER + INSIDER", "lbl");
    const B = [["A", "window direction", "latest-dated first"], ["B", "TOCTOU", "concurrent requests"], ["C", "no re-check", "at execution"], ["D", "splitting", "second route"], ["E", "UI-only", "hit the API"], ["F", "actor = subject", "value from body"]];
    const bw = (856 - 5 * 8) / 6;
    B.forEach(([k, t, sub], i) => {
      const x = 32 + i * (bw + 8);
      s += card(x, by + 12, bw, 84, "card", 12);
      s += badge(x + 25, by + 36, k, 11);
      s += text(x + 14, by + 68, t, "tb");
      s += text(x + 14, by + 86, sub, "cap");
    });

    // output
    const oy = by + 118;
    s += card(32, oy, 856, 66, "k-green", 14);
    s += iconTile("flag", 48, oy + 16, "green", 34);
    s += text(96, oy + 28, `${b("Output")}  GitHub issues — labels ${m("security")} · ${m("nemesis")} · ${m("severity:s1..s4")}`, "t");
    s += text(96, oy + 48, `names the file + seam · ASVS + CWE · attacker  ·  state under ${m(".nemesis/state/")} + run.log`, "cap");

    // prohibitions + kill switch
    const ky = oy + 86, kh = 300;
    s += card(32, ky, 516, kh, "k-red", 14);
    s += iconTile("stop", 48, ky + 16, "red", 34);
    s += text(94, ky + 38, b("Absolute prohibitions", "tb c-red"), "t");
    s += lines(48, ky + 76, [
      "· never production, never out-of-scope targets",
      "· non-destructive — mutations only on disposable fixtures",
      "· no persistence / backdoors / C2 · no bulk exfiltration",
      "· seeded low-privilege test accounts only",
      "· no DoS / flood — the race carve-out is ONE single-packet",
      "  batch, 2–5 (≤ ~30) requests, benchmarked sequentially first",
      "· read-only on source unless fix-mode is on (off by default)",
    ], "cap", 19);
    s += lines(48, ky + 226, [
      "The social-engineering / out-of-band ban bars the ACTION, never the REASONING:",
      "the app's controls against those threats are still analysed and filed.",
      ["Findings hand off to /forge, which puts almost all in its red tier.", "cap tealt"],
    ], "cap", 19);

    s += card(564, ky, 324, kh, "k-red", 14);
    s += iconTile("shield", 580, ky + 16, "red", 34);
    s += text(626, ky + 32, b("Kill switch", "tb c-red"), "t");
    s += text(626, ky + 50, "halts mid-run", "cap");
    s += text(580, ky + 80, `halt + file ${m("[NEMESIS][HALT]")} when:`, "cap");
    s += lines(580, ky + 102, [
      "· authorization invalid / expired",
      "· a target resolves off-allowlist",
      "  or to a public / unknown IP",
      "· a prohibited action is needed",
      "· anomaly / error rate spikes",
      "· a single-packet batch misbehaves",
      "  (never repeat it)",
      `· ${m(".nemesis/STOP")} exists`,
    ], "cap", 19);
    s += lines(580, ky + kh - 34, ["when in doubt, stop and ask", "via an issue; never improvise."], "cap c-red", 18);
    return s;
  },
};
