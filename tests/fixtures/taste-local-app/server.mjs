#!/usr/bin/env node
// tests/fixtures/taste-local-app/server.mjs — the tiny app tests/taste-calibrate-local.test.ts fetches (as a pinned
// commit), runs through argus-live up/down and measures, standing in for an OSS reference app (no dependencies).
//   node server.mjs                 listens on 127.0.0.1:$PORT; GET /health → 200
//   node server.mjs --which-store   prints the store its configuration names: taste_explore
//   node server.mjs --reset         nothing to reset; exits 0
// Signed in = a `sid` cookie naming a session this process made. /login (email, password, "Sign in"; the one account
// is member@example.test with password $APP_PW) signs in and redirects to /. Every other page needs a session (else
// a redirect to /login) and has a header button "Account":
//   app   /, /projects, /activity          form  /settings/profile, /projects/new
//   data  /members, /invoices (12 rows each)
// Pages answer prefers-color-scheme (a dark palette), and $VARIANT (a or b) changes the spacing scale, so two
// instances measure apart. Every page shows $CANARY as text: a calibration must never keep it.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

if (process.argv.includes("--which-store")) {
  process.stdout.write("taste_explore\n");
  process.exit(0);
}
if (process.argv.includes("--reset")) process.exit(0);

const PASSWORD = process.env.APP_PW ?? "";
const CANARY = process.env.CANARY ?? "";
const wide = process.env.VARIANT === "b";
const sessions = new Set();
const space = wide ? [6, 12, 20, 28] : [4, 8, 16, 24];

const page = (title, body, signedIn = true) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: rgb(255, 255, 255); color: rgb(20, 20, 30); }
  header { display: flex; justify-content: space-between; padding: ${space[1]}px ${space[2]}px; border-bottom: 1px solid rgb(220, 220, 230); }
  main { padding: ${space[2]}px; max-width: 960px; }
  h1 { font-size: 28px; margin: 0 0 ${space[2]}px; }
  p, .card { margin: 0 0 ${space[1]}px; }
  .card { padding: ${space[2]}px; border: 1px solid rgb(220, 220, 230); border-radius: ${wide ? 10 : 6}px; }
  button, input { font: inherit; padding: ${space[0]}px ${space[1]}px; border-radius: 6px; }
  .primary { background: rgb(40, 90, 220); color: rgb(255, 255, 255); border: 0; }
  table { border-collapse: collapse; width: 100%; } td, th { padding: ${space[0]}px ${space[1]}px; text-align: left; border-bottom: 1px solid rgb(230, 230, 236); }
  label { display: block; margin: 0 0 ${space[0]}px; }
  @media (prefers-color-scheme: dark) {
    body { background: rgb(16, 16, 22); color: rgb(230, 230, 240); }
    header, .card { border-color: rgb(60, 60, 72); }
    td, th { border-color: rgb(50, 50, 62); }
    .primary { background: rgb(90, 140, 255); color: rgb(10, 10, 20); }
  }
</style></head>
<body>${signedIn ? `<header><a href="/">Home</a><button type="button">Account</button></header>` : ""}<main><h1>${title}</h1>${body}<p class="note">Ref ${CANARY}</p></main></body></html>`;

const rows = (n, cells) => `<table><thead><tr>${cells.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${Array.from({ length: n }, (_, i) => `<tr>${cells.map((c) => `<td>${c} ${i + 1}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
const field = (label, name, type = "text") => `<label for="${name}">${label}</label><p><input id="${name}" name="${name}" type="${type}"></p>`;
const PAGES = {
  "/": ["Overview", `<div class="card"><p>Three projects are active.</p><button class="primary" type="button">New project</button></div><div class="card"><p>Nothing is overdue.</p></div>`],
  "/projects": ["Projects", `<div class="card"><p>Website refresh</p></div><div class="card"><p>Billing export</p></div><button class="primary" type="button">Create project</button>`],
  "/activity": ["Activity", `<div class="card"><p>Ada commented on Billing export.</p></div><div class="card"><p>Lin closed two tasks.</p></div>`],
  "/settings/profile": ["Profile", `<form>${field("Name", "name")}${field("Email", "email", "email")}<button class="primary" type="submit">Save profile</button></form>`],
  "/projects/new": ["New project", `<form>${field("Project name", "title")}${field("Start", "start", "date")}<button class="primary" type="submit">Create project</button></form>`],
  "/members": ["Members", rows(12, ["Member", "Role", "Joined"])],
  "/invoices": ["Invoices", rows(12, ["Invoice", "Amount", "Status"])],
};

const cookie = (req) => /(?:^|;\s*)sid=([0-9a-f]{32})/.exec(req.headers.cookie ?? "")?.[1] ?? null;
const send = (res, status, html, headers = {}) => res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers }).end(html);
const loginPage = (error = "") => page("Sign in", `<form method="post" action="/login">${error ? `<p role="alert">${error}</p>` : ""}${field("Email", "email", "email")}${field("Password", "password", "password")}<button class="primary" type="submit">Sign in</button></form>`, false);

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/health") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  if (url.pathname === "/login" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const f = new URLSearchParams(body);
      if (f.get("email") !== "member@example.test" || f.get("password") !== PASSWORD || !PASSWORD) return send(res, 401, loginPage("Wrong email or password."));
      const sid = randomBytes(16).toString("hex");
      sessions.add(sid);
      res.writeHead(303, { location: "/", "set-cookie": `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` }).end();
    });
    return;
  }
  if (url.pathname === "/login") return send(res, 200, loginPage());
  if (!Object.hasOwn(PAGES, url.pathname)) return send(res, 404, page("Not found", "<p>No such page.</p>", false));
  if (!sessions.has(cookie(req))) return void res.writeHead(302, { location: "/login" }).end();
  const [title, body] = PAGES[url.pathname];
  send(res, 200, page(title, body));
}).listen(Number(process.env.PORT), "127.0.0.1");
