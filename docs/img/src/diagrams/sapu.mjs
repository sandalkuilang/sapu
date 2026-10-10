import { readFileSync } from "node:fs";
import { card, rect, text, lines, arrow, iconTile, brandTile, chip, tier, badge, legend, headline, m, b, c, tw } from "../lib.mjs";

const A11Y = JSON.parse(readFileSync(new URL("../a11y/sapu.json", import.meta.url), "utf8"));
const X = 80, W = 808, R = X + W; // content column, right of the spine

function sectionHead(y, mark, title, note) {
  return badge(46, y - 5, mark) + headline(X, y, title, note);
}
const box = (x, y, w, h, title, subs, cls = "card", { mono = [] } = {}) =>
  card(x, y, w, h, cls, 12) +
  text(x + w / 2, y + 27, title, "tb", "middle") +
  subs.map((s, i) => text(x + w / 2, y + 47 + i * 17, s, mono.includes(i) ? "cap mono" : "cap", "middle")).join("");

export default {
  h: 1714,
  title: A11Y.title,
  desc: A11Y.desc,
  label: A11Y.label,
  eyebrow: "THE ORCHESTRATOR · /sapu",
  heading: "Sweep the backlog clean",
  sub: "PRs first (Phase A), then issues in parallel lanes (Phase B). Only the orchestrator merges.",
  body() {
    let s = "";
    s += legend(32, 140, [["flow", "flow"], ["loop", "fix / retry loop"], ["produces", "produces"], ["limit", "hard limit"], ["tier:green", ""], ["tier:yellow", ""], ["tier:red", "risk tier"]]);

    // spine
    const ys = { s0: 196, a: 314, b: 574, sess: 1276, fin: 1428 };
    s += `<line x1="46" y1="${ys.s0}" x2="46" y2="${ys.fin - 10}" class="rule" stroke-dasharray="2 5"/>`;

    // ---- Step 0
    s += sectionHead(ys.s0, "0", "Step 0 · Scope lock");
    s += card(X, ys.s0 + 16, W, 66, "k-blue", 12);
    s += iconTile("lock", X + 12, ys.s0 + 32, "blue", 34);
    s += text(X + 58, ys.s0 + 42, `${m("sapu-contract.mjs check")}  ·  gh account · git email · origin · allowed roots · HOME`, "t");
    s += text(X + 58, ys.s0 + 63, `then ${m("sweep hold")}: one /sapu session per repo, a second one stops here  ·  then read profile + policy`, "cap");

    // ---- Phase A
    const ay = ys.a;
    s += sectionHead(ay, "A", "Phase A · Drain every open PR", "one session");
    const ry = ay + 52, rh = 74;
    const cols = [[X, 112], [X + 140, 176], [X + 344, 150], [X + 522, 146], [X + 696, 112]];
    s += box(cols[0][0], ry, cols[0][1], rh, "inventory", ["open PRs"]);
    s += box(cols[1][0], ry, cols[1][1], rh, "classify each PR", ["READY · NEEDS-FIX · STALE", "DRAFT · NEEDS-AI"]);
    s += box(cols[2][0], ry, cols[2][1], rh, "review by tier", ["author ≠ reviewer"]);
    s += box(cols[3][0], ry, cols[3][1], rh, "merge gate", ["sapu-merge.sh"], "k-red", { mono: [0] });
    s += box(cols[4][0], ry, cols[4][1], rh, "merged", ["to base"], "k-green");
    for (let i = 0; i < 4; i++) {
      const xa = cols[i][0] + cols[i][1] + 4, xb = cols[i + 1][0] - 4;
      s += arrow([[xa, ry + rh / 2], [xb, ry + rh / 2]], i === 3 ? "ar-g" : "ar");
    }
    const cx1 = cols[1][0] + cols[1][1] / 2 + 30, cx2 = cols[2][0] + cols[2][1] / 2;
    s += arrow([[cx2, ry - 2], [cx2, ry - 16], [cx1, ry - 16], [cx1, ry - 4]], "ar-a");
    s += text(cx2 + 10, ry - 12, "NEEDS-FIX → fix + re-verify, same cycle rule as a lane", "cap c-amber");
    // not merged
    const nx = cols[1][0] + 40;
    s += arrow([[nx, ry + rh + 2], [nx, ry + rh + 44], [cols[2][0] + 96, ry + rh + 44]], "ar");
    s += card(cols[2][0] + 100, ry + rh + 20, R - (cols[2][0] + 100), 50, "sunken", 12);
    s += text(cols[2][0] + 116, ry + rh + 41, `${b("not merged")}  STALE: closed at classify`, "cap");
    s += text(cols[2][0] + 116, ry + rh + 59, "blocked (with the reason) when its fix cycles run out", "cap");
    s += text(R, ry + rh + 96, "then Phase B, in the same session while context is under the Phase A limit, else in a fresh one", "cap", "end");

    // ---- Phase B
    const by = ys.b;
    s += sectionHead(by, "B", "Phase B · Work open issues", "one lane per issue");
    const ly = by + 22;
    // triage
    s += card(X, ly + 30, 150, 120, "card", 12);
    s += text(X + 16, ly + 56, "inventory + triage", "tb");
    s += lines(X + 16, ly + 78, ["SKIP · DUPLICATE", "POLICY GAP", "WORK (tier + worker)"], "cap", 19);
    s += arrow([[X + 152, ly + 90], [X + 170, ly + 90]]);
    // lane frame
    const lx = X + 174, lw = 478, lh = 512;
    s += rect(lx, ly, lw, lh, "k-violet", 16);
    s += text(lx + 18, ly + 28, `${c("Lane", "tb c-violet")}  — one Workflow call per issue  ${m("sapu-wave.js")}`, "t");
    s += text(lx + 18, ly + 48, "own worktree · ≤ lanes in flight (1–4, per machine) · refilled as each returns", "cap");
    const iy = ly + 66, ih = 66, inx = lx + 18;
    s += box(inx, iy, 140, ih, "forge worker", ["plan · TDD · open PR"]);
    s += arrow([[inx + 144, iy + ih / 2], [inx + 162, iy + ih / 2]]);
    s += box(inx + 166, iy, 140, ih, "review by tier", ["never the author"]);
    s += arrow([[inx + 310, iy + ih / 2], [inx + 328, iy + ih / 2]], "ar-g");
    s += box(inx + 332, iy, 110, ih, "ready PR", ["not merged here"], "k-green");
    s += arrow([[inx + 236, iy + ih + 2], [inx + 236, iy + ih + 18], [inx + 70, iy + ih + 18], [inx + 70, iy + ih + 4]], "ar-a");
    s += text(inx + 246, iy + ih + 22, "findings → fix + delta re-review", "cap c-amber");

    // rules
    let ry2 = iy + ih + 48;
    s += text(inx, ry2, "FIX CYCLES", "lbl");
    ry2 += 12;
    let [t1, w1] = tier(inx, ry2, "green");
    let [t2, w2] = tier(inx + w1 + 6, ry2, "yellow");
    s += t1 + t2 + text(inx + w1 + w2 + 18, ry2 + 15, `${b("at most 2")} fix cycles`, "t");
    ry2 += 30;
    const [t3, w3] = tier(inx, ry2, "red");
    s += t3 + text(inx + w3 + 12, ry2 + 15, `${b("up to 5")}, but past the 2nd only while the work converges:`, "t");
    ry2 += 42;
    s += lines(inx, ry2, [
      "each review reports fewer findings than the one before, and no",
      "finding is reported by three reviews in a row; else blocked (reason)",
      `${b("ESCALATE", "tb")} → one step up the ladder, once; then blocked`,
      `past its ${b("step budget")} → handoff: WIP commit, then a fresh worker`,
      "of the same tier continues from its note (≤ 2 handoffs per step)",
    ], "cap", 19);
    ry2 += 5 * 19 + 14;
    s += `<line x1="${inx}" y1="${ry2 - 6}" x2="${inx + 442}" y2="${ry2 - 6}" class="rule"/>`;
    s += text(inx, ry2 + 14, "REVIEWER · NEVER THE AUTHOR, NEVER A LADDER WORKER", "lbl");
    ry2 += 26;
    [t1, w1] = tier(inx, ry2, "green");
    [t2, w2] = tier(inx + w1 + 6, ry2, "yellow");
    s += t1 + t2 + text(inx + w1 + w2 + 18, ry2 + 15, `→ the ${b("qa specialist")} at Opus/high`, "t");
    ry2 += 30;
    const [t4, w4] = tier(inx, ry2, "red");
    s += t4 + text(inx + w4 + 12, ry2 + 15, `→ an adversarial ${b("Opus pair")}: qa + a domain specialist`, "t");
    ry2 += 44;
    s += lines(inx, ry2, [
      "also raised to the pair: a red-area diff · an unrun check · the worker's red areas",
      `worker by difficulty: ${m("sonnet-medium")} … ${m("opus-high")} (red ≥ ${m("sonnet-high")})`,
    ], "cap", 19);

    // merge queue
    const qx = lx + lw + 24, qw = R - qx;
    s += arrow([[inx + 444, iy + ih / 2], [qx - 4, iy + ih / 2]], "ar-g");
    s += card(qx, ly + 30, qw, 250, "k-red", 14);
    s += iconTile("shieldcheck", qx + 14, ly + 44, "red", 32);
    s += text(qx + 14, ly + 102, "merge queue", "tb");
    s += lines(qx + 14, ly + 122, ["one at a time,", "background,", "no polling"], "cap", 17);
    s += text(qx + 14, ly + 186, "sapu-merge.sh", "cap mono c-red");
    s += lines(qx + 14, ly + 206, ["· gate", "· flake ledger", "· merge", "· mergeAfter"], "cap", 17);
    s += arrow([[qx + qw / 2, ly + 282], [qx + qw / 2, ly + 314]], "ar-g");
    s += box(qx, ly + 318, qw, 62, "merged", ["to base"], "k-green");

    // red gate
    const gy = ly + lh + 22;
    s += card(X, gy, W, 92, "k-red", 14);
    s += iconTile("stop", X + 14, gy + 16, "red", 34);
    s += text(X + 62, gy + 30, `${b("Gate red = no merge", "tb c-red")}  ·  at most one re-run per PR  ·  every run goes to the flake ledger ${m(".git/sapu-gates.log")}`, "t");
    s += lines(X + 62, gy + 52, [
      `red again → the failing test files on ${m("origin/&lt;base&gt;")}: red there too = a base flake → one "flake: &lt;file&gt;" issue, fixed at its source`,
      `end-of-wave net: full suite on ${m("origin/&lt;base&gt;")} every 4th merge + when the queue drains (profile: other cadence, or none)`,
    ], "cap", 19);

    // ---- end of session
    const sy = ys.sess;
    s += sectionHead(sy, "↻", "End of each session", "context past its limit, a share of the model's window (contract tuning)");
    const sw = (W - 3 * 24) / 4, scy = sy + 20, sh = 92;
    const sess = [
      ["session limit reached", ["checked between waves,", "never inside a lane"], "card", []],
      ["rewrite the state page", ["sapu-sweep-state", "one memory page, ≤ 40 lines,", "open items only"], "card", [0]],
      ["cleanup", ["only if policy = session:", "plan, then --apply", "(default: only at Finish)"], "card", []],
      ["a fresh /sapu", ["started by the owner: new", "PRs first, then issues,", "resuming from the page"], "k-green", []],
    ];
    sess.forEach(([t, l, cls, mono], i) => {
      const x = X + i * (sw + 24);
      s += box(x, scy, sw, sh, t, l, cls, { mono });
      if (i < 3) s += arrow([[x + sw + 4, scy + sh / 2], [x + sw + 20, scy + sh / 2]]);
    });

    // ---- finish
    const fy = ys.fin;
    s += sectionHead(fy, "✓", "Finish · the last session");
    const fcy = fy + 20, fh = 74;
    const fin = [
      ["nothing left to work", ["no WORK, no open PR;", "only SKIP / BLOCKED"], "card"],
      ["cleanup per policy", ["finish (default) · never: skip"], "card"],
      ["final full gate", ["on origin/&lt;base&gt;"], "k-red"],
      ["final report", ["PR + issue tables, metrics", "engine defects → plugin repo"], "k-green"],
    ];
    fin.forEach(([t, l, cls], i) => {
      const x = X + i * (sw + 24);
      s += box(x, fcy, sw, fh, t, l, cls, { mono: i === 2 ? [0] : [] });
      if (i < 3) s += arrow([[x + sw + 4, fcy + fh / 2], [x + sw + 20, fcy + fh / 2]], i === 2 ? "ar-g" : "ar");
    });
    s += lines(X, fcy + fh + 28, [
      `Cleanup = ${m("sapu-cleanup.mjs")} (plan, then ${m("--apply")}) when ${m("policy.cleanup")}, set once in /sapu:init, says so: only sapu's own branches`,
      `(${m("&lt;type&gt;/issue-&lt;N&gt;-…")}, ${m("worktree-wf_*")}, ${m("worktree-agent-*")}, ${m("sapu-*")}) proven merged; worktrees only when clean, never --force.`,
    ], "cap", 19);

    // guard
    const gy2 = fcy + fh + 82;
    s += card(32, gy2, 856, 86, "k-red", 14);
    s += iconTile("shield", 48, gy2 + 16, "red", 34);
    s += text(96, gy2 + 30, `${b("Guard hook", "tb c-red")}  checks every subagent's shell, file, search and MCP tool calls — never the orchestrator's.`, "t");
    s += text(96, gy2 + 51, "Workers never merge or touch the main checkout, protected DBs (contract guard) or env files. No subagent writes the plugins it runs under.", "cap");
    s += text(96, gy2 + 70, "Past its step budget it reminds a worker to hand off. It stops honest mistakes; it is not a sandbox.", "cap");
    return s;
  },
};
