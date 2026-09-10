import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROPOSAL_QUEUE_SCRIPT } from "../lib/proposal-queue";
import { GitTransport } from "./helpers/proposal-transports";

/** Explicit opt-in only. No TCP, no production credentials, no local binary required by CI.
 * CORTEX_QUEUE_TEST_SOCKET=/absolute/isolated/valkey.sock npm test -- tests/proposal-queue.integration.test.ts */
const socket = process.env.CORTEX_QUEUE_TEST_SOCKET;
const keys: string[] = [];
const now = 1_760_000_000_000;
const ttl = 30 * 86_400_000;
const payload = (id: string, ts = now, state?: string) => JSON.stringify({ id, ts, path: "notes/synthetic.md", content: "synthetic proposal", mode: "append", ...(state ? { state } : {}) });

async function command(...args: (string | number)[]): Promise<unknown> {
  if (!socket?.startsWith("/")) throw new Error("explicit absolute test Unix socket required");
  return new Promise((resolve, reject) => {
    const client = createConnection(socket); let input = Buffer.alloc(0);
    const read = (at = 0): [unknown, number] | null => {
      const end = input.indexOf("\r\n", at); if (end < 0) return null;
      const type = String.fromCharCode(input[at]); const value = input.toString("utf8", at + 1, end); let pos = end + 2;
      if (type === "-") throw new Error(value);
      if (type === "+") return [value, pos];
      if (type === ":") return [Number(value), pos];
      if (type === "$") { const n = Number(value); if (n === -1) return [null, pos]; if (input.length < pos + n + 2) return null; return [input.toString("utf8", pos, pos + n), pos + n + 2]; }
      if (type === "*") { const out: unknown[] = []; for (let i = 0; i < Number(value); i++) { const part = read(pos); if (!part) return null; out.push(part[0]); pos = part[1]; } return [out, pos]; }
      throw new Error("unknown RESP type");
    };
    client.setTimeout(3000, () => client.destroy(new Error("isolated Redis timeout")));
    client.on("error", reject);
    client.on("connect", () => client.write(`*${args.length}\r\n` + args.map(a => { const s = String(a); return `$${Buffer.byteLength(s)}\r\n${s}\r\n`; }).join("")));
    client.on("data", chunk => { input = Buffer.concat([input, typeof chunk === "string" ? Buffer.from(chunk) : chunk]); try { const result = read(); if (result) { client.end(); resolve(result[0]); } } catch (e) { client.destroy(); reject(e); } });
  });
}
const freshKey = () => { const key = `cortex-proposal-task-test:${randomUUID()}`; keys.push(key); return key; };
const run = (key: string, action: string, id = "", raw = "", time = now) => command("EVAL", PROPOSAL_QUEUE_SCRIPT, 1, key, action, time, ttl, 50, id, raw);
afterEach(async () => { if (socket) for (const key of keys.splice(0)) await command("DEL", key); vi.doUnmock("../lib/kv"); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

// VISIBLE, not silent. A gated suite that skips itself shrinks the count and says nothing, so a
// run with no database looked identical to a run that had checked everything — for a month.
if (!process.env.CORTEX_QUEUE_TEST_SOCKET) {
  describe.skip("actual proposal Lua on an isolated Unix socket — SKIPPED: set CORTEX_QUEUE_TEST_SOCKET to an absolute Valkey Unix socket path", () => {
    it("did not run", () => {});
  });
}
describe.skipIf(!socket)("actual proposal Lua on an isolated Unix socket", () => {
  it("a verified cancellation releases an accepting slot at full capacity through production composition", async () => {
    const key = freshKey();
    await command("HSET", key, ...Array.from({ length: 50 }, (_, i) => [`a-${i}`, payload(`a-${i}`, now, "accepting")]).flat());
    const git = new GitTransport(); vi.stubGlobal("fetch", git.fetch);
    vi.stubEnv("GITHUB_TOKEN", "synthetic"); vi.stubEnv("BRAIN_REPO", "test/brain"); vi.stubEnv("BRAIN_BRANCH", "feature/proposals");
    vi.resetModules();
    vi.doMock("../lib/kv", () => ({ kvEnv: () => "synthetic", kv: () => ({ createScript: (script: string) => ({ exec: (_keys: string[], args: (string | number)[]) => command("EVAL", script, 1, key, ...args) }) }) }));
    const { propose, cancelProposal, acceptProposal } = await import("../lib/proposals");
    const newProposal = { path: "notes/synthetic.md", content: "new synthetic thought", mode: "append" as const };
    await expect(propose(newProposal, now)).rejects.toThrow(/full/);
    const canceled = await cancelProposal("a-0", now);
    expect(canceled.outcome).toBe("canceled");
    expect(await command("HLEN", key)).toBe(49);
    await propose(newProposal, now);
    expect(await command("HLEN", key)).toBe(50);
    expect((await acceptProposal("a-0", now)).commitSha).toBe(canceled.commitSha);
    expect(git.files()["notes/synthetic.md"]).toBeUndefined();
  });
  it("49 live legacy rows plus two simultaneous admissions yields exactly one admission and 50", async () => {
    const key = freshKey();
    await command("HSET", key, ...Array.from({ length: 49 }, (_, i) => [`legacy-${i}`, payload(`legacy-${i}`)]).flat());
    const results = await Promise.all([run(key, "admit", "a", payload("a")), run(key, "admit", "b", payload("b"))]);
    expect(results.sort()).toEqual([["full"], ["ok"]]);
    expect(await command("HLEN", key)).toBe(50);
    expect(await command("HGET", key, "legacy-0")).toBe(payload("legacy-0"));
  });
  it("prunes at the exact expiry boundary, removes malformed records, and preserves accepting recovery", async () => {
    const key = freshKey();
    await command("HSET", key, "expired", payload("expired", now - ttl), "live", payload("live", now - ttl + 1), "accepting", payload("accepting", now - ttl * 2, "accepting"), "junk", "{bad", "wrong", payload("other"));
    const result = await run(key, "list") as string[];
    expect(result.slice(1).map(v => JSON.parse(v).id).sort()).toEqual(["accepting", "live"]);
    expect(await command("HGET", key, "expired")).toBeNull();
    expect(await command("HLEN", key)).toBe(2);
  });
  it("accepting items consume capacity and cannot be rejected or expire with a lease", async () => {
    const key = freshKey();
    await command("HSET", key, ...Array.from({ length: 50 }, (_, i) => [`a-${i}`, payload(`a-${i}`, now - ttl * 2, "accepting")]).flat());
    expect(await run(key, "admit", "new", payload("new"))).toEqual(["full"]);
    expect(await run(key, "reject", "a-0")).toEqual(["conflict"]);
    expect((await run(key, "claim", "a-0") as string[])[0]).toBe("ok");
    expect(await run(key, "finalize", "a-0", payload("a-0", now - ttl * 2))).toEqual(["ok"]);
    expect(await run(key, "admit", "new", payload("new"))).toEqual(["ok"]);
  });
  it("an id collision never replaces the existing payload", async () => {
    const key = freshKey();
    await run(key, "admit", "a", payload("a"));
    expect(await run(key, "admit", "a", payload("a", now + 10))).toEqual(["collision"]);
    expect(await command("HGET", key, "a")).toBe(payload("a"));
  });
  it("a late finalizer cannot delete a replacement row with the same id", async () => {
    const key = freshKey();
    await command("HSET", key, "a", payload("a", now + 10, "accepting"));
    expect(await run(key, "finalize", "a", payload("a"))).toEqual(["conflict"]);
    expect(await command("HGET", key, "a")).toBe(payload("a", now + 10, "accepting"));
  });
  it("a stale claim cannot start acceptance of a replacement payload", async () => {
    const key = freshKey();
    await command("HSET", key, "a", payload("a", now + 10));
    expect(await run(key, "claim", "a", payload("a"))).toEqual(["conflict"]);
    expect(await command("HGET", key, "a")).toBe(payload("a", now + 10));
  });
  it("linearizes competing claim and reject decisions", async () => {
    for (let i = 0; i < 12; i++) {
      const key = freshKey(); await run(key, "admit", "a", payload("a"));
      const [accept, reject] = await Promise.all([run(key, "claim", "a"), run(key, "reject", "a")]) as string[][];
      if (accept[0] === "ok") { expect(reject).toEqual(["conflict"]); expect(JSON.parse(String(await command("HGET", key, "a"))).state).toBe("accepting"); }
      else { expect(accept).toEqual(["missing"]); expect(reject).toEqual(["ok"]); expect(await command("HGET", key, "a")).toBeNull(); }
    }
  });
  it("refuses at admission the lone-surrogate payload its sweep would otherwise delete", async () => {
    // JSON.stringify emits "\ud83d" for an emoji cut in half; JSON.parse round-trips it; the
    // server's cjson refuses it. Admit used to HSET it undecoded and the next call swept it.
    const key = freshKey();
    const cut = JSON.stringify({ id: "s1", ts: now, path: "notes/synthetic.md", mode: "append", content: "Decision: ship it \ud83d" });
    expect(cut).toContain("\\ud83d");
    expect(await run(key, "admit", "s1", cut)).toEqual(["invalid"]);
    expect(await command("HLEN", key)).toBe(0);
    // The whole emoji is admitted and survives the sweep a later call runs.
    const whole = JSON.stringify({ id: "s2", ts: now, path: "notes/synthetic.md", mode: "append", content: "Decision: ship it 😀" });
    expect(await run(key, "admit", "s2", whole)).toEqual(["ok"]);
    expect(await run(key, "get", "s2")).toEqual(["ok", whole]);
    expect(await command("HLEN", key)).toBe(1);
  });
  it("production composition never hands a guest an id for a proposal the store would not keep", async () => {
    const key = freshKey();
    vi.resetModules();
    vi.doMock("../lib/kv", () => ({ kvEnv: () => "synthetic", kv: () => ({ createScript: (script: string) => ({ exec: (_keys: string[], args: (string | number)[]) => command("EVAL", script, 1, key, ...args) }) }) }));
    const { propose, listProposals } = await import("../lib/proposals");
    await expect(propose({ path: "notes/synthetic.md", content: "Decision: ship it \ud83d", mode: "append" }, now)).rejects.toThrow(/lone surrogate/);
    expect(await command("HLEN", key)).toBe(0);
    const p = await propose({ path: "notes/synthetic.md", content: "Decision: ship it 😀", mode: "append" }, now);
    expect((await listProposals(now, true)).map(x => x.id)).toEqual([p.id]);
  });
  it("runs production admission and strict lookup with the exact script transport", async () => {
    const key = freshKey();
    vi.resetModules();
    vi.doMock("../lib/kv", () => ({ kvEnv: () => "synthetic", kv: () => ({ createScript: (script: string) => ({ exec: (_keys: string[], args: (string | number)[]) => command("EVAL", script, 1, key, ...args) }) }) }));
    const { propose, getProposal } = await import("../lib/proposals");
    const p = await propose({ path: "notes/synthetic.md", content: "A synthetic thought", mode: "append" }, now);
    expect(await getProposal(p.id, now)).toMatchObject({ content: "A synthetic thought" });
    expect(await getProposal(p.id, now + ttl)).toBeNull();
    expect(await command("HLEN", key)).toBe(0);
  });
});
