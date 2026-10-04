import { readFileSync } from "node:fs";
import { card, rect, text, lines, arrow, iconTile, brandTile, chip, chips, chipsWrap, legend, m, b, c, tw } from "../lib.mjs";
const A11Y = JSON.parse(readFileSync(new URL("../a11y/dream.json", import.meta.url), "utf8"));

export default {
  h: 884,
  ...A11Y,
  eyebrow: "FORWARD RESEARCH · /dream",
  heading: "Where is this heading?",
  sub: "Deep research → falsifiable hypotheses → near-term experiments for this project. Read-only.",
  body() {
    let s = "";
    s += legend(32, 140, [["flow", "flow"], ["reads", "reads"], ["produces", "produces"], ["limit", "hard limit"]]);
    s += card(32, 162, 856, 46, "k-blue", 12);
    s += iconTile("doc", 44, 168, "blue", 34);
    s += text(90, 190, `${b("Reads")}  optional profile ${m(".claude/sapu/dream.md")} (findings routing) + project context  ·  no contract needed`, "t");

    const y = 236, w = 266, g = 29, h = 446;
    const head = (x, k, ico, name, meta) =>
      card(x, y, w, h, "card", 14) + brandTile(ico, x + 16, y + 16, 36) + text(x + 64, y + 32, `Phase ${k} · ${name}`, "ttl") + text(x + 64, y + 50, meta, "cap");
    const lbl = (x, yy, t) => text(x, yy, t, "lbl");

    // phase 1
    let x = 32;
    s += head(x, 1, "search", "Research", "≈ 40% of the effort");
    s += lbl(x + 16, y + 84, "SOURCES");
    s += lines(x + 16, y + 104, ["· papers and talks, 6–12 months", "· what frontier labs ship", "· adjacent fields, failures", "· GitHub trending + dependents"], "cap", 18);
    s += lbl(x + 16, y + 196, "DOMAINS · 2–3 PER RUN, ROTATING");
    const dom = ["auth", "security", "UI/UX", "performance", "database", "hosting", "HCI", "dashboards", "payments"];
    const [dc, dh] = chipsWrap(x + 16, y + 206, dom.map((d) => [d, "neutral"]), w - 32);
    s += dc;
    let yy = y + 206 + dh + 22;
    s += lbl(x + 16, yy, "EVERY CLAIM TAGGED");
    const [tc, th2] = chipsWrap(x + 16, yy + 10, [["HAPPENING", "green"], ["EMERGING", "amber"], ["EXTRAPOLATION", "violet"]], w - 32);
    s += tc;
    s += text(x + 16, yy + 10 + th2 + 16, "cite or cut · note contradicting evidence", "cap");
    s += arrow([[x + w + 5, y + 40], [x + w + g - 5, y + 40]]);

    // phase 2
    x = 32 + w + g;
    s += head(x, 2, "sparkle", "Dreaming", "8–12 ideas");
    s += lbl(x + 16, y + 84, "EACH IDEA CARRIES");
    s += lines(x + 16, y + 104, ["· a cited reasoning chain", "· the shift: before → after", "· why now (a named curve)", "· what breaks first", "· the senior engineer's objection", "· one concrete artifact", "· a kill condition (falsifiable)", "· a confidence"], "cap", 18);
    s += lbl(x + 16, y + 270, "BEFORE OUTPUT");
    s += rect(x + 16, y + 282, w - 32, 54, "sunken", 10);
    s += text(x + 30, y + 304, "diversity check", "tb");
    s += text(x + 30, y + 324, "uncited link → cut or downgrade", "cap");
    s += arrow([[x + w + 5, y + 40], [x + w + g - 5, y + 40]]);

    // phase 3
    x = 32 + 2 * (w + g);
    s += head(x, 3, "target", "Wake-up", "2–3 ideas");
    s += lbl(x + 16, y + 84, "GROUNDED IN THIS PROJECT");
    [["architecture impact", "a real file, skill or service"], ["one-month experiment", "signal if right / if wrong"], ["cost of early vs late", ""]].forEach(([t, sub], i) => {
      s += text(x + 16, y + 106 + i * 42, `· ${t}`, "t") + text(x + 26, y + 124 + i * 42, sub, "cap");
    });
    s += lbl(x + 16, y + 250, "THE REPORT ALSO HAS");
    s += lines(x + 16, y + 270, ["· a Conviction paragraph", "· Delta vs previous dreams", "+ a domain coverage table"], "cap", 18);

    // focus + output
    const oy = y + h + 22;
    s += text(32, oy + 4, `${m("/dream [focus]")} weights research to the focus, ~20% outside it`, "cap");
    s += arrow([[32 + 2 * (w + g) + w / 2, y + h + 2], [32 + 2 * (w + g) + w / 2, oy + 18]], "ar-g");
    s += card(32 + 2 * (w + g) - 160, oy + 22, w + 160, 52, "k-green", 12);
    s += iconTile("doc", 32 + 2 * (w + g) - 148, oy + 31, "green", 34);
    s += text(32 + 2 * (w + g) - 102, oy + 44, "one local report", "tb");
    s += text(32 + 2 * (w + g) - 102, oy + 63, "dreams/DREAM-{YYYY-MM-DD}[-{focus}].md", "cap mono");

    const hy = oy + 94;
    s += card(32, hy, 856, 66, "k-red", 14);
    s += iconTile("stop", 44, hy + 16, "red", 34);
    s += text(90, hy + 28, `${b("Read-only", "tb c-red")}  — the hard limit. Modifies no code and opens no issues; its only write is the report above.`, "t");
    s += text(90, hy + 48, "A bug-like finding is named in prose and pointed at the project's QA skill (e.g. /argus); never filed.", "cap");
    return s;
  },
};
