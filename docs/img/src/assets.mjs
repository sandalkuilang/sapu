// Feature icons (theme-agnostic brand tiles) and badges.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { ICONS, SANS, tw } from "./lib.mjs";
const IMG = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(`${IMG}/icons`, { recursive: true });

const icons = {
  sweep: ["lanes", "One command, clean backlog"],
  review: ["eye", "Independent review"],
  gate: ["shieldcheck", "Merge only on green"],
  contract: ["doc", "Zero repo knowledge in the plugin"],
  guard: ["shield", "Safe by default"],
  cleanup: ["trash", "Tidies up only what is proven done"],
  team: ["users", "A senior team on call"],
};
for (const [file, [ico, label]] of Object.entries(icons)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" role="img" aria-label="${label} icon">
  <title>${label}</title>
  <desc>A ${ico} glyph in white on a rounded teal-to-indigo tile.</desc>
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f766e"/><stop offset="1" stop-color="#4f46e5"/></linearGradient></defs>
  <rect width="48" height="48" rx="13" fill="url(#g)"/>
  <g transform="translate(12,12)"><path d="${ICONS[ico]}" fill="none" stroke="#ffffff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></g>
</svg>
`;
  writeFileSync(`${IMG}/icons/${file}.svg`, svg);
  execFileSync("xmllint", ["--noout", `${IMG}/icons/${file}.svg`]);
}

const badges = {
  license: ["license", "MIT", "#0f766e"],
  "claude-code": ["Claude Code", "plugin", "#4f46e5"],
  node: ["node", "≥ 22.18", "#15803d"],
  "senior-dev-team": ["senior-dev-team", "8 agents", "#6d28d9"],
};
for (const [file, [l, v, col]] of Object.entries(badges)) {
  const lw = Math.round(tw(l, 11, "bold") + 16), vw = Math.round(tw(v, 11, "bold") + 16), w = lw + vw;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="22" viewBox="0 0 ${w} 22" role="img" aria-label="${l}: ${v}">
  <title>${l}: ${v}</title>
  <desc>Badge: ${l}, ${v}.</desc>
  <clipPath id="r"><rect width="${w}" height="22" rx="6"/></clipPath>
  <g clip-path="url(#r)"><rect width="${lw}" height="22" fill="#1e293b"/><rect x="${lw}" width="${vw}" height="22" fill="${col}"/></g>
  <g fill="#ffffff" text-anchor="middle" style="font-family:${SANS};font-size:11px;font-weight:600">
    <text x="${lw / 2}" y="15">${l}</text>
    <text x="${lw + vw / 2}" y="15">${v}</text>
  </g>
</svg>
`;
  writeFileSync(`${IMG}/badges/${file}.svg`, svg);
  execFileSync("xmllint", ["--noout", `${IMG}/badges/${file}.svg`]);
}
console.log("assets ok");
