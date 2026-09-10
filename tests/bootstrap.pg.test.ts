import {Client} from "pg";
import {describe,it,expect} from "vitest";
import {readMigrationFiles,migrationHash,requireSupportedUpgrade,readMigrationLedger} from "../scripts/migrate";
import {parseReport} from "../lib/ops-report";
import {pristineBootstrapSql,prerequisiteSql} from "../scripts/bootstrap";
const socket=process.env.CORTEX_NATIVE_PG_SOCKET??"";
const config={host:socket,port:5432,user:"cortex_test",database:"postgres",options:"-c statement_timeout=30000"};
async function isolated(run:(db:Client)=>Promise<void>){
  if(!socket.startsWith("/"))throw new Error("explicit native socket required");
  const database=`cortex_test_final_bootstrap_${process.pid}_${Date.now()}`;
  const admin=new Client(config);await admin.connect();await admin.query(`create database ${database}`);
  const db=new Client({...config,database});await db.connect();
  try{await run(db);}finally{await db.query("rollback").catch(()=>{});await db.end();await admin.query(`drop database ${database}`);await admin.end();}
}
describe("pristine bootstrap bundle",()=>{
  it("contains no seed capture or cleanup path and grants service-role data access explicitly",()=>{
    const sql=pristineBootstrapSql(readMigrationFiles());
    expect(sql).not.toContain("cortex_bootstrap_seed_snapshot");
    expect(sql).not.toMatch(/delete from public\.ops_units/i);
    expect(sql).toContain("grant select,insert,update,delete on all tables in schema public to service_role");
    expect(sql).toContain("grant usage,select on all sequences in schema public to service_role");
  });
});
// VISIBLE, not silent. A gated suite that skips itself shrinks the count and says nothing, so a
// run with no database looked identical to a run that had checked everything — for a month.
if (process.env.CORTEX_NATIVE_PG !== "1") {
  describe.skip("complete pristine bootstrap — SKIPPED: set CORTEX_NATIVE_PG=1 and CORTEX_NATIVE_PG_SOCKET to a Unix socket directory", () => {
    it("did not run", () => {});
  });
}
describe.runIf(process.env.CORTEX_NATIVE_PG==="1")("complete pristine bootstrap",()=>{
  it("applies the complete immutable chain to an empty database",async()=>isolated(async db=>{
    await db.query(pristineBootstrapSql(readMigrationFiles()));
    const tables=(await db.query("select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') order by c.relname")).rows.map(row=>row.relname as string);
    const scaffold=new Set(["schema_migrations","sync_state","console_job_mutation_guard","cortex_installation"]);
    for(const table of tables.filter(name=>!scaffold.has(name))){
      const quoted=`"${table.replaceAll('"','""')}"`;
      expect((await db.query(`select count(*)::int n from public.${quoted}`)).rows[0].n,table).toBe(0);
    }
    expect((await db.query("select id,head_sha from sync_state")).rows).toEqual([{id:true,head_sha:""}]);
    expect((await db.query("select singleton,job_id from console_job_mutation_guard")).rows).toEqual([{singleton:true,job_id:null}]);
    expect((await db.query("select mode from cortex_installation")).rows).toEqual([{mode:"pristine"}]);
    expect((await db.query("select count(*)::int n from schema_migrations")).rows[0].n).toBe(readMigrationFiles().size);
    expect((await db.query("select count(*)::int n from pg_event_trigger where evtfoid='public.rls_auto_enable()'::regprocedure")).rows[0].n).toBe(0);
    expect((await db.query("select has_table_privilege('service_role','public.notes','select,insert,update,delete') allowed")).rows[0].allowed).toBe(true);
    expect((await db.query("select has_table_privilege('anon','public.notes','select') allowed")).rows[0].allowed).toBe(false);
    await db.query("set role service_role");
    try{
      await db.query("insert into notes(path,content,commit_sha) values('synthetic.md','draft','abcdef12')");
      expect((await db.query("select content from notes where path='synthetic.md'")).rows).toEqual([{content:"draft"}]);
      await db.query("update notes set content='ready' where path='synthetic.md'");
      expect((await db.query("delete from notes where path='synthetic.md' returning content")).rows).toEqual([{content:"ready"}]);
    }finally{await db.query("reset role");}
    await db.query("set role service_role");
    try{
      await expect(db.query("insert into schema_migrations(name,checksum) values('99999999999999_forged.sql',repeat('a',64))")).rejects.toThrow(/permission denied/);
      await expect(db.query("update cortex_installation set mode='pristine'")).rejects.toThrow(/permission denied/);
    }finally{await db.query("reset role");}
    await requireSupportedUpgrade(db,await readMigrationLedger(db));
    await db.query("insert into ops_units(id,kind,name) values('synthetic','routine','Synthetic')");
    await db.query("select ops_report_atomic($1)",[{unit:"synthetic",verb:"start",run_key:"unicode"}]);
    const report=parseReport({unit:"synthetic",verb:"finish",run_key:"unicode",ok:true,summary:"s".repeat(279)+"😀",error:"e".repeat(3999)+"😀",evidence:["v".repeat(2047)+"😀"]});
    const result=(await db.query("select ops_report_atomic($1) value",[report])).rows[0].value;
    expect(result.ok).toBe(true);expect(result.run.summary).toHaveLength(279);expect(result.run.error).toHaveLength(3999);expect(result.run.evidence[0]).toHaveLength(2047);
  }));
  it("the explicit prerequisite is real, restrictive, idempotent, and refuses replacement",async()=>isolated(async db=>{
    await db.query(prerequisiteSql());await db.query(prerequisiteSql());
    const info=(await db.query("select prosecdef,prosrc from pg_proc where oid='public.rls_auto_enable()'::regprocedure")).rows[0];
    expect(info.prosecdef).toBe(false);expect(info.prosrc).toContain("enable row level security");
    for(const role of ["anon","authenticated","service_role"])expect((await db.query("select has_function_privilege($1,'public.rls_auto_enable()','execute') allowed",[role])).rows[0].allowed).toBe(false);
    // Test-only attachment proves actual behavior; the production bundle never attaches it.
    await db.query("create event trigger cortex_test_rls on ddl_command_end execute function public.rls_auto_enable();create table public.synthetic_rls(id integer);drop event trigger cortex_test_rls");
    expect((await db.query("select relrowsecurity from pg_class where oid='public.synthetic_rls'::regclass")).rows[0].relrowsecurity).toBe(true);
    await db.query("create or replace function public.rls_auto_enable() returns event_trigger language plpgsql as $$begin null;end$$");
    await expect(db.query(prerequisiteSql())).rejects.toThrow(/Incompatible/);
  }));
  it("preserves populated upgrade rows, ledger checksums, and historical actors",async()=>isolated(async db=>{
    await db.query(prerequisiteSql());
    const files=readMigrationFiles();await db.query("create table schema_migrations(name text primary key,checksum text,applied_at timestamptz default now())");
    for(const [name,sql] of files)if(name<"20260909"){await db.query(sql);await db.query("insert into schema_migrations(name,checksum)values($1,$2)",[name,migrationHash(sql)]);}
    await db.query("insert into ops_units(id,kind,name) values('customer','item','Customer item');insert into ops_events(unit_id,actor,kind)values('customer','operator','ack')");
    const before=(await db.query("select to_jsonb(u) value from ops_units u order by id")).rows;
    await requireSupportedUpgrade(db,await readMigrationLedger(db));
    for(const [name,sql] of files)if(name>="20260909"){await db.query(sql);await db.query("insert into schema_migrations(name,checksum)values($1,$2)",[name,migrationHash(sql)]);}
    expect((await db.query("select to_jsonb(u) value from ops_units u order by id")).rows).toEqual(before);
    expect((await db.query("select actor from ops_events")).rows).toEqual([{actor:"operator"}]);
    await db.query("insert into ops_events(unit_id,actor,kind)values('customer','console','ack')");
    expect((await db.query("select count(*)::int n from cortex_installation")).rows[0].n).toBe(0);
    const ledger=await readMigrationLedger(db);expect(ledger.rows.every(row=>row.checksum===migrationHash(files.get(row.name)!))).toBe(true);
  }));
  it.each(["create table customer_data(id integer)","create function public.customer_fn() returns integer language sql as $$select 1$$","create type public.customer_kind as enum('kept')"])("refuses a nonempty namespace without changing it: %s",async sql=>isolated(async db=>{
    await db.query(sql);await expect(db.query(pristineBootstrapSql(readMigrationFiles()))).rejects.toThrow(/empty dedicated/);await db.query("rollback");
    expect((await db.query("select to_regclass('public.notes') value")).rows[0].value).toBeNull();
  }));
  it("rolls the entire bootstrap back if a migration adds user data",async()=>isolated(async db=>{
    const files=readMigrationFiles();files.set("99999999999999_synthetic_change.sql","insert into public.ops_units(id,kind,name) values('unexpected','item','Unexpected');");
    await expect(db.query(pristineBootstrapSql(files))).rejects.toThrow(/user data/);await db.query("rollback");
    expect((await db.query("select to_regclass('public.notes') value")).rows[0].value).toBeNull();
  }));
  it("refuses absent, empty, pre-Ops and inconsistent upgrade ledgers without writes",async()=>isolated(async db=>{
    for(const ledger of [{state:"absent",rows:[]},{state:"legacy",rows:[]},{state:"present",rows:[{name:"20260805220000_mirror.sql",checksum:null}]},{state:"legacy",rows:[{name:"20260902120000_ops_ledger.sql",checksum:null},{name:"20260902140000_agent_units.sql",checksum:null}]}] as const)
      await expect(requireSupportedUpgrade(db,ledger as any)).rejects.toThrow(/Administrator integration required/);
    expect((await db.query("select count(*)::int n from information_schema.tables where table_schema='public'")).rows[0].n).toBe(0);
  }));
});
