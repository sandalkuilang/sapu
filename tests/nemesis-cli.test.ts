// tests/nemesis-cli.test.ts — scripts/nemesis-cli.mjs gives the model-driven nemesis skill two teeth it
// cannot give itself from prose: coverageReport proves what the authorization pass actually tested against
// the surface it should have (structured probes: two distinct accounts, a seeded object, the owner's 2xx as the
// positive control, the foreign request's status and outcome — a found leak counts as probed and is listed), and
// the host floor refuses any authorized target that resolves to a public address, parsing targets the way the
// clients that will attack them do (WHATWG), so no string can read as loopback here and connect elsewhere.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script without types
import { coverageReport, gateVerdict, hostFloor, hostOf } from "../plugins/sapu/scripts/nemesis-cli.mjs";

const CLI = join(__dirname, "../plugins/sapu/scripts/nemesis-cli.mjs");
const run = (script: string, ...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
const cli = (...args: string[]) => run(CLI, ...args);

const surface = { id_bearing: ["GET /orders/:id", "POST /orders/:id/payments", "GET /invoices/:id"] };
const probe = (over: Record<string, unknown> = {}) => ({
  endpoint: "GET /orders/:id",
  object: "order",
  actors: ["alice", "bob"],
  object_source: "seeded",
  owner_status: 200,
  foreign_status: 404,
  outcome: "denied",
  ...over,
});
const report = (probes: unknown[], surf = surface) => coverageReport({ coverage: { probes }, surface: surf });

describe("nemesis coverageReport — a structured ownership probe, not a sentence", () => {
  it("counts a probe with two accounts, a seeded object, the owner's 2xx and the foreign denial", () => {
    const r = report([probe()]);
    expect(r.probed).toBe(1);
    expect(r.weak).toEqual([]);
    expect(r.uncovered).toEqual(["POST /orders/:id/payments", "GET /invoices/:id"]);
    expect(r.total).toBe(3);
  });

  it("counts a found IDOR as probed and lists it as a leak to file — finding a bug never blocks coverage", () => {
    const r = report([probe({ foreign_status: 200, outcome: "leaked" })], { id_bearing: ["GET /orders/:id"] });
    expect(r.probed).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.leaks.map((l: { endpoint: string }) => l.endpoint)).toEqual(["GET /orders/:id"]);
    expect(r.lines.join("\n")).toMatch(/LEAKED/);
  });

  it("rejects a random, ghost or guessed id — only a real seeded row proves ownership", () => {
    for (const object_source of ["random", "ghost", "guessed", undefined]) {
      const r = report([probe({ object_source })]);
      expect(r.probed, String(object_source)).toBe(0);
      expect(r.weak[0].reason).toMatch(/seeded/);
    }
  });

  it("rejects a missing positive control — the owner's own request must be 2xx", () => {
    for (const owner_status of [undefined, 404, "200", true]) {
      const r = report([probe({ owner_status })]);
      expect(r.probed, String(owner_status)).toBe(0);
      expect(r.weak[0].reason).toMatch(/positive control/i);
    }
  });

  it("rejects one account written twice, or empty account names", () => {
    for (const actors of [["alice"], ["alice", "alice"], [null, null], ["", "bob"], "alice,bob"]) {
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

  it("flags an outcome its own statuses contradict — a 2xx marked denied, a leak that was refused", () => {
    expect(report([probe({ foreign_status: 200 })]).weak[0].reason).toMatch(/foreign_body/);
    expect(report([probe({ foreign_status: 403, outcome: "leaked" })]).weak[0].reason).toMatch(/leaked/);
    expect(report([probe({ foreign_status: 200, foreign_body: "empty" })]).probed).toBe(1);
  });

  it("counts one account once however it is spaced or cased", () => {
    for (const actors of [["alice", "alice "], ["alice", "ALICE"]]) expect(report([probe({ actors })]).probed, JSON.stringify(actors)).toBe(0);
  });

  it("rejects a probe whose endpoint is not a METHOD /path string", () => {
    for (const endpoint of ["", "   ", ["GET /orders/:id"], undefined]) {
      expect(report([probe({ endpoint })]).weak[0].reason, JSON.stringify(endpoint)).toMatch(/METHOD \/path/);
    }
  });

  it("names surface entries that are not METHOD /path strings instead of dropping them", () => {
    const r = report([probe()], { id_bearing: ["GET /orders/:id", { endpoint: "GET /b/:id" }, 42] } as never);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/not a "METHOD \/path" string: 2/);
    expect(report([probe()], { id_bearing: "GET /orders/:id" } as never).ok).toBe(false);
  });

  it("treats a non-object probe as weak instead of crashing", () => {
    const r = report([null, "GET /orders/:id", probe()]);
    expect(r.probed).toBe(1);
    expect(r.weak).toHaveLength(2);
  });

  it("names a probed endpoint missing from the surface — the denominator is short, so not ok", () => {
    const all = surface.id_bearing.map((endpoint) => probe({ endpoint }));
    const r = report([...all, probe({ endpoint: "DELETE /orders/:id" })]);
    expect(r.offSurface).toEqual(["DELETE /orders/:id"]);
    expect(r.ok).toBe(false);
  });

  it("an empty surface is unproven, not clean, and says to map it first", () => {
    const r = report([], { id_bearing: [] });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/map them from recon/i);
  });

  it("ok only when every id-bearing endpoint has a real probe and nothing is weak", () => {
    const all = surface.id_bearing.map((endpoint) => probe({ endpoint }));
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
      { host: "staging.box", addresses: ["10.1.2.3"], authorizedPrivate: true },
      { host: "db.box", addresses: ["192.168.1.9"] },
      { host: "api.example.com", addresses: ["93.184.216.34"] },
    ]);
    expect(refusals.map((r: { host: string }) => r.host)).toEqual(["db.box", "api.example.com"]);
    expect(refusals.find((r: { host: string }) => r.host === "api.example.com").reason).toMatch(/public/i);
    expect(refusals.find((r: { host: string }) => r.host === "db.box").reason).toMatch(/private/i);
  });

  it("refuses a host that resolves to a mix of loopback and public (DNS-rebind shape)", () => {
    expect(hostFloor([{ host: "evil.test", addresses: ["127.0.0.1", "93.184.216.34"] }]).map((r: { host: string }) => r.host)).toEqual(["evil.test"]);
  });

  it("refuses a host that resolves to nothing", () => {
    expect(hostFloor([{ host: "void.test", addresses: [] }]).map((r: { host: string }) => r.host)).toEqual(["void.test"]);
  });
});

describe("nemesis gateVerdict — the CLI hard-refuses public, flags private for the yml check", () => {
  it("hard-refuses public and no-address, passes loopback clean, flags a private-only host", () => {
    const v = gateVerdict([
      { host: "localhost", addresses: ["127.0.0.1"] },
      { host: "staging.box", addresses: ["10.1.2.3"] },
      { host: "api.example.com", addresses: ["93.184.216.34"] },
      { host: "void.test", addresses: [] },
    ]);
    expect(v.hard.map((r: { host: string }) => r.host)).toEqual(["api.example.com", "void.test"]);
    expect(v.advisory.map((t: { host: string }) => t.host)).toEqual(["staging.box"]);
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
      "http://evil.example.com/x\u2028@127.0.0.1",
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
  it("gate passes a loopback URL and host:port, refuses an address that resolves nowhere", () => {
    expect(cli("gate", "http://localhost:4000", "127.0.0.1:3000").status).toBe(0);
    const r = cli("gate", "http://nothing.invalid:4000");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/resolves to no address/);
  });

  it("gate refuses an ambiguous target instead of resolving a part of it", () => {
    const r = cli("gate", "http://evil.example.invalid\\@127.0.0.1/");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/REFUSED/);
  });

  it("still runs — and refuses — from a folder with a space and through a symlink", () => {
    const d = mkdtempSync(join(tmpdir(), "nemesis cli "));
    mkdirSync(join(d, "plug dir"));
    const copy = join(d, "plug dir", "nemesis-cli.mjs");
    copyFileSync(CLI, copy);
    const link = join(d, "link.mjs");
    symlinkSync(copy, link);
    for (const script of [copy, link]) {
      const r = run(script, "gate", "8.8.8.8");
      expect(r.status, script).toBe(1);
      expect(r.stdout, script).toMatch(/host floor REFUSED/);
    }
  });

  it("coverage exits 1 when incomplete and 0 when every id-bearing endpoint has a real probe", () => {
    const d = mkdtempSync(join(tmpdir(), "nemesis-cli-"));
    const p = (o: unknown, f: string) => (writeFileSync(join(d, f), JSON.stringify(o)), join(d, f));
    const surf = p({ id_bearing: ["GET /orders/:id"] }, "s.json");
    expect(cli("coverage", p({ probes: [] }, "c0.json"), surf).status).toBe(1);
    expect(cli("coverage", p({ probes: [probe()] }, "c1.json"), surf).status).toBe(0);
  });

  it("a long report reaches a pipe whole, verdict line included", () => {
    const d = mkdtempSync(join(tmpdir(), "nemesis-big-"));
    const ids = Array.from({ length: 20000 }, (_, i) => `GET /things/${i}/:id`);
    writeFileSync(join(d, "s.json"), JSON.stringify({ id_bearing: ids }));
    writeFileSync(join(d, "c.json"), JSON.stringify({ probes: [] }));
    const r = spawnSync("sh", ["-c", `"${process.execPath}" "${CLI}" coverage "${join(d, "c.json")}" "${join(d, "s.json")}" | tail -n 1`], { encoding: "utf8" });
    expect(r.stdout).toMatch(/^NOT COMPLETE/);
  });

  it("a missing argument or an unreadable file is an input error (2), never a pass", () => {
    expect(cli("coverage").status).toBe(2);
    expect(cli("gate").status).toBe(2);
    const d = mkdtempSync(join(tmpdir(), "nemesis-null-"));
    writeFileSync(join(d, "n.json"), "null");
    expect(cli("coverage", join(d, "n.json"), join(d, "n.json")).status).toBe(2);
    const r = cli("coverage", "/nonexistent/c.json", "/nonexistent/s.json");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/cannot read/);
  });
});
