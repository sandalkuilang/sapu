import { readFileSync } from "node:fs";
import { card, rect, text, lines, arrow, iconTile, brandTile, chip, chipsWrap, legend, m, b, c } from "../lib.mjs";
const A11Y = JSON.parse(readFileSync(new URL("../a11y/smoke.json", import.meta.url), "utf8"));

/** A node: a rounded box, a bold title and up to two caption lines (raw, already escaped). */
const node = (x, y, w, h, title, caps, cls = "sunken", tc = "") => {
  let s = rect(x, y, w, h, cls, 10);
  s += text(x + w / 2, y + 21, title, `tb${tc ? ` ${tc}` : ""}`, "middle");
  caps.forEach((t, i) => (s += text(x + w / 2, y + 39 + i * 16, t, "cap", "middle")));
  return s;
};

export default {
  h: 1498,
  ...A11Y,
  eyebrow: "JOURNEY LANE · /journey smoke",
  heading: "One smoke cycle, from a path to a pull request",
  sub: "A generated Playwright suite that your CI runs with no LLM. The lane proposes every change; you merge or close it.",
  body() {
    let s = "";
    s += legend(32, 136, [["flow", "calls"], ["produces", "proposes"], ["reads", "reads CI"]]);

    // ---- 1. in the lane
    const y1 = 162, h1 = 178;
    s += card(32, y1, 856, h1, "card", 14);
    s += brandTile("refresh", 48, y1 + 16, 36);
    s += text(96, y1 + 32, "In the lane", "ttl");
    s += text(96, y1 + 50, `the orchestrator, from the main session · an instance of its own · ${m("argus-live.mjs")}`, "cap");
    const A = [
      ["plan", [m("smoke plan"), "rank · capture · keep"], "sunken", ""],
      ["capture", [m("ui-explorer"), `${m("path: wanted")}`], "k-violet", "c-violet"],
      ["admit", [m("smoke admit"), "2 runs: fresh, then used"], "sunken", ""],
      ["re-run", [m("smoke run"), "seeded order · --perf"], "sunken", ""],
      ["propose", [m("smoke propose"), "scrub every file first"], "k-green", "c-green"],
    ];
    const nw = 152, ng = (824 - 5 * nw) / 4, ny = y1 + 72;
    A.forEach(([t, caps, cls, tc], i) => {
      const x = 48 + i * (nw + ng);
      s += node(x, ny, nw, 62, t, caps, cls, tc);
      if (i < 4) s += arrow([[x + nw + 2, ny + 31], [x + nw + ng - 2, ny + 31]], i === 3 ? "ar-g" : "ar");
    });
    s += text(48, y1 + h1 - 16, `${b("A path", "tb")} is a short, fixed list of actions that ends in an expectation proving the journey's goal. ${b("Admitted", "tb")} only after both runs hold.`, "cap");

    // ---- 2. your repo
    const y2 = y1 + h1 + 26, h2 = 136;
    s += card(32, y2, 856, h2, "card", 14);
    s += brandTile("pr", 48, y2 + 16, 36);
    s += text(96, y2 + 32, "Your repo: one pull request per proposal", "ttl");
    s += text(96, y2 + 50, `on an ${m("argus/")} branch · labelled agent-filed · sapu never merges it`, "cap");
    s += chipsWrap(48, y2 + 66, [["journeys/*.json", "neutral", { mono: true }], ["*.spec.ts", "neutral", { mono: true }], ["package-lock.json", "neutral", { mono: true }], ["quarantine.json", "neutral", { mono: true }], ["known/", "neutral", { mono: true }], ["changes.jsonl", "neutral", { mono: true }]], 470)[0];
    s += rect(540, y2 + 30, 332, 76, "sunken", 10);
    s += text(554, y2 + 52, `${b("Merge", "tb c-green")} = accepted.`, "t");
    s += text(554, y2 + 72, `${b("Close", "tb c-red")} = rejected, remembered by digest,`, "t");
    s += text(554, y2 + 90, "and never proposed again.", "t");
    s += arrow([[48 + 4 * (nw + ng) + nw / 2, ny + 64], [48 + 4 * (nw + ng) + nw / 2, y2 - 2]], "ar-g");

    // ---- 3. in CI
    const y3 = y2 + h2 + 26, h3 = 226;
    s += card(32, y3, 856, h3, "card", 14);
    s += brandTile("play", 48, y3 + 16, 36);
    s += text(96, y3 + 32, "In CI: your workflow, on every pull request", "ttl");
    s += text(96, y3 + 50, `${m("argus-smoke.yml")} · read-only token · actions pinned to SHAs · a fork's pull request runs nothing`, "cap");
    const jy = y3 + 70, jh = 108;
    const J = [
      [48, 330, "test", "k-blue", "c-blue"],
      [392, 136, "msedge", "sunken", ""],
      [542, 136, "quarantine", "sunken", ""],
      [692, 180, "baseline", "k-amber", "c-amber"],
    ];
    J.forEach(([x, w, t, cls, tc]) => {
      s += rect(x, jy, w, jh, cls, 10);
      s += text(x + 14, jy + 22, t, `tb${tc ? ` ${tc}` : ""}`);
    });
    s += text(112, jy + 22, "matrix · the pinned container", "cap");
    s += chipsWrap(62, jy + 34, [["chromium", "blue", { mono: true }], ["firefox", "blue", { mono: true }], ["webkit", "blue", { mono: true }], ["chromium-&lt;w&gt;", "neutral", { mono: true }], ["a11y", "neutral", { mono: true }], ["i18n", "neutral", { mono: true }]], 304, 6, 26)[0];
    s += lines(406, jy + 44, ["Edge on the", "plain runner:", "no screenshots"], "cap", 16);
    s += lines(556, jy + 44, ["@quarantine tests,", "run but never", "gating"], "cap", 16);
    s += lines(706, jy + 44, ["only by dispatch:", "writes baselines", "(missing | changed)"], "cap", 16);
    s += text(48, y3 + h3 - 18, `Every job uploads ${m("test-results/")} for 7 days. The suite runs ${m("--shuffle")}, retries once, and writes no baseline.`, "cap");

    s += arrow([[200, y2 + h2 + 2], [200, y3 - 2]]);
    s += text(212, y2 + h2 + 18, "runs on every pull request", "cap");
    // ---- 4. what a break is
    const y4 = y3 + h3 + 26, rows = 7, rh = 38, h4 = 74 + rows * rh + 12;
    s += arrow([[200, y3 + h3 + 2], [200, y4 - 2]], "ar-b");
    s += text(212, y3 + h3 + 18, `${m("smoke ci")} downloads the results`, "cap");
    s += card(32, y4, 856, h4, "card", 14);
    s += brandTile("search", 48, y4 + 16, 36);
    s += text(96, y4 + 32, "Back in the lane: what a break is", "ttl");
    s += text(96, y4 + 50, `${m("smoke ci")} reads the run; a script, never the explorer's word, decides`, "cap");
    const R = [
      ["flaky on a push to the base branch", "flake", "amber", "quarantine PR · tracking issue · still runs"],
      ["flaky only on a pull request's head", "flaky-new", "amber", "a comment there · never quarantined"],
      ["a target matches nothing or several", "UI changed", "green", "heal-mode explorer · expectations hold twice · heal PR"],
      ["an expectation fails twice, or no control", "bug", "red", "regression candidate · 2 of 2 · scrub · issue"],
      ["failed on every attempt in CI, holds on Chrome", "ci-only", "red", "needs-owner issue with the run's link"],
      ["a screenshot or ARIA snapshot differs", "your call", "violet", `${m("smoke ci")} shows the diff · ${m("--ids")} re-baselines`],
      ["a baseline is missing", "not reviewed", "blue", "the baseline run (below)"],
    ];
    R.forEach(([ev, verdict, kind, next], i) => {
      const yy = y4 + 70 + i * rh;
      s += rect(48, yy, 824, rh - 6, "sunken", 8);
      s += text(62, yy + 21, ev, "t");
      s += chip(372, yy + 5, verdict, kind, { dot: true })[0];
      s += arrow([[482, yy + 16], [502, yy + 16]]);
      s += text(512, yy + 21, next, "t");
    });

    // ---- 5. the baseline run
    const y5 = y4 + h4 + 26, h5 = 168;
    s += arrow([[200, y4 + h4 + 2], [200, y5 - 2]]);
    s += text(212, y4 + h4 + 18, "a missing baseline starts it", "cap");
    s += card(32, y5, 856, h5, "card", 14);
    s += brandTile("layers", 48, y5 + 16, 36);
    s += text(96, y5 + 32, "The baseline run", "ttl");
    s += text(96, y5 + 50, "only CI's baseline job, on the pinned container, writes a screenshot or an ARIA baseline", "cap");
    const B = [
      ["red first run", ["baseline-missing", "nothing to adopt"], "k-red", "c-red"],
      ["dispatch", [m("smoke baseline"), `${m("--from-run")} &lt;id&gt;`], "sunken", ""],
      ["baseline job", ["container projects", "writes the files"], "k-amber", "c-amber"],
      ["adopt", [m("smoke baseline"), "prune · scrub · commit"], "sunken", ""],
      ["review", ["PR image view", "merge = accepted"], "k-green", "c-green"],
    ];
    const by = y5 + 72;
    B.forEach(([t, caps, cls, tc], i) => {
      const x = 48 + i * (nw + ng);
      s += node(x, by, nw, 62, t, caps, cls, tc);
      if (i < 4) s += arrow([[x + nw + 2, by + 31], [x + nw + ng - 2, by + 31]], i === 3 ? "ar-g" : "ar");
    });
    s += text(48, y5 + h5 - 16, `A baseline that conflicts with the base branch is dropped and regenerated, never merged. ${m("msedge")} takes no screenshot.`, "cap");

    // ---- limits
    const y6 = y5 + h5 + 26, h6 = 122;
    s += card(32, y6, 856, h6, "k-red", 14);
    s += iconTile("stop", 44, y6 + 16, "red", 34);
    s += text(90, y6 + 30, b("Hard limits", "tb c-red"), "t");
    s += lines(90, y6 + 54, [
      "· No LLM runs when the suite runs; the generator writes path data as JSON literals only.",
      "· A normal CI run never writes a baseline, and a heal is never applied while a test runs.",
      "· Every change is a pull request that sapu never merges; text from issues, docs and CI is fenced data.",
      "· The suite drives loopback only. Fences are hygiene: the gates and your merge are the boundary.",
    ], "cap", 18);
    return s;
  },
};
