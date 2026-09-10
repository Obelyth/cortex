import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../lib/access",()=>({logNoteAccess:vi.fn()}));

const enabled = process.env.CORTEX_NATIVE_PG === "1";
const socket = process.env.CORTEX_NATIVE_PG_SOCKET ?? "";
const config = { host: socket, port: 5432, user: "cortex_test", database: "postgres" };
const database = `cortex_test_working_${process.pid}_${Date.now()}`;
let db: Client;
let other: Client;
let created=false;
const key = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";

// VISIBLE, not silent. A gated suite that skips itself shrinks the count and says nothing, so a
// run with no database looked identical to a run that had checked everything — for a month.
if (process.env.CORTEX_NATIVE_PG !== "1") {
  describe.skip("console working state on native PostgreSQL — SKIPPED: set CORTEX_NATIVE_PG=1 and CORTEX_NATIVE_PG_SOCKET to a Unix socket directory", () => {
    it("did not run", () => {});
  });
}
describe.runIf(enabled)("console working state on native PostgreSQL", () => {
  beforeAll(async () => {
    if (!socket.startsWith("/")) throw new Error("explicit local PostgreSQL socket required");
    const admin = new Client(config); await admin.connect();
    await admin.query(`create database ${database}`);created=true; await admin.end();
    db = new Client({ ...config, database }); other = new Client({ ...config, database });
    await db.connect(); await other.connect();
    await db.query(`do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;`);
    for (const name of ["20260806090000_bubble.sql", "20260908103956_bubble_open_scoped.sql", "20260908121912_bubble_console_working_state.sql"]) {
      await db.query(await readFile(`supabase/migrations/${name}`, "utf8"));
    }
  });
  afterAll(async () => {
    if(!created)return;
    await db?.end(); await other?.end();
    const admin = new Client(config); await admin.connect();
    await admin.query(`drop database if exists ${database}`); await admin.end();
  });
  it("assigns and advances revisions on ordinary MCP updates, filing and age-out", async () => {
    const inserted = await db.query(`insert into bubble_items(kind,body) values('focus','Revision fixture') returning to_jsonb(bubble_items) item`);
    const id = inserted.rows[0].item.id;
    expect(inserted.rows[0].item.version).toBe(1);
    const updated = await db.query(`update bubble_items set body='Model correction' where id=$1 returning version`, [id]);
    expect(Number(updated.rows[0].version)).toBe(2);
    const filed = await db.query(`update bubble_items set status='filed',filed_into='notes/synthetic.md' where id=$1 returning version`, [id]);
    expect(Number(filed.rows[0].version)).toBe(3);
    const expired = await db.query(`insert into bubble_items(kind,body,touched_at) values('focus','Old item',now()-interval '15 days') returning id`);
    await db.query(`select bubble_open_scoped(14,200,'',true)`);
    const aged = await db.query(`select status, version from bubble_items where id=$1`, [expired.rows[0].id]);
    expect(aged.rows[0].status).toBe("aged"); expect(Number(aged.rows[0].version)).toBe(2);
  });
  it("concurrent same-key adds create one item, refuse changed input, and replay current filed state", async () => {
    const sql = `select bubble_console_add($1,'handoff','Next: finish review',' Projects/Harbor.md ') value`;
    const [a,b] = await Promise.all([db.query(sql,[key]), other.query(sql,[key])]);
    expect(a.rows[0].value.item.id).toBe(b.rows[0].value.item.id);
    expect(a.rows[0].value.outcome).toBe("saved");
    expect((await db.query(`select count(*)::int n from bubble_items where console_request_key=$1`,[key])).rows[0].n).toBe(1);
    expect((await db.query(`select bubble_console_add($1,'handoff','Different','harbor') value`,[key])).rows[0].value.outcome).toBe("key_conflict");
    await db.query(`update bubble_items set body='Model revised the saved item' where console_request_key=$1`,[key]);
    const editedReplay=(await db.query(sql,[key])).rows[0].value;
    expect(editedReplay.item.body).toBe("Model revised the saved item");expect(editedReplay.item.version).toBe(2);
    await db.query(`update bubble_items set status='filed',filed_into='notes/synthetic.md' where console_request_key=$1`,[key]);
    const replay = (await db.query(sql,[key])).rows[0].value;
    expect(replay.item.status).toBe("filed"); expect(replay.item.version).toBe(3);
    const agedKey="aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    await db.query(sql,[agedKey]);
    await db.query(`update bubble_items set touched_at=now()-interval '15 days' where console_request_key=$1`,[agedKey]);
    const agedReplay=(await db.query(sql,[agedKey])).rows[0].value;
    expect(agedReplay.item.status).toBe("aged");expect(agedReplay.item.version).toBe(3);
  });
  it("CAS edit has one winner and cannot overwrite filed, expired or intervening model state", async () => {
    const id = (await db.query(`insert into bubble_items(kind,body,project) values('handoff','Draft','harbor') returning id`)).rows[0].id;
    const sql = `select bubble_console_edit($1,1,'handoff',$2,'harbor',false) value`;
    const results = await Promise.all([db.query(sql,[id,"First correction"]),other.query(sql,[id,"Second correction"])]);
    expect(results.map(r=>r.rows[0].value.outcome).sort()).toEqual(["conflict","saved"]);
    await db.query(`update bubble_items set body='Model correction' where id=$1`,[id]);
    expect((await db.query(`select bubble_console_edit($1,2,null,'Stale browser',null,false) value`,[id])).rows[0].value.outcome).toBe("conflict");
    await db.query(`update bubble_items set touched_at=now()-interval '15 days' where id=$1`,[id]);
    const version = (await db.query(`select version from bubble_items where id=$1`,[id])).rows[0].version;
    const expired = (await db.query(`select bubble_console_edit($1,$2,null,'Too late',null,false) value`,[id,version])).rows[0].value;
    expect(expired.outcome).toBe("conflict"); expect(expired.item.status).toBe("aged");
    const filedId=(await db.query(`insert into bubble_items(kind,body) values('handoff','Filed fixture') returning id`)).rows[0].id;
    await db.query(`update bubble_items set status='filed',filed_into='notes/synthetic.md' where id=$1`,[filedId]);
    const filed=(await db.query(`select bubble_console_edit($1,1,null,'Stale edit',null,false) value`,[filedId])).rows[0].value;
    expect(filed.outcome).toBe("conflict");expect(filed.item.status).toBe("filed");expect(filed.item.body).toBe("Filed fixture");
  });
  it("pages scoped open items with deterministic touched/id ordering and bounded limits", async () => {
    await db.query(`insert into bubble_items(kind,body,project,touched_at) select 'focus','Page-'||g,'paging',now() from generate_series(1,25) g;
      insert into bubble_items(kind,body,project) values('focus','PRIVATE OTHER','other');`);
    const first = (await db.query(`select bubble_console_list('projects/PAGING.md',null,null,20) value`)).rows[0].value;
    expect(first.items).toHaveLength(20); expect(first.total).toBe(25); expect(first.next).not.toBeNull();
    const next = (await db.query(`select bubble_console_list('paging',$1,$2,20) value`,[first.next.touched_at,first.next.id])).rows[0].value;
    expect(next.items).toHaveLength(5); expect(next.total).toBe(25); expect(next.next).toBeNull();
    expect(new Set([...first.items,...next.items].map(i=>i.id)).size).toBe(25);
    expect(first.items.map((i:{body:string})=>i.body)).not.toContain("PRIVATE OTHER");
    await db.query(`insert into bubble_items(kind,body,project,touched_at) values('focus','Expired page scope','paging',now()-interval '15 days'),('focus','Expired other scope','other',now()-interval '15 days');`);
    const swept=(await db.query(`select bubble_console_list('paging',null,null,20) value`)).rows[0].value;
    expect(swept.swept).toBe(1);
  });
  it("keeps RPCs service-only and drop means aged history", async () => {
    for(const signature of ["bubble_console_add(uuid,text,text,text)","bubble_console_edit(bigint,bigint,text,text,text,boolean)","bubble_console_list(text,timestamp with time zone,bigint,integer)","bubble_console_item(bigint)"]) {
      const acl = await db.query(`select has_function_privilege('anon',$1,'execute') anon,has_function_privilege('authenticated',$1,'execute') auth,has_function_privilege('service_role',$1,'execute') service`,[signature]);
      expect(acl.rows[0]).toEqual({anon:false,auth:false,service:true});
    }
    const id = (await db.query(`insert into bubble_items(kind,body) values('question','Can retire') returning id`)).rows[0].id;
    const dropped = (await db.query(`select bubble_console_edit($1,1,null,null,null,true) value`,[id])).rows[0].value;
    expect(dropped.outcome).toBe("saved"); expect(dropped.item.status).toBe("aged");
    expect((await db.query(`select count(*)::int n from bubble_items where id=$1`,[id])).rows[0].n).toBe(1);
    await db.query("set role service_role");
    try {
      const service = await db.query(`select bubble_console_add('cccccccc-1111-4111-8111-cccccccccccc','handoff','Service write','service') value`);
      expect(service.rows[0].value.item.status).toBe("open");
    } finally {await db.query("reset role");}
  });
  it("saves through the real command/store and includes only eligible project state in bounded preview without access telemetry",async()=>{
    const {changeWorkingState,readWorkingState}=await import("../lib/working-state");
    const {__setBubbleStore}=await import("../lib/bubble");
    const {__setCache}=await import("../lib/corpus");
    const {__setStore}=await import("../lib/mirror");
    const {previewContext,CONTEXT_BUDGET_BYTES}=await import("../lib/brain");
    const {logNoteAccess}=await import("../lib/access");
    __setBubbleStore(undefined);__setStore(null);
    vi.stubEnv("SUPABASE_URL","https://synthetic.invalid");vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic");
    let loseAddResponse=true;
    vi.stubGlobal("fetch",async(url:string,init:RequestInit)=>{
      const rpc=new URL(url).pathname.split("/").at(-1);const args=JSON.parse(String(init.body));
      const contracts:Record<string,{sql:string;args:unknown[]}>= {
        bubble_console_add:{sql:"select bubble_console_add($1,$2,$3,$4) value",args:[args.request_key,args.item_kind,args.item_body,args.project_name]},
        bubble_console_list:{sql:"select bubble_console_list($1,$2,$3,$4) value",args:[args.project_name,args.before_touched,args.before_id,args.page_size]},
        bubble_open_scoped:{sql:"select bubble_open_scoped($1,$2,$3,$4) value",args:[args.max_age_days,args.max_items,args.project_name,args.include_general]},
      };
      const c=contracts[rpc??""];if(!c)throw new Error("unexpected synthetic request");
      const value=(await db.query(c.sql,c.args)).rows[0].value;
      if(rpc==="bubble_console_add"&&loseAddResponse){loseAddResponse=false;throw new Error("synthetic response lost after commit");}
      return Response.json(value);
    });
    try {
      const command={action:"add",requestKey:"dddddddd-1111-4111-8111-dddddddddddd",kind:"handoff",project:" Projects/Flow.md ",body:"NEXT FLOW ACTION: verify the handoff"};
      await expect(changeWorkingState(command)).rejects.toMatchObject({code:"uncertain"});
      const saved=await changeWorkingState(command);
      await changeWorkingState({action:"add",requestKey:"eeeeeeee-1111-4111-8111-eeeeeeeeeeee",kind:"handoff",project:"private-project",body:"PRIVATE PROJECT WORKING SECRET"});
      expect(saved.item).toMatchObject({kind:"handoff",project:"flow",status:"open",version:1});
      expect((await db.query(`select count(*)::int n from bubble_items where console_request_key=$1`,[command.requestKey])).rows[0].n).toBe(1);
      expect((await readWorkingState({project:"flow",before:null})).items.map(i=>i.id)).toEqual([saved.item.id]);
      __setCache({files:new Map([["profile.md","Synthetic operator"],["projects/flow.md","# Flow\n\nSynthetic flow project"]]),sha:"synthetic-head",bytes:0,fetchedAt:Date.now()});
      vi.mocked(logNoteAccess).mockClear();
      const preview=await previewContext("flow");
      expect(preview.text).toContain("NEXT FLOW ACTION: verify the handoff");
      expect(preview.text).not.toContain("PRIVATE PROJECT WORKING SECRET");
      expect(preview.bytes).toBeLessThanOrEqual(CONTEXT_BUDGET_BYTES);
      expect(logNoteAccess).not.toHaveBeenCalled();
      expect((await db.query(`select version::int from bubble_items where id=$1`,[saved.item.id])).rows[0].version).toBe(1);
    }finally{__setBubbleStore(undefined);__setStore(undefined);__setCache(null);vi.unstubAllEnvs();vi.unstubAllGlobals();}
  });
});
