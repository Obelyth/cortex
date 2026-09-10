import { readFile, readdir } from "node:fs/promises";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rebuildEdges, STRUCTURAL_EDGE_VERSION } from "../lib/edges";
import { cooccurrence, sessionize, learningHistory, LEARNING_POLICY } from "../lib/prediction";

const socket=process.env.CORTEX_NATIVE_PG_SOCKET??"";
const config={host:socket,port:5432,user:"cortex_test",database:"postgres",options:"-c statement_timeout=5000"};
const database=`cortex_test_learning_${process.pid}_${Date.now()}`;
let db:Client,other:Client,created=false;
const files=new Map([["a.md","See [[b]]."],["b.md","Target"]]);
const stamp=async(client=db)=>(await client.query("select edges_freshness('head1') value")).rows[0].value;
const build=async(s:any,client=db,head="head1",edges:unknown[]|null=[]) => (await client.query("select edges_rebuild_v3($1,$2,$3,$4,$5,false) value",[head,s.watermark,s.cutoff,STRUCTURAL_EDGE_VERSION,edges===null?null:JSON.stringify(edges)])).rows[0].value;

// VISIBLE, not silent. A gated suite that skips itself shrinks the count and says nothing, so a
// run with no database looked identical to a run that had checked everything — for a month.
if (process.env.CORTEX_NATIVE_PG !== "1") {
  describe.skip("native learning freshness and policy — SKIPPED: set CORTEX_NATIVE_PG=1 and CORTEX_NATIVE_PG_SOCKET to a Unix socket directory", () => {
    it("did not run", () => {});
  });
}
describe.runIf(process.env.CORTEX_NATIVE_PG==="1")("native learning freshness and policy",()=>{
  beforeAll(async()=>{
    if(!socket.startsWith("/"))throw new Error("explicit native socket required");
    const admin=new Client(config);await admin.connect();await admin.query(`create database ${database}`);created=true;await admin.end();
    db=new Client({...config,database});other=new Client({...config,database});await db.connect();await other.connect();
    await db.query(`create table notes(path text primary key); create table sync_state(id boolean primary key,head_sha text);insert into sync_state values(true,'head1');
      create table note_access(id bigint generated always as identity primary key,at timestamptz not null default now(),path text not null,mode text not null);`);
    const roles=(await db.query("select rolname,rolbypassrls from pg_roles where rolname in ('anon','authenticated','service_role')")).rows;
    if(roles.length!==3||!roles.find(r=>r.rolname==='service_role')?.rolbypassrls)throw new Error("existing service roles with BYPASSRLS required");
    for(const file of ["20260812000000_note_edges.sql","20260812040000_coaccess_fanout_cap.sql",...(await readdir("supabase/migrations")).filter(f=>f.endsWith("_learning_freshness.sql")||f.endsWith("_structural_edge_identity.sql")).sort()])await db.query(await readFile(`supabase/migrations/${file}`,"utf8"));
  });
  afterAll(async()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();if(!created)return;await db?.end();await other?.end();const admin=new Client(config);await admin.connect();await admin.query(`drop database ${database}`);await admin.end();});
  beforeEach(async()=>{
    await db.query("truncate note_access;delete from note_edges;delete from edges_state;delete from notes;insert into notes values('a.md'),('b.md');update sync_state set head_sha='head1'");
    vi.stubEnv("SUPABASE_URL","https://synthetic.invalid");vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic");
    vi.stubGlobal("fetch",async(url:string,init?:RequestInit)=>{
      const a=JSON.parse(String(init?.body??"{}"));let value;
      if(url.includes("edges_state?"))value=(await db.query("select built_head from edges_state")).rows;
      else if(url.endsWith("edges_freshness"))value=(await db.query("select edges_freshness($1) value",[a.new_head])).rows[0].value;
      else if(url.endsWith("edges_rebuild_v3"))value=(await db.query("select edges_rebuild_v3($1,$2,$3,$4,$5,$6) value",[a.new_head,a.expected_watermark,a.expected_cutoff,a.expected_structure,a.edges===null?null:JSON.stringify(a.edges),a.force])).rows[0].value;
      else value=(await db.query("select edges_rebuild($1,$2) value",[a.new_head,JSON.stringify(a.edges)])).rows[0].value;
      return Response.json(value);
    });
  });
  it("refreshes a same-SHA graph after eligible usage and leaves an unchanged graph untouched",async()=>{
    expect((await rebuildEdges(files,"head1")).state).toBe("rebuilt");
    await db.query("insert into note_access(at,path,mode) select date_trunc('hour',now())-h*interval '1 hour',p,'read' from generate_series(1,2) h cross join (values('a.md'),('b.md')) v(p)");
    expect((await rebuildEdges(files,"head1")).state).toBe("rebuilt");
    expect((await db.query("select weight from note_edges where kind='coaccess'")).rows).toEqual([{weight:2}]);
    expect((await db.query("select src,dst from note_edges where kind='link'")).rows).toEqual([{src:"a.md",dst:"b.md"}]);
    const before=(await db.query("select built_at from edges_state")).rows;
    expect((await rebuildEdges(files,"head1")).state).toBe("current");
    expect((await db.query("select built_at from edges_state")).rows).toEqual(before);
  });
  it("treats a same-head legacy structural algorithm as stale before and after usage-only refresh",async()=>{
    const s=await stamp();
    await db.query("insert into edges_state(id,built_head,built_at,built_watermark,built_cutoff,built_policy) values(true,'head1',now(),$1,$2,$3)",[s.watermark,s.cutoff,s.policy]);
    const legacy=await stamp();expect(legacy.state).toBe("stale");expect(legacy.structural).toBe(true);
    expect((await db.query("select edges_rebuild_v2($1,$2,$3,null,false) value",["head1",legacy.watermark,legacy.cutoff])).rows[0].value).toBe("stale-input");
    expect(await build(legacy,db,"head1",null)).toBe("stale-input");
    expect(await build(legacy)).toBe("rebuilt");
    expect(await stamp()).toMatchObject({state:"current",structural:false,structure:STRUCTURAL_EDGE_VERSION,builtStructure:STRUCTURAL_EDGE_VERSION});
    expect((await db.query("select edges_rebuild_v3($1,$2,$3,'old',null,false) value",["head1",legacy.watermark,legacy.cutoff])).rows[0].value).toBe("stale-input");
  });
  it("ignores open-hour and excluded traffic, but detects closed-hour corrections and cutoff advancement",async()=>{
    await build(await stamp());const before=await stamp();
    await db.query("insert into note_access(path,mode) values('a.md','read');insert into note_access(at,path,mode) values(now()-interval '2 hours','a.md','maintenance')");
    expect(await stamp()).toEqual(before);
    await db.query("update note_access set at=now()-interval '3 hours' where mode='read'");
    expect((await stamp()).watermark).not.toBe(before.watermark);
    await build(await stamp());await db.query("update edges_state set built_cutoff=built_cutoff-interval '1 hour'");
    expect((await stamp()).state).toBe("stale");
  });
  it("refuses older identities and rolls back graph and stamp together on a malformed edge",async()=>{
    const old=await stamp();
    await db.query("insert into note_access(at,path,mode) values(now()-interval '2 hours','a.md','read')");
    const current=await stamp();expect(await build(current)).toBe("rebuilt");
    expect(await build(old)).toBe("stale-input");
    await db.query("insert into note_access(at,path,mode) values(now()-interval '3 hours','b.md','read')");
    const before=(await db.query("select to_jsonb(s) value from edges_state s")).rows;
    await expect(build(await stamp(),db,"head1",[{src:"a.md",dst:"b.md",kind:"link",weight:1,evidence:""}])).rejects.toThrow();
    expect((await db.query("select to_jsonb(s) value from edges_state s")).rows).toEqual(before);
    await db.query("update sync_state set head_sha='head2'");expect(await build(current)).toBe("stale-head");
  });
  it("serializes contenders so only one identical identity publishes",async()=>{
    const s=await stamp(),outcomes=await Promise.all([build(s,db),build(s,other)]);
    expect(outcomes.filter(s=>s==="rebuilt")).toHaveLength(1);
    expect(outcomes.every(s=>["rebuilt","current","busy"].includes(s))).toBe(true);
    expect(await build(s)).toBe("current");
  });
  it("production and replay share UTC, exclusions, horizon, fanout, distinct-path and evidence semantics",async()=>{
    await db.query("set timezone='America/Los_Angeles'");
    const cutoff=Date.parse((await stamp()).cutoff),rows:{at:string;path:string;mode:string}[]=[];
    const add=(h:number,paths:string[],mode="read")=>paths.forEach(path=>rows.push({at:new Date(cutoff-h*3600000).toISOString(),path,mode}));
    add(1,["a.md","a.md","b.md"]);add(2,["a.md","b.md"]);add(3,["a.md","b.md"],"maintenance");
    add(4,["a.md","b.md"],"boot");add(5,["a.md","b.md"],"handoff");add(0,["a.md","b.md"]);add(2161,["a.md","b.md"]);
    for(const h of [6,7])add(h,["a.md","b.md","c","d","e","f","g"]);
    for(const h of [8,9])add(h,["a.md","deleted.md"]);
    for(const r of rows)await db.query("insert into note_access(at,path,mode)values($1,$2,$3)",[r.at,r.path,r.mode]);
    const s=await stamp();expect(s.policy).toBe(LEARNING_POLICY);await build(s);
    expect((await db.query("select src,dst,weight from note_edges where kind='coaccess'")).rows).toEqual([{src:"a.md",dst:"b.md",weight:2}]);
    const available=new Set<string>((await db.query("select path from notes")).rows.map(r=>r.path));
    expect([...cooccurrence(sessionize(learningHistory(rows,cutoff)),available)]).toEqual([["a.md\u0000b.md",2]]);
    await db.query("set timezone='UTC'");
  });
  it("keeps an in-flight graph atomic while the next historical write waits, then invalidates",async()=>{
    const s=await stamp();await db.query("begin");
    try {
      expect(await build(s)).toBe("rebuilt");
      expect((await stamp(other)).state).toBe("stale"); // uncommitted graph stamp is invisible
      const pending=other.query("insert into note_access(at,path,mode) values(now()-interval '2 hours','a.md','read')");
      await db.query("commit");await pending;
      expect((await stamp()).state).toBe("stale");
      const changed=await stamp();await build(changed);
      await db.query("delete from note_access where path='a.md'");
      expect((await stamp()).watermark).not.toBe(changed.watermark);
    } finally {await db.query("rollback");}
  });
  it("bounds clock metadata and refuses oversized history without replacing the last graph",async()=>{
    await build(await stamp());const before=(await db.query("select to_jsonb(s) value from edges_state s")).rows;
    // Synthetic bulk fixture avoids timing 100001 trigger calls; real mutation paths are tested above.
    await db.query("alter table note_access disable trigger edges_access_mutation");
    try {await db.query("insert into note_access(at,path,mode) select now()-interval '2 hours','a.md','read' from generate_series(1,100001)");}
    finally {await db.query("alter table note_access enable trigger edges_access_mutation");}
    await db.query("insert into note_access(at,path,mode) values(now()-interval '3 hours','b.md','read')");
    expect(await build(await stamp())).toBe("capacity");
    expect((await db.query("select to_jsonb(s) value from edges_state s")).rows).toEqual(before);
    await db.query("select edges_touch_hour(date_trunc('hour',now())-h*interval '1 hour') from generate_series(0,3000) h");
    expect((await db.query("select count(*)::int n from edges_usage_hours")).rows[0].n).toBe(2161);
  });
  it("exposes invoker RPCs only to the service role, with gateway-hoisted timeout settings",async()=>{
    for(const signature of ["edges_freshness(text)","edges_rebuild_v3(text,text,timestamp with time zone,text,jsonb,boolean)","edges_usage_identity()","edges_touch_hour(timestamp with time zone)"]) {
      expect((await db.query("select has_function_privilege('anon',$1,'execute') anon,has_function_privilege('authenticated',$1,'execute') auth,has_function_privilege('service_role',$1,'execute') service",[signature])).rows[0]).toEqual({anon:false,auth:false,service:true});
    }
    const metadata=(await db.query("select proconfig,prosecdef from pg_proc where proname='edges_rebuild_v3'")).rows[0];
    expect(metadata.prosecdef).toBe(false);expect(metadata.proconfig).toContain("statement_timeout=5s");
    await db.query("set role service_role");
    try {expect(await build(await stamp())).toBe("rebuilt");} finally {await db.query("reset role");}
    await db.query("set role anon");
    try {await expect(db.query("select * from edges_usage_hours")).rejects.toThrow(/permission denied/);} finally {await db.query("reset role");}
  });
});
