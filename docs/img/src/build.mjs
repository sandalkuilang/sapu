// node docs/img/src/build.mjs [name ...] — writes docs/img/<name>.svg and <name>-dark.svg from
// diagrams/<name>.mjs: one source per diagram, both themes, so the two files never drift apart.
import { writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { page } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT ?? join(HERE, ".."); // docs/img

const want = process.argv.slice(2);
const mods = readdirSync(join(HERE, "diagrams")).filter((f) => f.endsWith(".mjs"));
for (const f of mods) {
  const name = f.replace(/\.mjs$/, "");
  if (want.length && !want.includes(name)) continue;
  const d = (await import(join(HERE, "diagrams", f) + `?v=${Date.now()}`)).default;
  for (const theme of ["light", "dark"]) {
    const file = join(OUT, `${name}${theme === "dark" ? "-dark" : ""}.svg`);
    const svg = d.raw ? d.raw(theme) : page({ ...d, body: d.body(theme), theme });
    writeFileSync(file, svg);
    try {
      execFileSync("xmllint", ["--noout", file]); // when installed: catch broken XML at once
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    console.log("ok", file);
  }
}
