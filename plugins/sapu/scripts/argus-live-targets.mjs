// argus-live-targets.mjs — element targets (spec §9): the Playwright locator forms the wrapper reads,
// parsed by a small tokenizer (never evaluated), and the code it builds from them for its own browser
// work, where every string is a JSON literal. A leaf module.

/** A ref from the CLI's last snapshot (`e15`, `f1e3`): the CLI resolves it, so it is never code. */
const REF = /^(f\d+)?e\d+$/;

/** The getBy family: method → the `by` of a parsed target. */
const GET_BY = { getByRole: "role", getByText: "text", getByLabel: "label", getByPlaceholder: "placeholder", getByTestId: "testId", getByTitle: "title", getByAltText: "altText" };
const METHOD = Object.fromEntries(Object.entries(GET_BY).map(([m, by]) => [by, m]));
/** The option keys each kind accepts. */
const OPTIONS = { role: ["name", "exact"], text: ["exact"], label: ["exact"], placeholder: ["exact"], title: ["exact"], altText: ["exact"], testId: [] };

const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;
/** The most links a chain may have (`A.getByX(…).getByY(…)…`). */
const MAX_LINKS = 32;

/**
 * A target string → `{ref}`, `{by: "role", role, name?, exact?}`, `{by: "text"|"label"|"placeholder"|
 * "testId"|"title"|"altText", value, exact?}` or `{css}` (`locator('<css>')`), each with an optional
 * `nth` (`.first()` 0, `.last()` -1, `.nth(<int>)`) and an optional `within` (the target it is chained
 * on: `A.getByX(…)`, at most 32 links). Strings are single- or double-quoted, with only the escapes `\\`, `\'` and `\"`;
 * an options object takes only the unquoted keys `name` (getByRole, a string) and `exact` (a boolean).
 * Every form accepted here is one the CLI's own locator parser accepts too (probed). Anything else —
 * a template literal, a call outside the getBy family, a second statement — throws `not a target: <s>`.
 */
export function parseTarget(s) {
  const fail = () => new Error(`not a target: ${s}`);
  if (typeof s !== "string") throw fail();
  if (REF.test(s)) return { ref: s };
  let i = 0;
  const ws = () => {
    while (s[i] === " " || s[i] === "\t") i++;
  };
  const at = (c) => {
    ws();
    return s[i] === c;
  };
  const eat = (c) => {
    if (!at(c)) throw fail();
    i++;
  };
  const ident = () => {
    ws();
    const m = /^[A-Za-z]+/.exec(s.slice(i));
    if (!m) throw fail();
    i += m[0].length;
    return m[0];
  };
  const str = () => {
    ws();
    const q = s[i];
    if (q !== "'" && q !== '"') throw fail();
    i++;
    let out = "";
    for (;;) {
      if (i >= s.length) throw fail();
      const c = s[i++];
      if (c === q) return out;
      if (c === "\\") {
        const e = s[i++];
        if (e !== "\\" && e !== "'" && e !== '"') throw fail();
        out += e;
      } else if (CONTROLS.test(c)) {
        throw fail();
      } else {
        out += c;
      }
    }
  };
  const options = (allowed) => {
    const out = {};
    eat("{");
    while (!at("}")) {
      const key = ident(); // a quoted key is refused, as the CLI's own locator parser refuses it
      if (!allowed.includes(key) || Object.hasOwn(out, key)) throw fail();
      eat(":");
      if (key === "name") out.name = str();
      else {
        const v = ident();
        if (v !== "true" && v !== "false") throw fail();
        out.exact = v === "true";
      }
      if (!at(",")) break;
      eat(",");
    }
    eat("}");
    return out;
  };

  let cur = null;
  let links = 0;
  for (;;) {
    const name = ident();
    if (Object.hasOwn(GET_BY, name) || name === "locator") {
      if (++links > MAX_LINKS) throw fail();
      eat("(");
      const arg = str();
      const by = GET_BY[name];
      let opts = {};
      if (at(",")) {
        eat(",");
        if (!by) throw fail(); // locator() takes no options
        opts = options(OPTIONS[by]);
      }
      eat(")");
      const node = !by ? { css: arg } : by === "role" ? { by, role: arg, ...opts } : { by, value: arg, ...opts };
      if (cur) node.within = cur;
      cur = node;
    } else if (cur && cur.nth === undefined && (name === "first" || name === "last")) {
      eat("(");
      eat(")");
      cur.nth = name === "first" ? 0 : -1;
    } else if (cur && cur.nth === undefined && name === "nth") {
      eat("(");
      ws();
      const m = /^-?\d{1,6}(?![\d.])/.exec(s.slice(i));
      if (!m) throw fail();
      i += m[0].length;
      eat(")");
      cur.nth = Number(m[0]);
    } else {
      throw fail();
    }
    ws();
    if (i === s.length) return cur;
    eat(".");
  }
}

/**
 * The code of a parsed target on `root` (`page`, a frame or a locator variable), every string a JSON
 * literal: `page.getByRole("button", {"name": "Account"}).nth(2)`. A ref is refused: it names an
 * element of the CLI's last snapshot, not something code can find.
 */
export function targetCode(t, root = "page") {
  const bad = () => new Error(`not code: ${JSON.stringify(t)}`);
  if (!t || typeof t !== "object") throw bad();
  if (t.ref !== undefined) throw new Error(`not code: ${t.ref} is a ref (an element of the CLI's last snapshot)`);
  let code = t.within ? targetCode(t.within, root) : root;
  if (typeof t.css === "string") {
    code += `.locator(${JSON.stringify(t.css)})`;
  } else {
    const method = typeof t.by === "string" && Object.hasOwn(METHOD, t.by) ? METHOD[t.by] : null;
    const arg = t.by === "role" ? t.role : t.value;
    if (!method || typeof arg !== "string") throw bad();
    const opts = [];
    if (t.name !== undefined) {
      if (t.by !== "role" || typeof t.name !== "string") throw bad();
      opts.push(`"name": ${JSON.stringify(t.name)}`);
    }
    if (t.exact !== undefined) {
      if (typeof t.exact !== "boolean" || t.by === "testId") throw bad();
      opts.push(`"exact": ${t.exact}`);
    }
    code += `.${method}(${JSON.stringify(arg)}${opts.length ? `, {${opts.join(", ")}}` : ""})`;
  }
  if (t.nth !== undefined) {
    if (!Number.isInteger(t.nth)) throw bad();
    code += `.nth(${t.nth})`;
  }
  return code;
}

/**
 * A target the explorer may pass to the CLI: a ref, a locator parseTarget reads, or a selector of at
 * most 500 characters without control characters and not starting with `-` (the CLI parses it; nothing
 * evaluates it; it goes after `--`, and a leading `-` is refused all the same). Else `refused: not a
 * target`.
 */
export function explorerTarget(s) {
  if (typeof s !== "string" || s === "" || s.length > 500 || s.startsWith("-") || CONTROLS.test(s)) throw new Error("refused: not a target");
  return s;
}
