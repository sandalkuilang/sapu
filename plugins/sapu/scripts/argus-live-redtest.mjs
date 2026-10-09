// argus-live-redtest.mjs — the Playwright test a sapu worker uses as its RED test (spec §10 "Issue body
// additions"), generated from a candidate's normalized repro: one page per account, each step as
// Playwright calls on a locator in targetCode's form, the final stating the correct behaviour. Every
// string of the repro is a JSON literal, a placeholder its variable — never a template literal, never code.
import { ORACLES } from "./argus-live-return.mjs";
import { targetCode } from "./argus-live-targets.mjs";

const REF = /^[1-9][0-9]?\.[1-9]\.[1-9][0-9]?$/;
const JOURNEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PLACEHOLDER = /(\{\{[a-z][a-z0-9_]*\}\})/;
const WAIT = "{ timeout: SETTLE }";
/** The names the test itself declares: a page variable never takes one. */
const OWN = ["SETTLE", "CONTEXT", "marker", "signedIn", "login", "trigger", "fact", "mail", "readValue", "collectErrors", "browser", "test", "expect"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** A placeholder's variable: `marker`, or `saved_<name>` (the prefix keeps a saved name from colliding with anything the test declares). */
const variable = (name) => (name === "marker" ? "marker" : `saved_${name}`);

/** A repro string as code: a JSON literal, a placeholder's variable, or a `+` concatenation of both. */
function str(s) {
  const parts = String(s)
    .split(PLACEHOLDER)
    .filter((p) => p !== "")
    .map((p) => (PLACEHOLDER.test(p) && /^\{\{[a-z][a-z0-9_]*\}\}$/.test(p) ? variable(p.slice(2, -2)) : JSON.stringify(p)));
  return parts.length ? parts.join(" + ") : '""';
}

/** A JSON value as code, objects spelled `{"key": value, …}` as targetCode spells its options. */
const literal = (v) => (isObj(v) ? `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${literal(x)}`).join(", ")}}` : Array.isArray(v) ? `[${v.map(literal).join(", ")}]` : JSON.stringify(v));

const HELPERS = `async function signedIn(browser: Browser, account: string, context: BrowserContextOptions): Promise<Page> {
  throw new Error("wire signedIn to this repo's E2E helpers");
}
async function trigger(name: string, values: string[]): Promise<void> {
  throw new Error("wire trigger to this repo's E2E helpers");
}
async function fact(key: string, field: string): Promise<unknown> {
  throw new Error("wire fact to this repo's E2E helpers");
}
async function mail(): Promise<unknown[]> {
  throw new Error("wire mail to this repo's E2E helpers");
}
async function readValue(target: Locator): Promise<string> {
  const v = await target.evaluate((e) => e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || e instanceof HTMLSelectElement ? e.value : (e as HTMLElement).innerText);
  return v.trim().slice(0, 500);
}
`;

/** Only when the repro has a `login` step: an account the journey created signs in on its page. */
const LOGIN = `async function login(page: Page, user: string, password: string): Promise<void> {
  throw new Error("wire login to this repo's E2E helpers");
}
`;

/** Only when the repro has a `no-error` step (decision 11): a page's 5xx responses, console errors and page errors. */
const COLLECT = `function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("response", (r) => {
    if (r.status() >= 500) errors.push(String(r.status()) + " " + r.url());
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource: the server responded with a status of ")) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}
`;

/**
 * The `@playwright/test` file of a candidate's repro → its text: `journey` (a kebab-case id), `oracle`,
 * `ref` (`<slot>.<generation>.<k>`), `context` and `steps` as parseRepro gives them, `settleMs` the run's
 * settle_ms. A header naming the command and the helpers to wire; `SETTLE`; `CONTEXT` (the viewport as
 * `{width, height: 900}`, as slotConfig sets it, `locale`, `timezoneId`); a fresh `marker`; stub helpers
 * that throw until wired (`login` and an error collector only when a step needs them); one `test` with one
 * page per account (`signedIn`, or a bare page for `anon` and an account whose first step is a `login`),
 * each step as Playwright calls, expectations waiting up to `SETTLE`, `fact-equals` and `mail` through
 * `expect.poll`, a `parallel` group as `Promise.all`, and the final under its comment. Throws `failed:
 * redTest: …` on a header field of another shape.
 */
export function redTest({ journey, oracle, ref, context, steps, settleMs }) {
  if (typeof journey !== "string" || !JOURNEY.test(journey)) throw new Error("failed: redTest: a journey id is kebab-case");
  if (!ORACLES.includes(oracle)) throw new Error("failed: redTest: not an oracle");
  if (typeof ref !== "string" || !REF.test(ref)) throw new Error("failed: redTest: a ref is <slot>.<generation>.<k>");
  if (!Number.isInteger(settleMs) || settleMs < 0) throw new Error("failed: redTest: settle_ms is a whole number");
  const taken = new Set([...OWN, ...steps.filter((s) => s.save).map((s) => variable(s.save))]);
  /** Each account (`<role>.<k>`, in the order it first acts) → its page variable: `customer.1` → `customer1`. */
  const pages = new Map();
  for (const s of steps) {
    if (s.as === "system" || pages.has(s.as)) continue;
    const [role, k] = s.as.split(".");
    let v = `${/^[A-Za-z_]/.test(role) ? "" : "_"}${role.replace(/[^A-Za-z0-9_]/g, "_")}${k}`;
    while (taken.has(v)) v += "_";
    taken.add(v);
    pages.set(s.as, { v, first: s, errors: false });
  }
  for (const s of steps) if (s.expect === "no-error") pages.get(s.as).errors = true;
  const hasLogin = steps.some((s) => s.do === "login");
  const anyErrors = [...pages.values()].some((p) => p.errors);
  const loc = (s) => targetCode(s.target, pages.get(s.as).v, str);

  /** An action's call, without `await` (a parallel group's members are these). */
  const call = (s) => {
    const p = s.as === "system" ? null : pages.get(s.as).v;
    switch (s.do) {
      case "goto":
        return `${p}.goto(${str(s.path)})`;
      case "go-back":
        return `${p}.goBack()`;
      case "reload":
        return `${p}.reload()`;
      case "press":
        return s.target ? `${loc(s)}.press(${JSON.stringify(s.key)})` : `${p}.keyboard.press(${JSON.stringify(s.key)})`;
      case "fill":
        return `${loc(s)}.fill(${str(s.value)})`;
      case "select":
        return `${loc(s)}.selectOption(${str(s.value)})`;
      case "read":
        return `readValue(${loc(s)})`;
      case "login":
        return `login(${p}, ${str(s.user)}, ${str(s.password)})`;
      case "trigger":
        return `trigger(${str(s.name)}, [${s.values.map(str).join(", ")}])`;
      default:
        return `${loc(s)}.${s.do}()`; // click, dblclick, hover, check, uncheck
    }
  };
  /** An expectation's statement. */
  const expectation = (s) => {
    const p = s.as === "system" ? null : pages.get(s.as).v;
    const value = typeof s.value === "string" ? str(s.value) : JSON.stringify(s.value);
    switch (s.expect) {
      case "visible":
        return `await expect(${loc(s)}).toBeVisible(${WAIT});`;
      case "hidden":
        return `await expect(${loc(s)}).toBeHidden(${WAIT});`;
      case "enabled":
        return `await expect(${loc(s)}).toBeEnabled(${WAIT});`;
      case "text-equals":
        return `await expect(${loc(s)}).toHaveText(${value}, ${WAIT});`;
      case "text-contains":
        return `await expect(${loc(s)}).toContainText(${value}, ${WAIT});`;
      case "value-equals":
        return `await expect(${loc(s)}).toHaveValue(${value}, ${WAIT});`;
      case "count":
        return `await expect(${loc(s)}).toHaveCount(${value}, ${WAIT});`;
      case "url":
        return `await expect(${p}).toHaveURL((u) => u.pathname + u.search === ${value} || u.pathname === ${value}, ${WAIT});`;
      case "fact-equals":
        return `await expect.poll(() => fact(${str(s.marker)}, ${str(s.field)}), ${WAIT}).toBe(${value});`;
      case "mail":
        return `await expect.poll(async () => (await mail()).some((m) => { const x = m as Record<string, unknown>; return x.to === ${str(s.to)} && (String(x.subject) + "\\n" + String(x.text)).includes(${str(s.contains)}); }), ${WAIT}).toBe(true);`;
      default:
        return `expect(errors_${p}).toEqual([]);`; // no-error
    }
  };

  const body = [];
  for (const [account, { v, first }] of pages) {
    const bare = account.startsWith("anon.") || first.do === "login";
    body.push(bare ? `const ${v} = await browser.newPage(CONTEXT);` : `const ${v} = await signedIn(browser, ${JSON.stringify(account)}, CONTEXT);`);
  }
  for (const { v, errors } of pages.values()) if (errors) body.push(`const errors_${v} = collectErrors(${v});`);
  // A no-error reads the account's errors since the previous step (decision 11): its collector is cleared right before that step.
  const clearBefore = new Map();
  steps.forEach((s, i) => {
    if (s.expect === "no-error" && i > 0) clearBefore.set(steps[i - 1].n, `errors_${pages.get(s.as).v}.length = 0;`);
  });
  for (let i = 0; i < steps.length; ) {
    const s = steps[i];
    const group = s.group ? steps.filter((x) => x.group === s.group) : [s];
    i += group.length;
    for (const g of group) if (clearBefore.has(g.n)) body.push(clearBefore.get(g.n));
    if (s.final !== undefined) body.push(`// final (${oracle}): the correct behaviour, RED while the defect is there`);
    if (group.length > 1) {
      const names = group.map((g) => (g.do === "read" ? variable(g.save) : ""));
      body.push(`${names.some(Boolean) ? `const [${names.join(", ")}] = ` : ""}await Promise.all([`, ...group.map((g) => `  ${call(g)},`), "]);");
    } else if (s.do === "read") body.push(`const ${variable(s.save)} = await ${call(s)};`);
    else if (s.do) body.push(`await ${call(s)};`);
    else body.push(expectation(s));
  }

  const ctx = { viewport: { width: context.viewport, height: 900 }, locale: context.locale, timezoneId: context.timezone };
  return [
    `// Generated by argus-live.mjs repro ${ref} --test: journey ${journey}, oracle ${oracle}.`,
    `// RED until the defect is fixed. Wire signedIn, ${hasLogin ? "login, " : ""}trigger, fact and mail to this repo's E2E helpers.`,
    'import { test, expect } from "@playwright/test";',
    'import type { Browser, BrowserContextOptions, Locator, Page } from "@playwright/test";',
    "",
    `const SETTLE = ${settleMs};`,
    `const CONTEXT: BrowserContextOptions = ${literal(ctx)};`,
    "const marker = `argus-${Date.now().toString(36)}`;",
    "",
    `${HELPERS}${hasLogin ? LOGIN : ""}${anyErrors ? COLLECT : ""}`,
    `test(${JSON.stringify(`${journey}: ${oracle} (${ref})`)}, async ({ browser }) => {`,
    ...body.map((l) => `  ${l}`),
    "});",
    "",
  ].join("\n");
}
