import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const injection=vi.hoisted(()=>({client:null as unknown,options:null as unknown,finish:()=>{},sql:"create table public.synthetic_applied(id integer);"}));
vi.mock("pg",async(importOriginal)=>{
  const original=await importOriginal<typeof import("pg")>();
  return {...original,default:{...original.default,Client:class {
    constructor(options:unknown){injection.options=options;}
    async connect(){}
    query(...args:unknown[]){return (injection.client as Client).query(...args as [string]);}
    async end(){injection.finish();}
  }}};
});
vi.mock("node:fs",async(importOriginal)=>{
  const original=await importOriginal<typeof import("node:fs")>();
  return {...original,readdirSync:()=>["20990101000000_synthetic.sql"],readFileSync:()=>injection.sql};
});

const socket=process.env.CORTEX_NATIVE_PG_SOCKET??"";
const config={host:socket,port:Number(process.env.CORTEX_NATIVE_PG_PORT??5432),user:"cortex_test",database:"postgres"};
const database=`cortex_test_migration_readonly_${process.pid}_${Date.now()}`;
let db:Client,created=false;
async function supportedUpgrade(){
  await db.query(`create table if not exists notes(path text,content text,commit_sha text);
    create table if not exists sync_state(id boolean,head_sha text);
    create table if not exists ops_units(id text,kind text);
    create table if not exists ops_runs(unit_id text,run_key text);
    create table if not exists ops_events(actor text,kind text);
    drop table if exists schema_migrations;
    create table schema_migrations(name text primary key,applied_at timestamptz not null default now(),checksum text);
    insert into schema_migrations(name,checksum) values
      ('20260902120000_ops_ledger.sql',repeat('a',64)),('20260902140000_agent_units.sql',repeat('b',64));`);
  return (await db.query("select name,checksum from schema_migrations order by name")).rows;
}
async function run(url="postgresql://synthetic:synthetic@db.synthetic.invalid/postgres",args:string[]=[]){
  vi.resetModules();
  let completed!:()=>void;const done=new Promise<void>(resolve=>{completed=resolve;});
  injection.client=db;injection.finish=completed;injection.options=null;
  vi.stubEnv("SUPABASE_DB_URL",url);
  vi.spyOn(console,"log").mockImplementation(()=>{});
  vi.spyOn(console,"error").mockImplementation(()=>{});
  const loaded=await import("../scripts/migrate");
  const oldArgs=process.argv;process.argv=[oldArgs[0],oldArgs[1],...args];
  try{if("main" in loaded)await (loaded.main as ()=>Promise<void>)();else await done;}
  finally{process.argv=oldArgs;}
}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();injection.sql="create table public.synthetic_applied(id integer);";});
// VISIBLE, not silent. A gated suite that skips itself shrinks the count and says nothing, so a
// run with no database looked identical to a run that had checked everything — for a month.
if (process.env.CORTEX_NATIVE_PG !== "1") {
  describe.skip("native default migration check — SKIPPED: set CORTEX_NATIVE_PG=1 and CORTEX_NATIVE_PG_SOCKET to a Unix socket directory", () => {
    it("did not run", () => {});
  });
}
describe.runIf(process.env.CORTEX_NATIVE_PG==="1")("native default migration check",()=>{
  beforeAll(async()=>{
    if(!socket.startsWith("/"))throw new Error("explicit native socket required");
    const admin=new Client(config);await admin.connect();await admin.query(`create database ${database}`);created=true;await admin.end();
    db=new Client({...config,database});await db.connect();
  });
  afterAll(async()=>{if(!created)return;await db?.end();const admin=new Client(config);await admin.connect();await admin.query(`drop database ${database}`);await admin.end();});
  it("does not bootstrap an absent ledger or apply pending SQL",async()=>{
    await run();
    expect((await db.query("select tablename from pg_tables where schemaname='public'")).rows).toEqual([]);
  });
  it("does not alter an old ledger or its rows during check",async()=>{
    await db.query("drop table if exists schema_migrations; create table schema_migrations(name text primary key,applied_at timestamptz default now()); insert into schema_migrations(name) values('20000101000000_legacy.sql')");
    const before=(await db.query("select * from schema_migrations")).rows;
    await run();
    expect((await db.query("select column_name from information_schema.columns where table_schema='public' and table_name='schema_migrations' order by ordinal_position")).rows.map(r=>r.column_name)).toEqual(["name","applied_at"]);
    expect((await db.query("select relrowsecurity from pg_class where oid='schema_migrations'::regclass")).rows[0].relrowsecurity).toBe(false);
    expect((await db.query("select * from schema_migrations")).rows).toEqual(before);
  });
  it("requires certificate verification on the production transport",async()=>{
    await run();expect(injection.options).toMatchObject({ssl:{rejectUnauthorized:true}});
  });
  it.each(["sslmode=disable","sslmode=no-verify","sslmode=require&uselibpqcompat=true","sslrootcert=/tmp/other-ca","host=localhost"])("refuses overriding URI options: %s",async(query)=>{
    await expect(run(`postgresql://synthetic:synthetic@db.synthetic.invalid/postgres?${query}`)).rejects.toThrow("Unsupported database connection options");
  });
  it("rolls back a failing file and never records it as applied",async()=>{
    await supportedUpgrade();
    const before=(await db.query("select * from schema_migrations order by name")).rows;
    injection.sql="create table public.synthetic_applied(id integer); select missing_synthetic_prerequisite();";
    await expect(run(undefined,["--apply"])).rejects.toThrow(/missing_synthetic_prerequisite/);
    expect((await db.query("select to_regclass('public.synthetic_applied') value")).rows[0].value).toBeNull();
    expect((await db.query("select * from schema_migrations order by name")).rows).toEqual(before);
  });
  it("independently recomputes workflow digest and refuses absent or changed ledger before writes",async()=>{
    const url="postgresql://postgres:synthetic@db.abcdefghijklmnopqrst.supabase.co/postgres";
    vi.stubEnv("CORTEX_WORKFLOW_OPERATION","migrations.apply");vi.stubEnv("CORTEX_MIGRATION_TARGET","supabase:abcdefghijklmnopqrst:postgres");vi.stubEnv("CORTEX_PENDING_DIGEST","a".repeat(64));
    await expect(run(url,["--apply"])).rejects.toThrow(/confirmation conflict/);
    expect((await db.query("select to_regclass('public.synthetic_applied') value")).rows[0].value).toBeNull();
    await db.query("drop table schema_migrations");
    await expect(run(url,["--apply"])).rejects.toThrow(/Administrator integration required/);
    expect((await db.query("select to_regclass('public.schema_migrations') value")).rows[0].value).toBeNull();
  });
  it("applies the exact confirmed file transactionally and replays without another schema mutation",async()=>{
    const historical=await supportedUpgrade();
    const {migrationPlan}=await import("../scripts/migrate");
    const digest=migrationPlan(new Map([["20990101000000_synthetic.sql",injection.sql]]),{state:"present",rows:historical}).digest;
    const url="postgresql://postgres:synthetic@db.abcdefghijklmnopqrst.supabase.co/postgres";
    vi.stubEnv("CORTEX_WORKFLOW_OPERATION","migrations.apply");vi.stubEnv("CORTEX_MIGRATION_TARGET","supabase:abcdefghijklmnopqrst:postgres");vi.stubEnv("CORTEX_PENDING_DIGEST",digest);
    await run(url,["--apply"]);
    const rows=(await db.query("select * from schema_migrations")).rows;expect(rows).toHaveLength(3);expect(rows.find(r=>r.name==="20990101000000_synthetic.sql").checksum).toMatch(/^[a-f0-9]{64}$/);
    await expect(run(url,["--apply"])).rejects.toThrow(/confirmation conflict/);
    expect((await db.query("select * from schema_migrations")).rows).toEqual(rows);
    expect((await db.query("select to_regclass('public.synthetic_applied') value")).rows[0].value).toBe("synthetic_applied");
  });
  it("refuses oversized ledger fields inside SQL before returning row payloads to the migration reader",async()=>{
    await db.query("insert into schema_migrations(name,checksum) values('20990201000000_oversized.sql',repeat('x',600000))");
    const query=vi.spyOn(db,"query");
    try{
      await expect(run()).rejects.toThrow(/ledger/);
      expect(query.mock.calls.some(([sql])=>typeof sql==="string"&&sql.startsWith("select name,"))).toBe(false);
    }finally{query.mockRestore();await db.query("delete from schema_migrations where name='20990201000000_oversized.sql'");}
  });
});
