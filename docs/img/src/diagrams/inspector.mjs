import { readFileSync } from "node:fs";
import { card, rect, text, lines, arrow, iconTile, brandTile, chip, badge, legend, m, b, c, tw } from "../lib.mjs";
const A11Y = JSON.parse(readFileSync(new URL("../a11y/inspector.json", import.meta.url), "utf8"));

export default {
  h: 884,
  ...A11Y,
  eyebrow: "RELEASE SWEEP · /inspector",
  heading: "One sequenced release + security sweep",
  sub: "Three phases, each finished before the next starts, each on its own model and effort. Never parallel.",
  body() {
    let s = "";
    s += legend(32, 140, [["flow", "sequence (awaited)"], ["feeds", "feeds priority targets"], ["produces", "produces"], ["limit", "hard limit"]]);
    s += card(32, 162, 856, 46, "k-blue", 12);
    s += iconTile("lock", 44, 168, "blue", 34);
    s += text(90, 190, `${b("Step 0")}  ${m("sapu-contract.mjs check")} + wave-args  ·  momus, argus, nemesis profiles committed`, "t");

    const y = 236, w = 262, h = 210, g = 35;
    const P = [
      ["momus", "Opus / high", "doc", ["release-readiness baseline", "one read-only pass, areas A–I", "files nothing inside inspector"], "report + gap rows", "1"],
      ["argus", "Sonnet / high", "eye", ["QA hunt on that baseline", "one bounded cycle"], "files GitHub issues", "2"],
      ["nemesis", "Opus / high", "shield", ["red-team the live dev app", "runs last — most aggressive", "hard gate checked first"], "files GitHub issues", "3"],
    ];
    P.forEach(([n, model, ico, l, out, k], i) => {
      const x = 32 + i * (w + g);
      s += card(x, y, w, h, "card", 14);
      s += brandTile(ico, x + 16, y + 16, 36);
      s += text(x + 64, y + 32, n, "ttl mono");
      s += text(x + 64, y + 50, `phase ${k}`, "cap");
      s += chip(x + w - 16 - Math.round(tw(model, 11.5, "bold") + 20), y + 22, model, "violet")[0];
      s += lines(x + 16, y + 82, l, "cap", 19);
      if (n === "nemesis") s += text(x + 16, y + 82 + 3 * 19, "fail → the phase returns blocked", "cap c-red");
      s += rect(x + 16, y + h - 46, w - 32, 30, "k-green", 8);
      s += text(x + 28, y + h - 26, `→ ${out}`, "cap c-green");
      if (i < 2) s += arrow([[x + w + 5, y + 40], [x + w + g - 5, y + 40]]);
    });
    // feeds
    const fy = y + h + 26;
    s += arrow([[32 + w / 2, y + h + 2], [32 + w / 2, fy], [32 + w + g + w / 2, fy], [32 + w + g + w / 2, y + h + 6]], "ar-v", { r: 8 });
    s += arrow([[32 + w + g + w / 2, fy], [32 + 2 * (w + g) + w / 2, fy], [32 + 2 * (w + g) + w / 2, y + h + 6]], "ar-v");
    s += text(32 + w / 2 + 12, fy + 22, "momus's business-process gap rows → priority live targets for argus and nemesis", "cap c-violet");

    // security bar
    const sy = fy + 44;
    s += card(32, sy, 856, 60, "k-violet", 12);
    s += iconTile("shieldcheck", 44, sy + 13, "violet", 34);
    s += text(90, sy + 26, `${b("Security bar")}  appended to every phase prompt`, "t");
    s += text(90, sy + 45, "ASVS 5.0 · NIST SP 800-63B-4 · CIS · data-protection law · outsider + insider · known gaps from the security epic", "cap");

    // team review + combined result
    const ty = sy + 80, th = 150;
    s += card(32, ty, 420, th, "card", 14);
    s += text(48, ty + 28, "Scoped run only", "ttl");
    s += text(48 + tw("Scoped run only", 14, "bold") + 10, ty + 28, "read-only team review", "cap");
    const roles = [["product", "parallel"], ["ux", "parallel"], ["qa / tests", "alone, runs suites"]];
    roles.forEach(([r, sub], i) => {
      const x = 48 + i * 130 + (i === 2 ? 20 : 0);
      s += rect(x, ty + 48, 116, 58, "sunken", 10);
      s += text(x + 58, ty + 72, r, "tb", "middle");
      s += text(x + 58, ty + 92, sub, "cap", "middle");
    });
    s += arrow([[48 + 246 + 4, ty + 77], [48 + 280 - 4, ty + 77]]);
    s += text(48, ty + 132, "product and ux in parallel, then qa / tests alone", "cap");

    s += card(468, ty, 420, th, "k-green", 14);
    s += text(484, ty + 28, "One combined result", "ttl");
    s += text(484 + tw("One combined result", 14, "bold") + 10, ty + 28, "after nemesis (+ the team, if scoped)", "cap");
    s += lines(484, ty + 58, ["· momus report + severity counts", "· argus + nemesis issue numbers", "· security roll-up: attacker + ASVS IDs"], "t", 24);

    // rails
    const ry = ty + th + 20;
    s += card(32, ry, 856, 106, "k-red", 14);
    s += iconTile("stop", 44, ry + 16, "red", 34);
    s += text(90, ry + 30, `${b("Rails", "tb c-red")}  each phase keeps its own gates: momus evidence rules · argus ORIENT checks · nemesis authorization gate`, "t");
    s += lines(90, ry + 52, [
      "A phase its own gate stopped returns blocked (nemesis files [NEMESIS][BLOCKED]) and the sequence continues;",
      "a phase that returns nothing stops the sequence.",
      `inspector has no state or findings of its own — each phase keeps ${m(".momus/ .argus/ .nemesis/")}`,
    ], "cap", 18);
    return s;
  },
};
