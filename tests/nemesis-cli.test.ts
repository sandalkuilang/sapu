// tests/nemesis-cli.test.ts — scripts/nemesis-cli.mjs gives the model-driven nemesis skill two teeth it
// cannot give itself from prose: coverageReport proves what this cycle's authorization pass actually tested
// against the surface it should have (structured probes: two distinct accounts, a seeded or fixture object, the
// owner's own 2xx as the positive control, the foreign status and outcome; a write is judged by the owner's
// read-back, not the foreign response), and the host floor refuses any authorized target the floor does not allow:
// a name other than localhost / *.localhost / *.test, a public address, or a spelling URL parsers could read two ways.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script without types
import { coverageReport, gateVerdict, hostFloor, hostOf } from "../plugins/sapu/scripts/nemesis-cli.mjs";

const CLI = join(__dirname, "../plugins/sapu/scripts/nemesis-cli.mjs");
const run = (script: string, args: string[], node: string[] = []) => spawnSync(process.execPath, [...node, script, ...args], { encoding: "utf8" });
const cli = (...args: string[]) => run(CLI, args);
const CYCLE = "cycle-7";

const surface = { id_bearing: ["GET /orders/:id", "PATCH /orders/:id", "GET /invoices/:id"] };
const probe = (over: Record<string, unknown> = {}) => ({
  cycle: CYCLE,
  endpoint: "GET /orders/:id",
  object: "order",
  actors: ["alice", "bob"],
  object_source: "seeded",
  owner_status: 200,
  foreign_status: 404,
  outcome: "denied",
  ...over,
});
const write = (over: Record<string, unknown> = {}) =>
  probe({ endpoint: "PATCH /orders/:id", object_source: "fixture", owner_status: 200, foreign_status: 404, owner_after: "unchanged", outcome: "denied", ...over });
const report = (probes: unknown[], surf: unknown = surface, cycle: string | undefined = CYCLE) => coverageReport({ coverage: { probes }, surface: surf, cycle });

describe("nemesis coverageReport — a structured ownership probe, not a sentence", () => {
  it("counts a read probe with two accounts, a seeded object, the owner's 2xx and the foreign denial", () => {
    const r = report([probe()]);
    expect(r.probed).toBe(1);
    expect(r.weak).toEqual([]);
    expect(r.uncovered).toEqual(["PATCH /orders/:id", "GET /invoices/:id"]);
    expect(r.total).toBe(3);
  });

  it("counts a found IDOR as probed and lists it as a leak to file — finding a bug never blocks coverage", () => {
    const r = report([probe({ foreign_status: 200, outcome: "leaked" })], { id_bearing: ["GET /orders/:id"] });
    expect(r.probed).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.leaks.map((l: { endpoint: string }) => l.endpoint)).toEqual(["GET /orders/:id"]);
    expect(r.lines.join("\n")).toMatch(/LEAKED/);
  });

  it("rejects a random, ghost or guessed id — only a real seeded row or a fixture the cycle made proves ownership", () => {
    for (const object_source of ["random", "ghost", "guessed", undefined]) {
      const r = report([probe({ object_source })]);
      expect(r.probed, String(object_source)).toBe(0);
      expect(r.weak[0].reason).toMatch(/seeded/);
    }
    expect(report([probe({ object_source: "fixture" })]).probed).toBe(1);
  });

  it("rejects a read probe with no positive control — the owner's own request must be 2xx", () => {
    for (const owner_status of [undefined, 404, "200", true]) {
      const r = report([probe({ owner_status })]);
      expect(r.probed, String(owner_status)).toBe(0);
      expect(r.weak[0].reason).toMatch(/positive control/i);
    }
  });

  it("rejects one account written twice, however spaced or cased, or empty names", () => {
    for (const actors of [["alice"], ["alice", "alice"], ["alice", "alice "], ["alice", "ALICE"], [null, null], ["", "bob"], "alice,bob"]) {
      const r = report([probe({ actors })]);
      expect(r.probed, JSON.stringify(actors)).toBe(0);
      expect(r.weak[0].reason).toMatch(/two accounts/i);
    }
  });

  it("rejects a probe with no foreign status or no outcome", () => {
    expect(report([probe({ foreign_status: undefined })]).weak[0].reason).toMatch(/foreign_status/);
    expect(report([probe({ foreign_status: 4040 })]).weak[0].reason).toMatch(/foreign_status/);
    expect(report([probe({ outcome: "held" })]).weak[0].reason).toMatch(/outcome/);
  });

  it("a read whose outcome its own statuses contradict is weak — a 2xx marked denied, a leak that was refused", () => {
    expect(report([probe({ foreign_status: 200 })]).weak[0].reason).toMatch(/foreign_body/);
    expect(report([probe({ foreign_status: 403, outcome: "leaked" })]).weak[0].reason).toMatch(/leaked/);
    expect(report([probe({ foreign_status: 200, foreign_body: "empty" })]).probed).toBe(1);
  });

  it("rejects a probe whose endpoint is not a METHOD /path string", () => {
    for (const endpoint of ["", "   ", ["GET /orders/:id"], undefined, "get /orders/:id"]) {
      expect(report([probe({ endpoint })]).weak[0].reason, JSON.stringify(endpoint)).toMatch(/METHOD \/path/);
    }
  });

  it("treats a non-object probe as weak instead of crashing", () => {
    const r = report([null, "GET /orders/:id", probe()]);
    expect(r.probed).toBe(1);
    expect(r.weak).toHaveLength(2);
  });
});

describe("nemesis coverageReport — a write is judged by the owner's read-back, not the foreign response", () => {
  it("counts a refused write whose fixture the owner reads back unchanged", () => {
    const r = report([write()]);
    expect(r.probed).toBe(1);
    expect(r.weak).toEqual([]);
  });

  it("a foreign 2xx write that changed nothing is denied; one that changed the object is a leak", () => {
    expect(report([write({ foreign_status: 204, owner_after: "unchanged", outcome: "denied" })]).probed).toBe(1);
    const leak = report([write({ foreign_status: 204, owner_after: "changed", outcome: "leaked" })]);
    expect(leak.probed).toBe(1);
    expect(leak.leaks).toHaveLength(1);
  });

  it("never lets a write that changed the object pass as denied, whatever the foreign response said", () => {
    for (const foreign_status of [204, 200, 403, 404]) {
      const r = report([write({ foreign_status, owner_after: "changed", outcome: "denied", foreign_body: "empty" })]);
      expect(r.probed, String(foreign_status)).toBe(0);
      expect(r.weak[0].reason).toMatch(/owner_after/);
    }
  });

  it("a write needs the owner's read-back; foreign_body empty never stands in for it", () => {
    const r = report([write({ owner_after: undefined, foreign_status: 204, foreign_body: "empty" })]);
    expect(r.probed).toBe(0);
    expect(r.weak[0].reason).toMatch(/owner_after/);
  });

  it("a deleted fixture is a leak with no 2xx read-back required; an untouched one still needs the owner's 2xx", () => {
    const del = { endpoint: "DELETE /orders/:id" };
    expect(report([write({ ...del, foreign_status: 204, owner_status: 404, owner_after: "changed", outcome: "leaked" })], { id_bearing: ["DELETE /orders/:id"] }).ok).toBe(true);
    expect(report([write({ ...del, owner_status: 404 })], { id_bearing: ["DELETE /orders/:id"] }).weak[0].reason).toMatch(/positive control/i);
  });

  it("a PATCH, PUT or DELETE is always a write — a declared read never skips the read-back", () => {
    for (const endpoint of ["PATCH /orders/:id", "PUT /orders/:id", "DELETE /orders/:id"]) {
      const r = report([probe({ endpoint, access: "read", foreign_status: 204, foreign_body: "empty" })], { id_bearing: [endpoint] });
      expect(r.ok, endpoint).toBe(false);
      expect(r.weak[0].reason, endpoint).toMatch(/always a write/);
    }
  });

  it("a write probe on shared seed data is weak — writes go to a fixture the cycle created", () => {
    const r = report([write({ object_source: "seeded" })]);
    expect(r.probed).toBe(0);
    expect(r.weak[0].reason).toMatch(/fixture/);
  });

  it("matches a cycle recorded as a number against the same --cycle", () => {
    expect(coverageReport({ coverage: { probes: [probe({ cycle: 7 })] }, surface: { id_bearing: ["GET /orders/:id"] }, cycle: "7" }).ok).toBe(true);
  });

  it("a declared access overrides the method — a GraphQL query is a read", () => {
    const gql = { endpoint: "POST /graphql#orderById", access: "read" };
    expect(report([probe(gql)], { id_bearing: ["POST /graphql#orderById"] }).ok).toBe(true);
    expect(report([probe({ endpoint: "POST /graphql#orderById" })], { id_bearing: ["POST /graphql#orderById"] }).weak[0].reason).toMatch(/owner_after/);
  });
});

describe("nemesis coverageReport — this cycle's probes against this cycle's surface", () => {
  it("rejects a probe recorded in another cycle — stale coverage never proves this one", () => {
    const r = report([probe({ cycle: "cycle-3" })]);
    expect(r.probed).toBe(0);
    expect(r.weak[0].reason).toMatch(/cycle/);
    expect(report([probe({ cycle: undefined })]).weak[0].reason).toMatch(/cycle/);
  });

  it("counts a duplicated surface entry once", () => {
    const r = report([probe()], { id_bearing: ["GET /orders/:id", "GET /orders/:id"] });
    expect(r.total).toBe(1);
    expect(r.ok).toBe(true);
  });

  it("names a probed endpoint missing from the surface — the denominator is short, so not ok", () => {
    const all = [probe(), write(), probe({ endpoint: "GET /invoices/:id" })];
    const r = report([...all, write({ endpoint: "DELETE /orders/:id" })]);
    expect(r.offSurface).toEqual(["DELETE /orders/:id"]);
    expect(r.ok).toBe(false);
  });

  it("names surface entries that are not METHOD /path strings instead of dropping them", () => {
    const r = report([probe()], { id_bearing: ["GET /orders/:id", { endpoint: "GET /b/:id" }, 42] });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/not a "METHOD \/path" string: 2/);
    expect(report([probe()], { id_bearing: "GET /orders/:id" }).ok).toBe(false);
  });

  it("an empty surface is unproven, not clean, and says to map it first", () => {
    const r = report([], { id_bearing: [] });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/map them from recon/i);
  });

  it("ok only when every id-bearing endpoint has a real probe and nothing is weak", () => {
    const all = [probe(), write(), probe({ endpoint: "GET /invoices/:id" })];
    expect(report(all).ok).toBe(true);
    expect(report(all.slice(1)).ok).toBe(false);
    expect(report([...all, probe({ owner_status: 500 })]).ok).toBe(false);
  });

  it("writes one probed/total line a report can paste", () => {
    expect(report([probe()]).lines.join("\n")).toMatch(/1\s*\/\s*3/);
  });
});

describe("nemesis hostFloor — a resolved public address is refused even when listed", () => {
  it("allows loopback, refuses public, allows private only when the target marks it dev", () => {
    const refusals = hostFloor([
      { host: "localhost", addresses: ["127.0.0.1"] },
      { host: "app.test", addresses: ["::1"] },
      { host: "10.1.2.3", addresses: ["10.1.2.3"], authorizedPrivate: true },
      { host: "192.168.1.9", addresses: ["192.168.1.9"] },
      { host: "93.184.216.34", addresses: ["93.184.216.34"] },
    ]);
    expect(refusals.map((r: { host: string }) => r.host)).toEqual(["192.168.1.9", "93.184.216.34"]);
    expect(refusals.find((r: { host: string }) => r.host === "93.184.216.34").reason).toMatch(/public/i);
    expect(refusals.find((r: { host: string }) => r.host === "192.168.1.9").reason).toMatch(/private/i);
  });

  it("refuses a host that resolves to a mix of loopback and public (DNS-rebind shape)", () => {
    expect(hostFloor([{ host: "evil.test", addresses: ["127.0.0.1", "93.184.216.34"] }]).map((r: { host: string }) => r.host)).toEqual(["evil.test"]);
  });

  it("refuses a host that resolves to nothing", () => {
    expect(hostFloor([{ host: "void.test", addresses: [] }]).map((r: { host: string }) => r.host)).toEqual(["void.test"]);
  });
});

describe("nemesis gateVerdict — the floor's name rule and address rule, as the CLI applies them", () => {
  it("passes localhost, *.localhost, *.test and IP literals that resolve loopback; flags a private IP literal", () => {
    const v = gateVerdict([
      { host: "localhost", addresses: ["127.0.0.1", "::1"] },
      { host: "localhost.", addresses: ["127.0.0.1"] },
      { host: "app.localhost", addresses: ["127.0.0.1"] },
      { host: "shop.test", addresses: ["127.0.0.1"] },
      { host: "127.0.0.1", addresses: ["127.0.0.1"] },
      { host: "10.1.2.3", addresses: ["10.1.2.3"] },
    ]);
    expect(v.hard).toEqual([]);
    expect(v.advisory.map((t: { host: string }) => t.host)).toEqual(["10.1.2.3"]);
  });

  it("refuses a public DNS name even when it resolves to loopback today — it can rebind", () => {
    const v = gateVerdict([
      { host: "localtest.me", addresses: ["127.0.0.1"] },
      { host: "127.0.0.1.nip.io", addresses: ["127.0.0.1"] },
      { host: "api.prod-example.com", addresses: ["127.0.0.1"] },
    ]);
    expect(v.hard.map((r: { host: string }) => r.host)).toEqual(["localtest.me", "127.0.0.1.nip.io", "api.prod-example.com"]);
    expect(v.hard[0].reason).toMatch(/localhost, \*\.localhost, \*\.test/);
  });

  it("refuses an allowed name that resolves to a private or public address — a name must resolve loopback", () => {
    const v = gateVerdict([
      { host: "db.test", addresses: ["10.0.0.5"] },
      { host: "evil.test", addresses: ["93.184.216.34"] },
    ]);
    expect(v.hard.map((r: { host: string }) => r.host)).toEqual(["db.test", "evil.test"]);
    expect(v.advisory).toEqual([]);
  });

  it("refuses a public IP literal and an address-less target", () => {
    const v = gateVerdict([
      { host: "93.184.216.34", addresses: ["93.184.216.34"] },
      { host: "void.test", addresses: [] },
    ]);
    expect(v.hard.map((r: { host: string }) => r.host)).toEqual(["93.184.216.34", "void.test"]);
  });

  it("says an ambiguous spelling is ambiguous, not that the server is down", () => {
    const v = gateVerdict([{ host: '"http://a\\\\b"', addresses: [], ambiguous: true }]);
    expect(v.hard[0].reason).toMatch(/ambiguous/);
    expect(v.hard[0].reason).not.toMatch(/no address/);
  });
});

describe("nemesis hostOf — reads a target the way the attacking clients (WHATWG) do", () => {
  it("drops scheme, port, path, userinfo; unwraps IPv6; normalizes like fetch does", () => {
    expect(hostOf("http://localhost:4000")).toBe("localhost");
    expect(hostOf("https://app.test:8443/api/v1?x=1#y")).toBe("app.test");
    expect(hostOf("localhost:3000")).toBe("localhost");
    expect(hostOf("http://u:p@127.0.0.1:80")).toBe("127.0.0.1");
    expect(hostOf("http://[::1]:8080/")).toBe("::1");
    expect(hostOf("::1")).toBe("::1");
    expect(hostOf("127.0.0.1")).toBe("127.0.0.1");
    expect(hostOf(" localhost ")).toBe("localhost");
    expect(hostOf("http://localhost:/")).toBe("localhost");
    expect(hostOf("http://2130706433/")).toBe("127.0.0.1");
  });

  it("reads a special scheme with any number of slashes the way fetch and curl do", () => {
    expect(hostOf("http:/evil.example")).toBe("evil.example");
    expect(hostOf("HTTPS:/evil.example:8443/x")).toBe("evil.example");
    expect(hostOf("ws:/evil.example")).toBe("evil.example");
    expect(hostOf("ftp:/evil.example")).toBe("evil.example");
    expect(hostOf("http:evil.example")).toBe("evil.example");
  });

  it("refuses a non-http scheme or a scheme-less userinfo — ambiguous, nothing to resolve", () => {
    for (const t of ["file:///etc/hosts", "data:text/plain,127.0.0.1", "smtp:/evil.example", "gopher://127.0.0.1/", "u:p@127.0.0.1:80", "foo:bar"]) {
      expect(hostOf(t), t).toBe("");
    }
  });

  it("never reads a target as loopback when a client would connect elsewhere (allow-direction)", () => {
    for (const t of [
      "http://evil.example.com\\@127.0.0.1/",
      "http://evil.example.com/x\n@127.0.0.1",
      "http://evil.example.com/x\r@127.0.0.1",
      "http://evil.example.com/x" + String.fromCharCode(0x2028) + "@127.0.0.1",
      "http://evil.example.com/x\t@127.0.0.1",
      "[::1].evil.example.com",
      "http://[::1].evil.example.com/",
    ]) {
      const h = hostOf(t);
      expect(["127.0.0.1", "::1", "localhost"], JSON.stringify(t)).not.toContain(h);
      if (h) expect(new URL(/:\/\//.test(t) ? t : `http://${t}`).hostname, JSON.stringify(t)).toBe(h);
    }
  });
});

describe("nemesis-cli — the exit codes nemesis acts on", () => {
  const files = (cov: unknown, surf: unknown) => {
    const d = mkdtempSync(join(tmpdir(), "nemesis-cli-"));
    writeFileSync(join(d, "c.json"), JSON.stringify(cov));
    writeFileSync(join(d, "s.json"), JSON.stringify(surf));
    return [join(d, "c.json"), join(d, "s.json")];
  };

  it("gate passes a loopback URL and host:port, refuses an address that resolves nowhere", () => {
    expect(cli("gate", "http://localhost:4000", "127.0.0.1:3000").status).toBe(0);
    const r = cli("gate", "http://nothing.invalid:4000");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/host floor REFUSED/);
  });

  it("gate refuses an ambiguous target and says why", () => {
    const r = cli("gate", "http://evil.example.invalid\\@127.0.0.1/");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/ambiguous/);
  });

  it("still runs — and refuses — from a folder with a space, through a symlink, and with --preserve-symlinks-main", () => {
    const d = mkdtempSync(join(tmpdir(), "nemesis cli "));
    mkdirSync(join(d, "plug dir"));
    const copy = join(d, "plug dir", "nemesis-cli.mjs");
    copyFileSync(CLI, copy);
    const link = join(d, "link.mjs");
    symlinkSync(copy, link);
    for (const [script, node] of [[copy, []], [link, []], [link, ["--preserve-symlinks-main"]]] as const) {
      const r = run(script, ["gate", "8.8.8.8"], [...node]);
      expect(r.status, `${script} ${node}`).toBe(1);
      expect(r.stdout, `${script} ${node}`).toMatch(/host floor REFUSED/);
    }
  });

  it("coverage exits 1 when incomplete and 0 when every id-bearing endpoint has a real probe this cycle", () => {
    const [c0, s] = files({ probes: [] }, { id_bearing: ["GET /orders/:id"] });
    expect(cli("coverage", c0, s, "--cycle", CYCLE).status).toBe(1);
    const [c1, s1] = files({ probes: [probe()] }, { id_bearing: ["GET /orders/:id"] });
    expect(cli("coverage", c1, s1, "--cycle", CYCLE).status).toBe(0);
    expect(cli("coverage", c1, s1, "--cycle", "cycle-9").status).toBe(1);
    expect(cli("coverage", c1, s1, `--cycle=${CYCLE}`).status).toBe(0);
  });

  it("coverage needs --cycle and the two lists, else it is an input error (2)", () => {
    const [c1, s1] = files({ probes: [probe()] }, { id_bearing: ["GET /orders/:id"] });
    expect(cli("coverage", c1, s1).status).toBe(2);
    const [c2, s2] = files({ probe: [probe()] }, { id_bearing: ["GET /orders/:id"] });
    const r = cli("coverage", c2, s2, "--cycle", CYCLE);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/"probes"/);
    const [c3, s3] = files({ probes: [] }, { endpoints: [] });
    expect(cli("coverage", c3, s3, "--cycle", CYCLE).stderr).toMatch(/"id_bearing"/);
  });

  it("a long report reaches a pipe whole, verdict line included", () => {
    const ids = Array.from({ length: 20000 }, (_, i) => `GET /things/${i}/:id`);
    const [c, s] = files({ probes: [] }, { id_bearing: ids });
    const r = spawnSync("sh", ["-c", `"${process.execPath}" "${CLI}" coverage "${c}" "${s}" --cycle ${CYCLE} | tail -n 1`], { encoding: "utf8" });
    expect(r.stdout).toMatch(/^NOT COMPLETE/);
  });

  it("a missing argument or an unreadable file is an input error (2), never a pass", () => {
    expect(cli("coverage").status).toBe(2);
    expect(cli("gate").status).toBe(2);
    const d = mkdtempSync(join(tmpdir(), "nemesis-null-"));
    writeFileSync(join(d, "n.json"), "null");
    expect(cli("coverage", join(d, "n.json"), join(d, "n.json"), "--cycle", CYCLE).status).toBe(2);
    const r = cli("coverage", "/nonexistent/c.json", "/nonexistent/s.json", "--cycle", CYCLE);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/cannot read/);
  });
});
