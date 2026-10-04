import { card, text, lines, arrow, iconTile, m, b } from "../lib.mjs";

const steps = [
  ["lock", "violet", "STEP 0", "Scope lock", ["account, origin and", "allowed roots checked"]],
  ["pr", "blue", "PHASE A", "Drain open PRs", ["every open PR:", "review, fix or close"]],
  ["lanes", "violet", "PHASE B", "A lane per issue", ["forge worker in its", "own worktree, one PR"]],
  ["eye", "amber", "REVIEW", "Never the author", ["qa at Opus/high;", "red: an Opus pair"]],
  ["shieldcheck", "green", "MERGE", "Green gate only", [`${m("sapu-merge.sh")},`, "one PR at a time"]],
];

export default {
  h: 420,
  title: "/sapu in 30 seconds",
  desc: "Five steps from an open backlog to merged work. Step 0: the scope lock checks the gh account, origin and the allowed roots. Phase A: every open PR is reviewed, fixed or closed. Phase B: each open issue is one lane, where a forge worker in its own worktree opens a PR. Review: never by the author; the qa specialist at Opus/high, and an adversarial Opus pair on the red tier; findings go back to the worker in fix cycles. Merge: only on a green gate, through sapu-merge.sh, one PR at a time. Every issue ends merged, skipped with a reason, or blocked with a reason.",
  label: "/sapu in 30 seconds: scope lock, drain open PRs, one lane per issue, review by an agent that is not the author with fix cycles, and a merge only on a green gate through sapu-merge.sh, one PR at a time. Every issue ends merged, skipped or blocked, each with a reason.",
  eyebrow: "ONE COMMAND · /sapu",
  heading: "From open backlog to merged work",
  sub: "Workers never merge. One script does, after the gate is green.",
  body() {
    const x0 = 32, y = 132, w = 152, g = 24, h = 150;
    let s = "";
    steps.forEach(([ico, kind, lbl, ttl, sub], i) => {
      const x = x0 + i * (w + g);
      s += card(x, y, w, h);
      s += iconTile(ico, x + 16, y + 16, kind, 34);
      s += text(x + 16, y + 74, lbl, "lbl");
      s += text(x + 16, y + 96, ttl, "ttl");
      s += lines(x + 16, y + 117, sub, "cap", 17);
      if (i < steps.length - 1) s += arrow([[x + w + 5, y + h / 2], [x + w + g - 5, y + h / 2]]);
    });
    // fix loop: review -> lane
    const xr = x0 + 3 * (w + g) + w / 2, xl = x0 + 2 * (w + g) + w / 2;
    s += arrow([[xr, y + h + 2], [xr, y + h + 24], [xl, y + h + 24], [xl, y + h + 6]], "ar-a");
    s += text((xr + xl) / 2, y + h + 42, "findings → fix cycles", "cap", "middle");
    // result
    const ry = 340;
    const xm = x0 + 4 * (w + g) + w / 2;
    s += arrow([[xm, y + h + 2], [xm, ry - 4]], "ar-g");
    s += card(x0, ry, 856, 52, "k-green", 14);
    s += iconTile("check", x0 + 14, ry + 10, "green", 32);
    s += text(x0 + 58, ry + 31, `${b("Backlog clean.", "tb")}  Every issue ends ${b("merged")}, ${b("skipped")} (with a reason) or ${b("blocked")} (with a reason).`, "t");
    return s;
  },
};
