import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const socket = process.env.CORTEX_NATIVE_PG_SOCKET ?? "";
const config = { host: socket, port: 5432, user: "cortex_test", database: "postgres" };
const database = `cortex_test_devices_${process.pid}_${Date.now()}`;
let db: Client, other: Client, created = false;
const expiry = () => new Date(Date.now() + 86400_000).toISOString();
const fingerprint = "a".repeat(64);
const register = (client: Client, id = randomUUID(), label = "Synthetic browser", until = expiry(), current: string | null = null) => client.query(
  "select console_device_register($1,$2,$3,'phone',$4,$5) value", [id, until, label, fingerprint, current]
).then(r => r.rows[0].value);

// VISIBLE, not silent. A gated suite that skips itself shrinks the count and says nothing, so a
// run with no database looked identical to a run that had checked everything — for a month.
if (process.env.CORTEX_NATIVE_PG !== "1") {
  describe.skip("native browser inventory — SKIPPED: set CORTEX_NATIVE_PG=1 and CORTEX_NATIVE_PG_SOCKET to a Unix socket directory", () => {
    it("did not run", () => {});
  });
}
describe.runIf(process.env.CORTEX_NATIVE_PG === "1")("native browser inventory", () => {
  beforeAll(async () => {
    if (!socket.startsWith("/")) throw new Error("explicit native socket required");
    const admin = new Client(config); await admin.connect(); await admin.query(`create database ${database}`); created = true; await admin.end();
    db = new Client({ ...config, database }); other = new Client({ ...config, database }); await db.connect(); await other.connect();
    await db.query(`do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;`);
    await db.query(await readFile("supabase/migrations/20260902120000_ops_ledger.sql", "utf8"));
    await db.query(await readFile("supabase/migrations/20260908130734_console_devices.sql", "utf8"));
  });
  afterAll(async () => {
    if (!created) return;
    await db?.end(); await other?.end();
    const admin = new Client(config); await admin.connect(); await admin.query(`drop database ${database}`); await admin.end();
  });
  beforeEach(async () => { await db.query("truncate console_devices, console_device_requests"); });
  it("starts empty despite reporter data and enrollment cannot create health runs", async () => {
    await db.query("insert into ops_units(id,kind,name,pages) values('workstation-test','machine','Test workstation',false)");
    await db.query("insert into ops_runs(unit_id,run_key,state) values('workstation-test','synthetic-test-report','succeeded')");
    expect((await db.query("select console_device_list() value")).rows[0].value.items).toEqual([]);
    expect((await db.query("select count(*)::int n from ops_units")).rows[0].n).toBeGreaterThan(0);
    await register(db);
    expect((await db.query("select count(*)::int n from ops_runs")).rows[0].n).toBe(1);
    await db.query("delete from ops_units where id='workstation-test'");
  });
  it("concurrent duplicate registration replays one row and current renamed state", async () => {
    const id = randomUUID(), until = expiry();
    const [a, b] = await Promise.all([register(db, id, "First name", until), register(other, id, "First name", until)]);
    expect(a.outcome).toBe("registered"); expect(b.item.id).toBe(a.item.id);
    expect((await db.query("select count(*)::int n from console_devices")).rows[0].n).toBe(1);
    const renamed = (await db.query("select console_device_rename($1,$2,'New name') value", [id, a.item.updated_at])).rows[0].value;
    expect(renamed.outcome).toBe("renamed");
    expect((await register(db, id, "First name", until)).item.label).toBe("New name");
    const altered = await db.query("select console_device_register($1,$2,'Different','phone',$3,null) value", [id, until, "b".repeat(64)]);
    expect(altered.rows[0].value.outcome).toBe("key_conflict");
    expect((await db.query("select console_device_rename($1,$2,'Stale') value", [id, a.item.updated_at])).rows[0].value.outcome).toBe("conflict");
  });
  it("same-cookie registration continues the row while two independent browsers stay separate", async () => {
    const a = await register(db), b = await register(db);
    expect(a.item.id).not.toBe(b.item.id);
    expect((await register(db, randomUUID(), "Ignored name", expiry(), a.item.id)).item.id).toBe(a.item.id);
    expect((await db.query("select count(*)::int n from console_devices")).rows[0].n).toBe(2);
  });
  it("uses the exact microsecond timestamp as a rename comparison token",async()=>{
    const a=await register(db);
    await db.query("update console_devices set updated_at='2026-09-08T12:00:00.123456Z' where id=$1",[a.item.id]);
    const row=(await db.query("select to_jsonb(d) value from console_devices d where id=$1",[a.item.id])).rows[0].value;
    expect(row.updated_at).toContain(".123456");
    const rounded=new Date(row.updated_at).toISOString();
    expect((await db.query("select console_device_rename($1,$2,'Wrong precision') value",[a.item.id,rounded])).rows[0].value.outcome).toBe("conflict");
    expect((await db.query("select console_device_rename($1,$2,'Exact precision') value",[a.item.id,row.updated_at])).rows[0].value.outcome).toBe("renamed");
  });
  it("Forget removes labels and categories while old intents and visits cannot resurrect", async () => {
    const id = randomUUID(), until = expiry(), a = await register(db, id, "Forget this name", until);
    expect((await db.query("select console_device_forget($1,$2) value", [id, a.item.updated_at])).rows[0].value.outcome).toBe("forgotten");
    expect((await register(db, id, "Forget this name", until)).outcome).toBe("forgotten");
    expect((await db.query("select console_device_visit($1) value", [id])).rows[0].value.outcome).toBe("missing");
    expect((await db.query("select count(*)::int n from console_devices")).rows[0].n).toBe(0);
    const metadata = (await db.query("select to_jsonb(r) value from console_device_requests r")).rows[0].value;
    expect(JSON.stringify(metadata)).not.toContain("Forget this name");
    expect(Object.keys(metadata).sort()).toEqual(["expires_at", "input_fingerprint", "request_key", "target_id"]);
    // A fresh explicit intent can recover without deleting the stale browser cookie first.
    const freshId=randomUUID();
    const recovered=await register(db,freshId,"Replacement browser",expiry(),id);
    expect(recovered.outcome).toBe("registered");expect(recovered.item.id).toBe(freshId);
    expect((await register(db,id,"Forget this name",until)).outcome).toBe("forgotten");
    expect((await db.query("select console_device_visit($1) value",[id])).rows[0].value.outcome).toBe("missing");
  });
  it("enforces the live cap under two concurrent admissions", async () => {
    for (let i = 0; i < 49; i++) await register(db);
    const results = await Promise.all([register(db,randomUUID(),"Fresh",expiry(),randomUUID()), register(other,randomUUID(),"Fresh",expiry(),randomUUID())]);
    expect(results.map(r => r.outcome).sort()).toEqual(["capacity", "registered"]);
    expect((await db.query("select count(*)::int n from console_devices")).rows[0].n).toBe(50);
  });
  it("bounds recent receipts, cleans expired metadata on admission, and refuses expired intents", async () => {
    for (let i = 0; i < 199; i++) {
      const a = await register(db);
      await db.query("select console_device_forget($1,$2)", [a.item.id, a.item.updated_at]);
    }
    const results = await Promise.all([register(db), register(other)]);
    expect(results.map(r => r.outcome).sort()).toEqual(["recent_capacity", "registered"]);
    expect((await db.query("select count(*)::int n from console_device_requests")).rows[0].n).toBe(200);
    await db.query("update console_device_requests set expires_at=now()-interval '1 second'");
    expect((await register(db, randomUUID(), "Expired", new Date(Date.now()-1000).toISOString())).outcome).toBe("expired");
    expect((await register(db)).outcome).toBe("registered");
    expect((await db.query("select count(*)::int n from console_device_requests")).rows[0].n).toBe(1);
  });
  it("throttles concurrent visible visits for five minutes without changing rename revision", async () => {
    const a = await register(db);
    expect(a.item.last_seen_at).toBeNull();
    const sql = "select console_device_visit($1) value";
    const visits = await Promise.all([db.query(sql,[a.item.id]),other.query(sql,[a.item.id])]);
    expect(visits.map(r=>r.rows[0].value.outcome).sort()).toEqual(["throttled","visited"]);
    expect((await db.query("select updated_at from console_devices where id=$1",[a.item.id])).rows[0].updated_at.toISOString()).toBe(new Date(a.item.updated_at).toISOString());
    await db.query("update console_devices set last_seen_at=now()-interval '6 minutes' where id=$1",[a.item.id]);
    expect((await db.query(sql,[a.item.id])).rows[0].value.outcome).toBe("visited");
  });
  it("exposes only service-role inventory RPCs with invoker privileges", async () => {
    for (const signature of ["console_device_list()","console_device_register(uuid,timestamp with time zone,text,text,text,uuid)","console_device_rename(uuid,timestamp with time zone,text)","console_device_forget(uuid,timestamp with time zone)","console_device_visit(uuid)"]) {
      const r=await db.query("select has_function_privilege('anon',$1,'execute') anon,has_function_privilege('authenticated',$1,'execute') auth,has_function_privilege('service_role',$1,'execute') service",[signature]);
      expect(r.rows[0]).toEqual({anon:false,auth:false,service:true});
    }
    await db.query("set role service_role");
    try { expect((await register(db)).outcome).toBe("registered"); } finally { await db.query("reset role"); }
    await db.query("set role anon");
    try { await expect(db.query("select * from console_devices")).rejects.toThrow(/permission denied/); } finally { await db.query("reset role"); }
  });
  it("runs actual guarded routes and store against SQL through lost-response retry, two browsers, rename and Forget",async()=>{
    const {POST,GET}=await import("../app/s/[secret]/console/ops/devices/route");
    const {STAMP_COOKIE,stampValue}=await import("../lib/stamp");
    vi.stubEnv("CONNECTOR_PATH_SECRET","synthetic-secret");vi.stubEnv("CONSOLE_PASSCODE","synthetic-passcode");
    vi.stubEnv("SUPABASE_URL","https://synthetic.invalid");vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic-service");
    let loseResponse=true;
    const sent:Record<string,unknown>[]=[];
    vi.stubGlobal("fetch",async(url:string,init:RequestInit)=>{
      const name=url.split("/").at(-1)!,a=JSON.parse(String(init.body));sent.push(a);
      const calls:Record<string,{sql:string;args:unknown[]}>= {
        console_device_list:{sql:"select console_device_list() value",args:[]},
        console_device_register:{sql:"select console_device_register($1,$2,$3,$4,$5,$6) value",args:[a.request_key,a.intent_expires,a.chosen_label,a.chosen_category,a.input_fingerprint,a.current_id]},
        console_device_rename:{sql:"select console_device_rename($1,$2,$3) value",args:[a.device_id,a.expected_updated,a.chosen_label]},
        console_device_forget:{sql:"select console_device_forget($1,$2) value",args:[a.device_id,a.expected_updated]},
        console_device_visit:{sql:"select console_device_visit($1) value",args:[a.device_id]},
      };
      const call=calls[name];if(!call)throw new Error("unexpected synthetic RPC");
      const value=(await db.query(call.sql,call.args)).rows[0].value;
      if(name==="console_device_register"&&loseResponse){loseResponse=false;throw new Error("synthetic response lost after commit");}
      return Response.json(value);
    });
    const ctx={params:Promise.resolve({secret:"synthetic-secret"})};
    const request=(body?:unknown,cookie="")=>new Request("https://console.invalid/s/synthetic-secret/console/ops/devices",{method:body?"POST":"GET",headers:{"content-type":"application/json",origin:"https://console.invalid",cookie:`${STAMP_COOKIE}=${stampValue()};${cookie}`},...(body?{body:JSON.stringify(body)}:{})});
    try {
      const prepared=await (await POST(request({action:"prepare"}),ctx)).json();
      const command={action:"register",intent:prepared.intent,label:"Native phone",category:"phone"};
      const lost=await POST(request(command),ctx);expect(lost.status).toBe(503);expect((await lost.json()).code).toBe("uncertain");
      const registered=await POST(request(command),ctx),a=(await registered.json()).item;
      expect(registered.status).toBe(200);expect(sent[1]).toEqual(sent[0]);
      const cookie=registered.headers.get("set-cookie")!.split(";")[0];
      const roster=await (await GET(request(undefined,cookie),ctx)).json();expect(roster.currentId).toBe(a.id);expect(roster.items).toHaveLength(1);
      const prepB=await (await POST(request({action:"prepare"}),ctx)).json();
      const b=await (await POST(request({...command,intent:prepB.intent,label:"Native computer",category:"computer"}),ctx)).json();expect(b.item.id).not.toBe(a.id);
      const renamed=await (await POST(request({action:"rename",id:a.id,updatedAt:a.updatedAt,label:"Renamed phone"},cookie),ctx)).json();
      expect((await (await POST(request(command,cookie),ctx)).json()).item.label).toBe("Renamed phone");
      expect((await (await POST(request({action:"visit",visible:true},cookie),ctx)).json()).outcome).toBe("visited");
      expect((await (await POST(request({action:"visit",visible:true},cookie),ctx)).json()).outcome).toBe("throttled");
      expect((await POST(request({action:"forget",id:a.id,updatedAt:renamed.item.updatedAt},cookie),ctx)).headers.get("set-cookie")).toContain("Max-Age=0");
      expect((await (await POST(request(command),ctx)).json()).code).toBe("forgotten");
      expect((await (await POST(request({action:"visit",visible:true},cookie),ctx)).json()).outcome).toBe("unregistered");
      expect((await db.query("select count(*)::int n from console_devices")).rows[0].n).toBe(1);
      const fresh=await (await POST(request({action:"prepare"},cookie),ctx)).json();
      const recovery=await POST(request({...command,intent:fresh.intent,label:"Explicit replacement"},cookie),ctx);
      expect(recovery.status).toBe(200);
      const replacement=(await recovery.json()).item;
      expect(replacement.id).not.toBe(a.id);expect(replacement.id).not.toBe(b.item.id);
      const replacementCookie=recovery.headers.get("set-cookie")!.split(";")[0];
      expect((await (await GET(request(undefined,replacementCookie),ctx)).json()).currentId).toBe(replacement.id);
      const oldRetry=await POST(request(command,replacementCookie),ctx);
      expect((await oldRetry.json()).code).toBe("forgotten");expect(oldRetry.headers.get("set-cookie")).toBeNull();
      expect((await db.query("select count(*)::int n from console_devices")).rows[0].n).toBe(2);
    } finally {vi.unstubAllEnvs();vi.unstubAllGlobals();}
  });
});
