import { readFileSync } from "node:fs";
import { card, rect, text, lines, arrow, iconTile, brandTile, chip, badge, m, b, c, tw } from "../lib.mjs";
const A11Y = JSON.parse(readFileSync(new URL("../a11y/momus.json", import.meta.url), "utf8"));

export default {
  h: 1044,
  ...A11Y,
  eyebrow: "RELEASE READINESS · /momus",
  heading: "Release-readiness auditor",
  sub: "One bounded pass across a fixed checklist. Prove it is not ready; a written report is the deliverable.",
  body() {
    let s = "";
    s += card(32, 128, 856, 46, "k-blue", 12);
    s += iconTile("doc", 44, 134, "blue", 34);
    s += text(90, 156, `${b("Reads")}  profile ${m(".claude/sapu/momus.md")} + ${m(".momus/config.yml")}  ·  ${m(".momus/ledger.json")}`, "t");

    // the pass
    s += text(32, 210, "THE PASS", "lbl");
    const steps = ["ORIENT", "SCOPE", "READ &amp; PROBE", "CROSS-CHECK", "FALSIFY", "REPORT", "PERSIST"];
    const sw = [86, 82, 128, 120, 94, 90, 92];
    const gap = (856 - sw.reduce((a, v) => a + v, 0)) / 6;
    let x = 32;
    steps.forEach((st, i) => {
      s += rect(x, 222, sw[i], 34, "card", 17);
      s += text(x + sw[i] / 2, 244, st, "chipt ink", "middle");
      if (i < 6) s += arrow([[x + sw[i] + 3, 239], [x + sw[i] + gap - 3, 239]]);
      x += sw[i] + gap;
    });

    // nine areas
    s += text(32, 296, "NINE AREAS (A–I) · A SECURITY LENS ON EACH: OUTSIDER + INSIDER", "lbl");
    const A = [
      ["A", "Tenant isolation", "tenant id from session?", "+ personal-data reads"],
      ["B", "Auth &amp; authz", "guard at every route", "+ business-process map"],
      ["C", "Data &amp; migrations", "drift · drops · uniqueness", "delete behaviour"],
      ["D", "Errors &amp; leakage", "raw errors · empty catch", "un-transacted writes"],
      ["E", "Config &amp; secrets", "env fails loud? · CIS", "committed secrets"],
      ["F", "Resilience", "partial writes · races", "silent-wrong-number"],
      ["G", "Test coverage", "flows with zero tests", "direct-API proof"],
      ["H", "Ops readiness", "isolation · logs · rollback", "breach detection"],
      ["I", "Contracts &amp; health", "producer/consumer drift", "code health = LOW"],
    ];
    const aw = (856 - 2 * 14) / 3, ah = 84;
    A.forEach(([k, t, l1, l2], i) => {
      const ax = 32 + (i % 3) * (aw + 14), ay = 310 + Math.floor(i / 3) * (ah + 12);
      s += card(ax, ay, aw, ah, "card", 12);
      s += badge(ax + 28, ay + 28, k, 13);
      s += text(ax + 52, ay + 33, t, "tb");
      s += text(ax + 52, ay + 54, l1, "cap");
      s += text(ax + 52, ay + 72, l2, "cap");
    });

    // severity + evidence
    const y2 = 310 + 3 * (ah + 12) + 12;
    s += card(32, y2, 420, 168, "card", 14);
    s += text(48, y2 + 30, "Severity ladder", "ttl");
    const SV = [["BLOCKER", "red", "data leak / loss / unusable"], ["HIGH", "amber", "core flow broken"], ["MEDIUM", "blue", "has a workaround"], ["LOW", "neutral", "cosmetic / tech debt"]];
    SV.forEach(([k, kind, what], i) => {
      const yy = y2 + 46 + i * 28;
      s += chip(48, yy, k, kind)[0] + text(140, yy + 15, what, "t");
    });
    s += card(468, y2, 420, 168, "card", 14);
    s += text(484, y2 + 30, "Evidence → confidence", "ttl");
    s += text(484, y2 + 58, `${b("T1")} live · ${b("T2")} executed · ${b("T3")} source · ${b("T4")} inferred`, "t");
    s += text(484, y2 + 86, "→", "t");
    let cx = 504;
    for (const [k, kind] of [["CERTAIN", "green"], ["LIKELY", "blue"], ["SUSPECTED", "neutral"]]) {
      const [cs, cw] = chip(cx, y2 + 72, k, kind);
      s += cs;
      cx += cw + 6;
    }
    s += text(484, y2 + 124, "static caps at LIKELY", "cap");
    s += text(484, y2 + 144, "T4 is never BLOCKER", "cap");

    // deliverable
    const y3 = y2 + 168 + 20;
    s += card(32, y3, 856, 92, "k-green", 14);
    s += iconTile("doc", 48, y3 + 16, "green", 34);
    s += text(96, y3 + 30, `${b("Deliverable")}  a written report, every run`, "t");
    s += text(96, y3 + 52, "severity counts · findings worst-first (severity + confidence + standard + attacker) · unread areas · standards", "cap");
    s += text(96, y3 + 72, `Files GitHub issues only when separately asked  ·  state: ${m(".momus/")} ledger · run.log · report`, "cap");

    // rails
    const y4 = y3 + 92 + 20;
    s += card(32, y4, 856, 104, "k-red", 14);
    s += iconTile("stop", 48, y4 + 16, "red", 34);
    s += text(96, y4 + 30, b("Rails", "tb c-red"), "t");
    s += lines(96, y4 + 52, [
      "· You audit; you never fix — finish the report, then hand findings to /forge in a separate session.",
      "· Never write a ship / no-ship verdict — that decision belongs to whoever asked for the audit.",
      "· Never write the shared dev DB (writes use a throwaway test DB) · every BLOCKER / HIGH needs ≥ 1 T1 / T2.",
    ], "cap", 18);
    return s;
  },
};
