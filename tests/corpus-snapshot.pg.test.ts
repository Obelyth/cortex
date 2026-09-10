import {readFile,readdir} from "node:fs/promises";
import {Client} from "pg";
import {afterAll,beforeAll,describe,it,expect} from "vitest";
import {SKIP_PREFIX,SKIP_NAME,isLive} from "../lib/corpus";
const socket=process.env.CORTEX_NATIVE_PG_SOCKET??"";
const config={host:socket,port:5432,user:"cortex_test",database:"postgres",options:"-c statement_timeout=10000"};
const database=`cortex_test_final_snapshot_${process.pid}_${Date.now()}`;
let db:Client,created=false;
// VISIBLE, not silent. A gated suite that skips itself shrinks the count and says nothing, so a
// run with no database looked identical to a run that had checked everything — for a month.
if (process.env.CORTEX_NATIVE_PG !== "1") {
  describe.skip("native live snapshot transport — SKIPPED: set CORTEX_NATIVE_PG=1 and CORTEX_NATIVE_PG_SOCKET to a Unix socket directory", () => {
    it("did not run", () => {});
  });
}
describe.runIf(process.env.CORTEX_NATIVE_PG==="1")("native live snapshot transport",()=>{
  beforeAll(async()=>{
    if(!socket.startsWith("/"))throw new Error("explicit native socket required");
    const admin=new Client(config);await admin.connect();
    const roles=(await admin.query("select rolname,rolbypassrls from pg_roles where rolname in ('anon','authenticated','service_role')")).rows;
    if(roles.length!==3||!roles.find(r=>r.rolname==="service_role")?.rolbypassrls)throw new Error("existing service roles with BYPASSRLS prerequisite required");
    await admin.query(`create database ${database}`);created=true;await admin.end();
    db=new Client({...config,database});await db.connect();
    await db.query("create table notes(path text primary key,content text,commit_sha text);create table sync_state(id boolean primary key,head_sha text);insert into sync_state values(true,'');");
    for(const file of ["20260908095014_corpus_snapshot.sql",...(await readdir("supabase/migrations")).filter(f=>f.endsWith("_live_corpus_snapshot.sql"))])await db.query(await readFile(`supabase/migrations/${file}`,"utf8"));
  });
  afterAll(async()=>{if(!created)return;await db?.end();const admin=new Client(config);await admin.connect();await admin.query(`drop database ${database}`);await admin.end();});
  it("filters the entire authoritative live policy before transport and keeps excluded stored rows",async()=>{
    const paths=["notes/live.md","notes/Upper.MD","tools/atlas-snapshot.json",...SKIP_PREFIX.map(p=>`${p}hidden.md`),...SKIP_NAME.map(n=>`nested/${n}`),"notes/image.png"];
    for(const path of new Set(paths))await db.query("insert into notes values($1,$2,'same-head')",[path,isLive(path)?"synthetic live":"x".repeat(1024*1024)]);
    // Existing entry point must also stop carrying legacy payloads after the forward upgrade.
    const value=(await db.query("select corpus_snapshot() value")).rows[0].value;
    // Membership, not order: the function sorts by the database's collation (en_US on Supabase and
    // in CI, where "live" precedes "Upper"), JavaScript's sort by code unit. Comparing the two
    // orders passed only on a C-collated development cluster.
    expect(value.head).toBe("");expect([...value.rows.map((r:any)=>r.path)].sort()).toEqual(paths.filter(isLive).sort());
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(1000);
    expect((await db.query("select count(*)::int n from notes")).rows[0].n).toBe(new Set(paths).size);
  });
});
