import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newConfigurationRequestKey } from "../lib/console-configuration-contract";
import { __setConsoleConfigurationStore, consoleConfigurationStore } from "../lib/console-configuration-store";

const socket = process.env.CORTEX_NATIVE_PG_SOCKET ?? "";
const port = Number(process.env.CORTEX_NATIVE_PG_PORT ?? 5432);
const config = { host: socket, port, user: "cortex_test", database: "postgres" };
const database = `cortex_test_console_configuration_${process.pid}_${Date.now()}`;
let db: Client;
let other: Client;
let created = false;
const migrations = [
  "supabase/migrations/20260908225927_console_configuration.sql",
  "supabase/migrations/20260909001059_console_configuration_exact_reads.sql",
];
const capability = "reader-openai";
const target = "vercel:prj_fixture:personal:production";
const fingerprint = (character = "a") => character.repeat(64);

async function admit(
  client: Client,
  key = newConfigurationRequestKey(),
  fp = fingerprint(),
  expectedRevision = 0,
  selectedCapability = capability,
  selectedTarget = target,
) {
  return (await client.query(
    "select public.console_configuration_admit($1,$2,$3,$4,$5) value",
    [key, fp, selectedCapability, selectedTarget, expectedRevision],
  )).rows[0].value;
}

async function publish(client: Client, admission: Record<string, unknown>, result: object) {
  const record = admission.record as Record<string, unknown>;
  try {
    return (await client.query(
      "select public.console_configuration_publish($1,$2,$3,$4,$5,$6) value",
      [record.capability, record.target, record.request_key, admission.claimToken, result && "state" in result && result.state === "uncertain" ? "uncertain" : "finished", result],
    )).rows[0].value;
  } catch (error) {
    const pg = error as { message?: string; where?: string; detail?: string };
    throw new Error([pg.message, pg.detail, pg.where].filter(Boolean).join(" | "));
  }
}

// VISIBLE, not silent. A gated suite that skips itself shrinks the count and says nothing, so a
// run with no database looked identical to a run that had checked everything — for a month.
if (process.env.CORTEX_NATIVE_PG !== "1") {
  describe.skip("native configuration admission ledger — SKIPPED: set CORTEX_NATIVE_PG=1 and CORTEX_NATIVE_PG_SOCKET to a Unix socket directory", () => {
    it("did not run", () => {});
  });
}
describe.runIf(process.env.CORTEX_NATIVE_PG === "1")("native configuration admission ledger", () => {
  beforeAll(async () => {
    if (!socket.startsWith("/")) throw new Error("explicit native socket required");
    const admin = new Client(config);
    await admin.connect();
    await admin.query(`create database ${database}`);
    created = true;
    await admin.end();
    db = new Client({ ...config, database });
    other = new Client({ ...config, database });
    await db.connect();
    await other.connect();
    await db.query(`
      do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;
    `);
    for (const migration of migrations) await db.query(await readFile(migration, "utf8"));
  });

  afterAll(async () => {
    if (!created) return;
    await db?.end();
    await other?.end();
    const admin = new Client(config);
    await admin.connect();
    await admin.query(`drop database ${database}`);
    await admin.end();
  });

  beforeEach(async () => {
    await db.query("truncate public.console_configuration_state, public.console_configuration_requests cascade");
  });

  it("atomically admits one writer per capability target and fences publication", async () => {
    const [first, second] = await Promise.all([admit(db), admit(other, newConfigurationRequestKey(), fingerprint("b"))]);
    expect([first.outcome, second.outcome].sort()).toEqual(["active", "admitted"]);
    const admitted = first.outcome === "admitted" ? first : second;
    const stale = await publish(db, { ...admitted, claimToken: randomUUID() }, {
      state: "saved-pending-deployment", accepted: ["OPENAI_API_KEY"], failed: [],
    });
    expect(stale.outcome).toBe("stale");
    const done = await publish(db, admitted, {
      state: "saved-pending-deployment", accepted: ["OPENAI_API_KEY"], failed: [],
    });
    expect(done).toMatchObject({ outcome: "published", record: { revision: 1, status: "finished" } });
    expect((await publish(db, admitted, { state: "uncertain", accepted: [], failed: [{ name: "OPENAI_API_KEY", code: "completion_unconfirmed" }] })).outcome).toBe("stale");
  });

  it("replays retained identities before freshness checks and rejects changed input across intervening writes", async () => {
    const oldKey = newConfigurationRequestKey(Date.now() - 10 * 60_000);
    await db.query(
      `insert into public.console_configuration_requests
       (request_key,input_fingerprint,capability,target,starting_revision,state,claim_token,requested_at,updated_at)
       values($1,$2,$3,$4,0,'running',$5,now()-interval '10 minutes',now()-interval '10 minutes')`,
      [oldKey, fingerprint(), capability, target, randomUUID()],
    );
    await db.query(
      "insert into public.console_configuration_state(capability,target,revision,current_request) values($1,$2,0,$3)",
      [capability, target, oldKey],
    );
    expect((await admit(db, oldKey)).outcome).toBe("replay");
    expect((await admit(db, oldKey, fingerprint("b"))).outcome).toBe("key_conflict");
    expect((await admit(db, oldKey, fingerprint(), 1)).outcome).toBe("key_conflict");
  });

  it("preserves matching replay and revision conflicts after an intervening finished write", async () => {
    const firstKey = newConfigurationRequestKey();
    const first = await admit(db, firstKey);
    expect((await publish(db, first, { state: "saved-pending-deployment", accepted: ["OPENAI_API_KEY"], failed: [] })).record.revision).toBe(1);
    const second = await admit(db, newConfigurationRequestKey(), fingerprint("b"), 1);
    expect((await publish(db, second, { state: "saved-pending-deployment", accepted: ["OPENAI_API_KEY"], failed: [] })).record.revision).toBe(2);
    expect((await admit(db, firstKey, fingerprint(), 0)).outcome).toBe("replay");
    expect((await admit(db, firstKey, fingerprint("c"), 0)).outcome).toBe("key_conflict");
    expect((await admit(db, firstKey, fingerprint(), 1)).outcome).toBe("key_conflict");
  });

  it("rejects expired and future UUIDv7 admissions without creating receipts", async () => {
    expect((await admit(db, newConfigurationRequestKey(Date.now() - 5 * 60_000 - 2_000))).outcome).toBe("expired");
    expect((await admit(db, newConfigurationRequestKey(Date.now() + 60_000 + 2_000))).outcome).toBe("expired");
    expect((await db.query("select count(*)::int n from public.console_configuration_requests")).rows[0].n).toBe(0);
  });

  it("keeps unresolved and current receipts while pruning old terminal non-current receipts", async () => {
    const current = await admit(db);
    const oldTerminal = newConfigurationRequestKey(Date.now() - 40 * 86_400_000);
    const oldUnresolved = newConfigurationRequestKey(Date.now() - 40 * 86_400_000 + 1);
    await db.query(
      `insert into public.console_configuration_requests
       (request_key,input_fingerprint,capability,target,starting_revision,completed_revision,state,claim_token,result,requested_at,updated_at)
       values($1,$3,'reader-google','vercel:prj_fixture:personal:preview',0,1,'finished',$4,$5,now()-interval '40 days',now()-interval '40 days'),
             ($2,$3,'reader-anthropic','vercel:prj_fixture:personal:preview',0,null,'uncertain',$4,$6,now()-interval '40 days',now()-interval '40 days')`,
      [oldTerminal, oldUnresolved, fingerprint(), randomUUID(), { state: "saved-pending-deployment", accepted: ["GEMINI_API_KEY"], failed: [] }, { state: "uncertain", accepted: [], failed: [{ name: "ANTHROPIC_API_KEY", code: "completion_unconfirmed" }] }],
    );
    expect((await admit(db, newConfigurationRequestKey(), fingerprint("c"), 0, "cache", "vercel:prj_fixture:personal:preview")).outcome).toBe("admitted");
    const keys = (await db.query("select request_key::text key from public.console_configuration_requests")).rows.map((row) => row.key);
    expect(keys).toContain((current.record as Record<string, string>).request_key);
    expect(keys).toContain(oldUnresolved);
    expect(keys).not.toContain(oldTerminal);
  });

  it("refuses global over-capacity without deleting protected receipts", async () => {
    const now = Date.now();
    const rows = Array.from({ length: 2_000 }, (_, index) => ({
      key: newConfigurationRequestKey(now - index),
      capability: "notes",
      target: `vercel:prj_fixture:personal:${index % 2 ? "production" : "preview"}`,
      fp: fingerprint(index % 10 === 0 ? "b" : "a"),
      token: randomUUID(),
    }));
    await db.query(
      `insert into public.console_configuration_requests
       (request_key,input_fingerprint,capability,target,starting_revision,state,claim_token)
       select (value->>'key')::uuid,value->>'fp',value->>'capability',value->>'target',0,'uncertain',(value->>'token')::uuid
       from jsonb_array_elements($1::jsonb) value`,
      [JSON.stringify(rows)],
    );
    const result = await admit(db, newConfigurationRequestKey(), fingerprint("c"), 0, "cache", "vercel:prj_fixture:personal:production");
    expect(result.outcome).toBe("capacity");
    expect((await db.query("select count(*)::int n from public.console_configuration_requests")).rows[0].n).toBe(2_000);
  });

  it("acknowledges unresolved work explicitly and preserves the publication fence", async () => {
    const admission = await admit(db);
    const row = admission.record as Record<string, string>;
    const acknowledged = (await db.query(
      "select public.console_configuration_acknowledge($1,$2,$3) value",
      [row.capability, row.target, row.request_key],
    )).rows[0].value;
    expect(acknowledged).toMatchObject({ outcome: "acknowledged", record: { revision: 1, status: "uncertain", acknowledged: true } });
    expect((await publish(db, admission, { state: "saved-pending-deployment", accepted: ["OPENAI_API_KEY"], failed: [] })).outcome).toBe("stale");
    expect((await admit(db, newConfigurationRequestKey(), fingerprint("b"))).outcome).toBe("stale");
    expect((await admit(db, newConfigurationRequestKey(), fingerprint("b"), 1)).outcome).toBe("admitted");
  });

  it("fails closed on null publication identity and bounds every RPC inside the gateway deadline", async () => {
    const admission = await admit(db);
    const row = admission.record as Record<string, string>;
    const result = (await db.query(
      "select public.console_configuration_publish($1,$2,$3,null,'finished',$4) value",
      [row.capability, row.target, row.request_key, { state: "saved-pending-deployment", accepted: ["OPENAI_API_KEY"], failed: [] }],
    )).rows[0].value;
    expect(result.outcome).toBe("stale");
    expect((await db.query("select state from public.console_configuration_requests where request_key=$1", [row.request_key])).rows[0].state).toBe("running");
    const configs = (await db.query(
      `select proname, proconfig from pg_proc where proname like 'console_configuration_%'`,
    )).rows;
    expect(configs).toHaveLength(6);
    for (const configRow of configs) expect(configRow.proconfig).toContain("statement_timeout=5s");
  });

  it("deterministically refuses JSON nulls in durable result fields", async () => {
    expect((await db.query(
      "select public.console_configuration_result_valid($1,'finished',$2::jsonb) value",
      [capability, { state: null, accepted: ["OPENAI_API_KEY"], failed: [] }],
    )).rows[0].value).toBe(false);
    expect((await db.query(
      "select public.console_configuration_result_valid($1,'finished',$2::jsonb) value",
      [capability, { state: "saved-pending-deployment", accepted: [null], failed: [] }],
    )).rows[0].value).toBe(false);

    const admission = await admit(db);
    const invalid = await publish(db, admission, { state: null, accepted: ["OPENAI_API_KEY"], failed: [] });
    expect(invalid.outcome).toBe("invalid");
    expect((await db.query("select state from public.console_configuration_requests where request_key=$1", [(admission.record as Record<string, string>).request_key])).rows[0].state).toBe("running");
  });

  it("returns one exact retained request and only the current scoped revision through the real store adapter", async () => {
    const notesTarget = "vercel:prj_fixture:personal:preview";
    const first = await admit(db, newConfigurationRequestKey(), fingerprint("b"), 0, "notes", notesTarget);
    await publish(db, first, { state: "saved-pending-deployment", accepted: ["BRAIN_REPO", "GITHUB_TOKEN"], failed: [] });
    const second = await admit(db, newConfigurationRequestKey(), fingerprint("c"), 1, "notes", notesTarget);
    await publish(db, second, { state: "saved-pending-deployment", accepted: ["BRAIN_REPO", "GITHUB_TOKEN"], failed: [] });
    const other = await admit(db, newConfigurationRequestKey(), fingerprint("d"), 0, "reader-google", "vercel:prj_other:team_fixture:production");
    await publish(db, other, { state: "saved-pending-deployment", accepted: ["GEMINI_API_KEY"], failed: [] });

    vi.stubEnv("SUPABASE_URL", "https://native-store.invalid");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service-role");
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const rpc = url.split("/").at(-1);
      if (rpc !== "console_configuration_get") return Response.json({ code: "PGRST202" }, { status: 404 });
      const body = JSON.parse(String(init?.body)) as { request_key: string | null; capability_name: string | null; target_name: string | null };
      const rows = await db.query(
        "select public.console_configuration_get($1::uuid,$2::text,$3::text) value",
        [body.request_key, body.capability_name, body.target_name],
      );
      return Response.json(rows.rows.map((row) => row.value));
    }));
    __setConsoleConfigurationStore(undefined);
    try {
      const store = consoleConfigurationStore()!;
      const current = await store.list({ capability: "notes", target: notesTarget });
      expect(current).toHaveLength(1);
      expect(current[0]).toMatchObject({ requestKey: (second.record as Record<string, string>).request_key, revision: 2 });
      expect(await store.getRequest((first.record as Record<string, string>).request_key)).toMatchObject({ requestKey: (first.record as Record<string, string>).request_key, revision: 1 });
      expect(await store.getRequest(newConfigurationRequestKey())).toBeNull();
    } finally {
      __setConsoleConfigurationStore(undefined);
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("keeps tables and functions service-only", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.query(`set role ${role}`);
      await expect(db.query("select * from public.console_configuration_requests")).rejects.toThrow(/permission denied/);
      await expect(admit(db)).rejects.toThrow(/permission denied/);
      await db.query("reset role");
    }
    await db.query("set role service_role");
    expect((await admit(db)).outcome).toBe("admitted");
    await db.query("reset role");
  });
});
