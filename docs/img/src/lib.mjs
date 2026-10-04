// sapu diagram kit: one palette, one type scale, two themes. Every diagram is written once
// against classes; build.mjs renders it with the light and the dark token set.

export const THEMES = {
  light: {
    canvas: "#f8fafc", canvasStroke: "#e2e8f0",
    surface: "#ffffff", surfaceStroke: "#d9e1ea",
    sunken: "#f1f5f9", sunkenStroke: "#e2e8f0",
    ink: "#0f172a", ink2: "#1e293b", muted: "#475569",
    arrow: "#64748b",
    brandA: "#0f766e", brandB: "#4f46e5",
    accent: "#4338ca", teal: "#0f766e",
    blue: ["#1d4ed8", "#eff6ff", "#93c5fd"],
    green: ["#15803d", "#f0fdf4", "#86efac", "#16a34a"],
    amber: ["#b45309", "#fffbeb", "#fcd34d", "#d97706"],
    red: ["#b91c1c", "#fef2f2", "#fca5a5", "#dc2626"],
    violet: ["#6d28d9", "#f5f3ff", "#c4b5fd", "#7c3aed"],
    shadow: "#0f172a", shadowOp: 0.07, shadowOp2: 0.05,
  },
  dark: {
    canvas: "#0f1623", canvasStroke: "#263247",
    surface: "#172133", surfaceStroke: "#2e3c55",
    sunken: "#121a28", sunkenStroke: "#253147",
    ink: "#f1f5f9", ink2: "#dbe3ee", muted: "#9fb0c6",
    arrow: "#8796ad",
    brandA: "#0f766e", brandB: "#4f46e5",
    accent: "#a5b4fc", teal: "#5eead4",
    blue: ["#93c5fd", "#0f1e38", "#2f5596"],
    green: ["#4ade80", "#0b2417", "#1f7a45", "#22c55e"],
    amber: ["#fbbf24", "#271c08", "#8a5d12", "#f59e0b"],
    red: ["#fca5a5", "#2a1216", "#8f3434", "#ef4444"],
    violet: ["#c4b5fd", "#1c1736", "#5b4aa3", "#a78bfa"],
    shadow: "#000000", shadowOp: 0.35, shadowOp2: 0.25,
  },
};

export const SANS = `-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Helvetica,Arial,sans-serif`;
export const MONO = `ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace`;

export function css(t) {
  const sem = (n) => {
    const [tx, fill, stroke, strong] = t[n];
    return `.c-${n}{fill:${tx}} .k-${n}{fill:${fill};stroke:${stroke};stroke-width:1.25} .s-${n}{stroke:${strong ?? tx}} .f-${n}{fill:${strong ?? tx}} .tile-${n}{fill:${fill};stroke:${stroke};stroke-width:1}`;
  };
  return `
    text{font-family:${SANS};fill:${t.ink2}}
    .mono{font-family:${MONO}}
    .canvas{fill:${t.canvas};stroke:${t.canvasStroke};stroke-width:1}
    .eyebrow{font-size:11.5px;font-weight:700;letter-spacing:.12em;fill:${t.accent}}
    .h1{font-size:25px;font-weight:750;fill:${t.ink};letter-spacing:-.01em}
    .sub{font-size:13.5px;fill:${t.muted}}
    .sec{font-size:15px;font-weight:700;fill:${t.ink}}
    .sec2{font-size:12.5px;fill:${t.muted}}
    .ttl{font-size:14px;font-weight:650;fill:${t.ink}}
    .t{font-size:13px;fill:${t.ink2}}
    .tb{font-size:13px;font-weight:650;fill:${t.ink}}
    .cap{font-size:12px;fill:${t.muted}}
    .lbl{font-size:11.5px;font-weight:650;letter-spacing:.06em;fill:${t.muted}}
    .chipt{font-size:11.5px;font-weight:600}
    .white{fill:#ffffff}
    .ink{fill:${t.ink}} .muted{fill:${t.muted}} .accent{fill:${t.accent}} .tealt{fill:${t.teal}}
    .card{fill:${t.surface};stroke:${t.surfaceStroke};stroke-width:1}
    .sunken{fill:${t.sunken};stroke:${t.sunkenStroke};stroke-width:1}
    .chip{fill:${t.sunken};stroke:${t.surfaceStroke};stroke-width:1}
    .ar{stroke:${t.arrow};stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round}
    .ar-g{stroke:${t.green[3]};stroke-width:1.7;fill:none;stroke-linecap:round;stroke-linejoin:round}
    .ar-a{stroke:${t.amber[3]};stroke-width:1.6;fill:none;stroke-dasharray:5 4;stroke-linecap:round;stroke-linejoin:round}
    .ar-b{stroke:${t.blue[0]};stroke-width:1.6;fill:none;stroke-dasharray:6 4;stroke-linecap:round}
    .ar-v{stroke:${t.violet[3]};stroke-width:1.6;fill:none;stroke-dasharray:6 4;stroke-linecap:round}
    .guard{stroke:${t.red[3]};stroke-width:1.4;fill:none;stroke-dasharray:2 4;stroke-linecap:round}
    .m-n{stroke:${t.arrow}} .m-g{stroke:${t.green[3]}} .m-a{stroke:${t.amber[3]}} .m-b{stroke:${t.blue[0]}} .m-v{stroke:${t.violet[3]}}
    .ico{fill:none;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
    .ico-n{stroke:${t.muted}} .ico-w{stroke:#ffffff}
    .rule{stroke:${t.surfaceStroke};stroke-width:1}
    ${["blue", "green", "amber", "red", "violet"].map(sem).join("\n    ")}
  `;
}

export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Rough text width for layout (SF/Segoe metrics); verified by eye on the renders. */
export function tw(str, size = 13, kind = "sans") {
  if (kind === "mono") return [...String(str)].length * size * 0.602;
  const lo = kind === "bold" ? 0.55 : 0.5, up = kind === "bold" ? 0.69 : 0.64;
  let w = 0;
  for (const ch of String(str)) w += (/[A-Z]/.test(ch) ? up : /[ .,:;·il|!']/.test(ch) ? 0.3 : lo) * size;
  return w;
}

/** Chips that wrap inside maxW; returns [svg, height]. */
export function chipsWrap(x, y, list, maxW, gap = 6, rowH = 28) {
  let out = "", cx = x, cy = y;
  for (const [label, kind, opt] of list) {
    const w = Math.round(tw(label, 11.5, opt?.mono ? "mono" : "bold") + (opt?.dot ? 31 : 22));
    if (cx > x && cx + w > x + maxW) { cx = x; cy += rowH; }
    out += chip(cx, cy, label, kind, opt)[0];
    cx += w + gap;
  }
  return [out, cy - y + rowH];
}

export function defs(t) {
  const mk = (id, cls) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M1.5,1.5 L8.5,5 L1.5,8.5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="${cls}"/></marker>`;
  return `<defs>
    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.brandA}"/><stop offset="1" stop-color="${t.brandB}"/></linearGradient>
    <linearGradient id="brandbar" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#14b8a6"/><stop offset=".55" stop-color="#6366f1"/><stop offset="1" stop-color="#a855f7"/></linearGradient>
    <filter id="sh" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="${t.shadow}" flood-opacity="${t.shadowOp}"/><feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="${t.shadow}" flood-opacity="${t.shadowOp2}"/></filter>
    ${mk("mn", "m-n")}${mk("mg", "m-g")}${mk("ma", "m-a")}${mk("mb", "m-b")}${mk("mv", "m-v")}
  </defs>`;
}

// ---------- primitives ----------
export const rect = (x, y, w, h, cls = "card", rx = 12, extra = "") => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" class="${cls}" ${extra}/>`;
export const card = (x, y, w, h, cls = "card", rx = 12) => rect(x, y, w, h, cls, rx, cls === "card" ? 'filter="url(#sh)"' : "");
export const text = (x, y, s, cls = "t", anchor = "start") => `<text x="${x}" y="${y}" class="${cls}"${anchor !== "start" ? ` text-anchor="${anchor}"` : ""}>${s}</text>`;
/** Several lines; each item is a raw (already escaped) string or [str, cls]. */
export function lines(x, y, items, cls = "t", lh = 19, anchor = "start") {
  const one = (str, k, i) => {
    const ind = /^  /.test(str);
    return text(x + (ind ? 10 : 0), y + i * lh, ind ? str.slice(2) : str, k, anchor);
  };
  return items.map((it, i) => (Array.isArray(it) ? one(it[0], it[1], i) : one(it, cls, i))).join("\n");
}
export const m = (s) => `<tspan class="mono">${s}</tspan>`;
export const b = (s, cls = "tb") => `<tspan class="${cls}">${s}</tspan>`;
export const c = (s, cls) => `<tspan class="${cls}">${s}</tspan>`;

const MK = { ar: "mn", "ar-g": "mg", "ar-a": "ma", "ar-b": "mb", "ar-v": "mv" };
/** Polyline arrow (points [[x,y],...]); kind = ar | ar-g | ar-a | ar-b | ar-v. Rounded corners. */
export function arrow(pts, kind = "ar", { start = false, r = 8 } = {}) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = pts[i];
    if (i < pts.length - 1 && r > 0) {
      const [px, py] = pts[i - 1], [nx, ny] = pts[i + 1];
      const l1 = Math.hypot(x - px, y - py), l2 = Math.hypot(nx - x, ny - y);
      const rr = Math.min(r, l1 / 2, l2 / 2);
      const ax = x - ((x - px) / l1) * rr, ay = y - ((y - py) / l1) * rr;
      const bx = x + ((nx - x) / l2) * rr, by = y + ((ny - y) / l2) * rr;
      d += ` L${ax.toFixed(1)},${ay.toFixed(1)} Q${x},${y} ${bx.toFixed(1)},${by.toFixed(1)}`;
    } else d += ` L${x},${y}`;
  }
  return `<path d="${d}" class="${kind}" marker-end="url(#${MK[kind]})"${start ? ` marker-start="url(#${MK[kind]})"` : ""}/>`;
}

/** Pill chip; returns [svg, width]. kind: neutral | blue | green | amber | red | violet. */
export function chip(x, y, label, kind = "neutral", { dot = false, mono = false, h = 22 } = {}) {
  const w = Math.round(tw(label, 11.5, mono ? "mono" : "bold") + (dot ? 31 : 22));
  const box = kind === "neutral" ? "chip" : `k-${kind}`;
  const txt = kind === "neutral" ? "muted" : `c-${kind}`;
  const d = dot ? `<circle cx="${x + 12}" cy="${y + h / 2}" r="4" class="f-${kind === "neutral" ? "violet" : kind}"/>` : "";
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" class="${box}"/>${d}<text x="${x + (dot ? 21 : 10)}" y="${y + h / 2 + 4}" class="chipt ${txt}${mono ? " mono" : ""}">${label}</text>`,
    w,
  ];
}
/** A row of chips; returns [svg, totalWidth]. */
export function chips(x, y, list, gap = 8) {
  let out = "", cx = x;
  for (const [label, kind, opt] of list) {
    const [s, w] = chip(cx, y, label, kind, opt);
    out += s;
    cx += w + gap;
  }
  return [out, cx - x - gap];
}
/** Tier chip: colour AND a word, never colour alone. */
export const TIER = { green: "green", yellow: "amber", red: "red" };
export const tier = (x, y, name) => chip(x, y, name, TIER[name], { dot: true });

/** Numbered / lettered step badge on the brand gradient. */
export const badge = (cx, cy, label, r = 14) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#brand)"/><text x="${cx}" y="${cy + 4.5}" class="white" text-anchor="middle" style="font-size:${r > 12 ? 13 : 11.5}px;font-weight:700">${label}</text>`;

// ---------- icons (24x24 grid, 1.75 stroke) ----------
export const ICONS = {
  lock: "M7 11V8a5 5 0 0 1 10 0v3 M5.5 11h13v9.5h-13z M12 15v2.5",
  pr: "M6 4.5a2 2 0 1 0 0.01 0 M6 15.5a2 2 0 1 0 0.01 0 M18 15.5a2 2 0 1 0 0.01 0 M6 8.5v7 M18 15.5V10a3 3 0 0 0-3-3h-4 M13 4.5L10.5 7 13 9.5",
  lanes: "M4 6h12 M4 12h16 M4 18h9 M14 3.5L16.5 6 14 8.5 M18 9.5L20.5 12 18 14.5 M11 15.5L13.5 18 11 20.5",
  eye: "M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z M12 9.2a2.8 2.8 0 1 0 0.01 0",
  shieldcheck: "M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z M8.8 12.2l2.3 2.3 4.3-4.6",
  shield: "M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z",
  check: "M12 3a9 9 0 1 0 0.01 0 M8 12.3l2.8 2.8 5.2-5.6",
  merge: "M7 4.5a2 2 0 1 0 0.01 0 M7 15.5a2 2 0 1 0 0.01 0 M17 11.5a2 2 0 1 0 0.01 0 M7 8.5v7 M7 8.5c0 3 2.5 5 6.5 5H15",
  doc: "M7 3h7l4.5 4.5V21H7z M14 3v4.5h4.5 M10 12h5.5 M10 16h5.5",
  users: "M9 4.5a3.5 3.5 0 1 0 0.01 0 M3 20c0-3.6 2.7-6 6-6s6 2.4 6 6 M16.5 5.5a2.8 2.8 0 1 1 0 5.6 M17.5 14.2c2.2.5 3.5 2.6 3.5 5.3",
  target: "M12 3a9 9 0 1 0 0.01 0 M12 7.5a4.5 4.5 0 1 0 0.01 0 M12 11.2a.8 .8 0 1 0 0.01 0",
  layers: "M12 3.5l8.5 4.5-8.5 4.5L3.5 8z M3.5 12.5l8.5 4.5 8.5-4.5 M3.5 16.5l8.5 4.5 8.5-4.5",
  code: "M8.5 7.5L4 12l4.5 4.5 M15.5 7.5L20 12l-4.5 4.5 M13.5 5l-3 14",
  db: "M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3z M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6 M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3",
  layout: "M4.5 4h15a1.5 1.5 0 0 1 1.5 1.5v13a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-13A1.5 1.5 0 0 1 4.5 4z M3 9h18 M9.5 9v11",
  bug: "M9 8.5a3 3 0 0 1 6 0 M8 9.5h8v4.5a4 4 0 0 1-8 0z M12 10v8 M8 12H4.5 M19.5 12H16 M8.3 16.2L5 18 M15.7 16.2L19 18 M8.5 9.5L6 7 M15.5 9.5L18 7",
  search: "M10.5 4a6.5 6.5 0 1 0 0.01 0 M15.5 15.5L20 20",
  pen: "M4 20h4.5L19 9.5 14.5 5 4 15.5z M12.5 7l4.5 4.5",
  refresh: "M20 12a8 8 0 1 1-2.4-5.7 M20 4v4.5h-4.5",
  trash: "M4.5 7h15 M9.5 7V4.5h5V7 M6.5 7l1 13h9l1-13",
  bookmark: "M7 3.5h10v17l-5-3.5-5 3.5z",
  hammer: "M13.5 4.5l6 6-2.5 2.5-6-6z M11 7L3.5 14.5 6 17l7.5-7.5",
  gauge: "M4 17a8 8 0 1 1 16 0 M12 17l3.5-5",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M18.5 16l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z",
  flag: "M5 21V4 M5 4.5h11l-2 4 2 4H5",
  stop: "M8.5 3h7L21 8.5v7L15.5 21h-7L3 15.5v-7z M9 9l6 6 M15 9l-6 6",
  compass: "M12 3a9 9 0 1 0 0.01 0 M15.5 8.5l-2 5-5 2 2-5z",
  play: "M12 3a9 9 0 1 0 0.01 0 M10 8.5l5.5 3.5-5.5 3.5z",
};
/** Icon tile: tinted rounded square with a centred glyph. */
export function iconTile(name, x, y, kind = "violet", size = 32) {
  const s = size / 32;
  return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${9 * s}" class="tile-${kind}"/><g transform="translate(${x + 6 * s},${y + 6 * s}) scale(${(20 / 24) * s})"><path d="${ICONS[name]}" class="ico s-${kind}"/></g>`;
}
/** Bare icon glyph at (x,y), size px. */
export const icon = (name, x, y, size = 18, cls = "ico-n") => `<g transform="translate(${x},${y}) scale(${size / 24})"><path d="${ICONS[name]}" class="ico ${cls}"/></g>`;

// ---------- page shell ----------
export function page({ w = 920, h, title, desc, label, eyebrow, heading, sub, body, theme }) {
  const t = THEMES[theme];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">
  <title>${esc(title)}</title>
  <desc>${esc(desc)}</desc>
  <style>${css(t)}</style>
  ${defs(t)}
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="20" class="canvas"/>
  <clipPath id="cv"><rect x="0" y="0" width="${w}" height="${h}" rx="20"/></clipPath>
  <rect x="0" y="0" width="${w}" height="4" fill="url(#brandbar)" clip-path="url(#cv)"/>
  ${eyebrow ? text(32, 46, esc(eyebrow), "eyebrow") : ""}
  ${heading ? text(32, 78, heading, "h1") : ""}
  ${sub ? text(32, 102, sub, "sub") : ""}
  ${body.replace(/(<\/text>|<\/g>|\/>)(?=<(?:rect|text|g|path|circle|line)\b)/g, "$1\n  ")}
</svg>
`;
}

/** A heading and its muted note on one line: the note flows after the heading in any font (no measured x). */
export const headline = (x, y, title, note = "") =>
  `<text x="${x}" y="${y}"><tspan class="sec">${title}</tspan>${note ? `<tspan class="sec2" dx="12">${note}</tspan>` : ""}</text>`;

/** Section header with a step badge. Returns svg. */
export const section = (x, y, badgeLabel, title, note = "") =>
  `${badge(x + 14, y - 5, badgeLabel)}${headline(x + 38, y, title, note)}`;

/** Legend row. items: [kind, label]; kind: flow | loop | produces | reads | limit | tier:<name> */
export function legend(x, y, items) {
  let out = "", cx = x;
  for (const [k, label] of items) {
    if (k.startsWith("tier:")) {
      const [s, w] = tier(cx, y - 11, k.slice(5));
      out += s;
      cx += w + (label ? 8 : 6);
      if (label) { out += text(cx, y + 4, label, "cap"); cx += tw(label, 12) + 22; }
      continue;
    }
    if (k === "limit") {
      out += `<rect x="${cx}" y="${y - 7}" width="22" height="14" rx="4" class="k-red"/>`;
      cx += 30;
    } else if (k === "guard") {
      out += `<rect x="${cx}" y="${y - 7}" width="22" height="14" rx="4" class="guard"/>`;
      cx += 30;
    } else {
      const kind = { flow: "ar", loop: "ar-a", produces: "ar-g", reads: "ar-b", feeds: "ar-v" }[k];
      out += arrow([[cx, y], [cx + 26, y]], kind);
      cx += 34;
    }
    out += text(cx, y + 4, label, "cap");
    cx += tw(label, 12) + 22;
  }
  return out;
}

/** Icon tile on the brand gradient, white glyph. */
export function brandTile(name, x, y, size = 36) {
  const s = size / 32;
  return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${9 * s}" fill="url(#brand)"/><g transform="translate(${x + 6 * s},${y + 6 * s}) scale(${(20 / 24) * s})"><path d="${ICONS[name]}" class="ico ico-w"/></g>`;
}
