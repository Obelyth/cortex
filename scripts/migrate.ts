/** Fixed supported-upgrade entry point. Default check uses a read-only transaction.
 * Pristine installation is the separate explicit administrator SQL bundle, never --apply. */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkServerIdentity } from "node:tls";
import pg from "pg";

export const migrationHash=(text:string)=>createHash("sha256").update(text,"utf8").digest("hex");
export type MigrationLedger={state:"present"|"absent"|"legacy";rows:Array<{name:string;checksum:string|null}>};
class AdministratorIntegrationRequired extends Error {}
const NAME=/^\d{14}_[A-Za-z0-9_-]+\.sql$/;

export function secureMigrationConfig(connectionString:string,ca?:string):pg.ClientConfig {
  let url:URL;try{url=new URL(connectionString);}catch{throw new Error("Invalid database connection");}
  if(!["postgres:","postgresql:"].includes(url.protocol)||!url.hostname||url.hash||url.hostname.length>253||!url.hostname.split(".").every(label=>/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)))throw new Error("Invalid database connection");
  // pg-connection-string can replace an explicit SSL object. Accept only verify-full,
  // remove it before the driver sees the URI, and reject every other option/duplicate.
  const options=[...url.searchParams];
  if(options.length>1||options.some(([key,value])=>key!=="sslmode"||value!=="verify-full"))throw new Error("Unsupported database connection options");
  url.search="";
  if(ca&&(!ca.includes("-----BEGIN CERTIFICATE-----")||Buffer.byteLength(ca)>65536))throw new Error("Invalid database CA");
  return {connectionString:url.toString(),ssl:{rejectUnauthorized:true,servername:url.hostname,checkServerIdentity,...(ca?{ca}:{})},connectionTimeoutMillis:8000,statement_timeout:30000,lock_timeout:5000};
}

/** Narrow proof: hosted Supabase default database, direct or session pooler.
 * Shared pooler host alone is not identity: postgres.<project-ref> binds the project. */
export function migrationTarget(value:string,kind:"api"|"database"):string {
  let url:URL;try{url=new URL(value);}catch{throw new Error("Database target unavailable");}
  let ref:string|undefined;
  if(kind==="api"){
    if(url.protocol!=="https:"||url.username||url.password||url.port||url.search||url.hash||url.pathname!=="/")throw new Error("Database target unavailable");
    ref=/^([a-z]{20})\.supabase\.co$/.exec(url.hostname)?.[1];
  }else{
    secureMigrationConfig(value);
    if(url.pathname!=="/postgres"||(url.port&&url.port!=="5432"))throw new Error("Database target unavailable");
    const user=decodeURIComponent(url.username);
    const direct=/^db\.([a-z]{20})\.supabase\.co$/.exec(url.hostname)?.[1];
    if(direct&&user==="postgres")ref=direct;
    else if(/^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname))ref=/^postgres\.([a-z]{20})$/.exec(user)?.[1];
  }
  if(!ref)throw new Error("Database target unavailable");
  return `supabase:${ref}:postgres`;
}

export function readMigrationFiles(root=process.cwd()):Map<string,string>{
  const dir=join(root,"supabase","migrations"),names=readdirSync(dir).filter(f=>f.endsWith(".sql")).sort();
  if(!names.length||names.length>512||names.some(n=>!NAME.test(n)))throw new Error("Migration files unavailable or over capacity");
  const files=new Map<string,string>();let size=0;
  for(const name of names){const body=readFileSync(join(dir,name),"utf8");size+=Buffer.byteLength(body);if(Buffer.byteLength(body)>1024*1024||size>8*1024*1024)throw new Error("Migration files over capacity");files.set(name,body);}
  return files;
}

export function migrationPlan(files:Map<string,string>,ledger:MigrationLedger,allowOutOfOrder=false){
  if(ledger.rows.length>2000||Buffer.byteLength(JSON.stringify(ledger))>512*1024)throw new Error("Migration ledger over capacity");
  const done=new Map<string,string|null>();
  for(const row of ledger.rows){if(!NAME.test(row.name)||done.has(row.name)||(row.checksum!==null&&!/^[a-f0-9]{64}$/.test(row.checksum)))throw new Error("Migration ledger invalid");done.set(row.name,row.checksum);}
  const pending:Array<{name:string;checksum:string}>=[];
  for(const [name,body] of [...files].sort(([a],[b])=>a<b?-1:1)){
    if(!NAME.test(name)||!body.trim())throw new Error("Empty or invalid migration file");
    const checksum=migrationHash(body),previous=done.get(name);
    if(previous!==undefined&&previous!==null&&previous!==checksum)throw new Error("Applied migration checksum drift");
    if(!done.has(name))pending.push({name,checksum});
  }
  if([...done.values()].includes(migrationHash("")))throw new Error("Ledger contains an empty migration checksum");
  const highest=[...done.keys()].sort().at(-1);
  if(!allowOutOfOrder&&highest&&pending.some(p=>p.name<highest))throw new Error("Out-of-order migration refused");
  return {pending,digest:migrationHash(JSON.stringify({version:1,pending})),legacyChecksums:[...done.values()].some(v=>v===null)};
}

export async function readMigrationLedger(client:Pick<pg.Client,"query">):Promise<MigrationLedger>{
  const present=(await client.query("select to_regclass('public.schema_migrations') is not null present")).rows[0].present;
  if(!present)return {state:"absent",rows:[]};
  const checksum=(await client.query("select exists(select 1 from information_schema.columns where table_schema='public' and table_name='schema_migrations' and column_name='checksum') present")).rows[0].present;
  // Materialize one bounded snapshot: do not fetch arbitrarily large text fields and only
  // reject them after the driver has allocated their payload. CASE gates serialization.
  const result=(await client.query(`with sample as materialized (
    select name,${checksum?"checksum":"null::text as checksum"} from public.schema_migrations order by name limit 2001
  ), checked as (
    select count(*) n,coalesce(bool_or(octet_length(name)>255 or octet_length(checksum)>64),false) invalid from sample
  ), prepared as (
    select case when n>2000 or invalid then null else
      (select coalesce(json_agg(json_build_object('name',name,'checksum',checksum) order by name),'[]'::json) from sample)
    end value from checked
  ) select case when octet_length(value::text)>524288 then null else value end value from prepared`)).rows[0].value;
  if(result===null)throw new Error("Migration ledger over capacity");
  const rows=result as MigrationLedger["rows"];
  return {state:checksum?"present":"legacy",rows};
}

/** This is a compatibility boundary, not a guessed schema bootstrap or ledger repair. */
export async function requireSupportedUpgrade(client:Pick<pg.Client,"query">,ledger:MigrationLedger):Promise<void>{
  const required=["20260902120000_ops_ledger.sql","20260902140000_agent_units.sql"];
  if(ledger.state==="absent"||!ledger.rows.length||required.some(name=>!ledger.rows.some(row=>row.name===name)))
    throw new AdministratorIntegrationRequired("Administrator integration required: absent, empty, or pre-Ops ledger; never rerun pristine bootstrap on existing data");
  const found=(await client.query(`select count(*)::int n from information_schema.columns
    where table_schema='public' and (table_name,column_name) in
      (('notes','path'),('notes','content'),('notes','commit_sha'),('sync_state','id'),('sync_state','head_sha'),
       ('ops_units','id'),('ops_units','kind'),('ops_runs','unit_id'),('ops_runs','run_key'),('ops_events','actor'),('ops_events','kind'))`)).rows[0].n;
  if(found!==11)throw new AdministratorIntegrationRequired("Administrator integration required: ledger and Cortex schema disagree; no automatic repair attempted");
}

export async function main():Promise<void>{
  const args=process.argv.slice(2);
  if(args.some(a=>a!=="--apply"&&a!=="--allow-out-of-order"))throw new Error("Unknown migration argument");
  const apply=args.includes("--apply"),allowOutOfOrder=args.includes("--allow-out-of-order");
  const url=process.env.SUPABASE_DB_URL;if(!url)throw new Error("SUPABASE_DB_URL is not set");
  const client=new pg.Client(secureMigrationConfig(url,process.env.CORTEX_DATABASE_CA));
  const files=readMigrationFiles();
  const workflow=process.env.CORTEX_WORKFLOW_OPERATION;
  if(workflow){
    if((workflow!=="migrations.check"&&workflow!=="migrations.apply")||apply!==(workflow==="migrations.apply")||allowOutOfOrder)throw new Error("Invalid workflow migration operation");
    if(migrationTarget(url,"database")!==process.env.CORTEX_MIGRATION_TARGET)throw new Error("Database target conflict");
  }
  await client.connect();let transaction=false,locked=false;
  try{
    if(apply){await client.query("select pg_advisory_lock(763541,3)");locked=true;}
    else {await client.query("begin read only");transaction=true;}
    const ledger=await readMigrationLedger(client),plan=migrationPlan(files,ledger,allowOutOfOrder);
    if(apply)await requireSupportedUpgrade(client,ledger);
    if(workflow==="migrations.apply"&&(ledger.state!=="present"||plan.legacyChecksums||process.env.CORTEX_PENDING_DIGEST!==plan.digest))throw new Error("Migration confirmation conflict or ledger prerequisite");
    console.log(`${files.size} migration files · ${ledger.rows.length} ledger rows · ${plan.pending.length} pending · ledger ${ledger.state}`);
    if(plan.legacyChecksums)console.log("Historical checksums unavailable; no historical execution verified.");
    for(const p of plan.pending)console.log(`pending: ${p.name}`);
    if(!apply){
      console.log("READ ONLY CHECK · no schema or rows changed");
      if(ledger.state!=="present")console.log("Administrator bootstrap or ledger integration prerequisite; check does not repair it. Never bootstrap over existing data.");
      await client.query("rollback");transaction=false;return;
    }
    await client.query("begin");transaction=true;
    await client.query("alter table public.schema_migrations add column if not exists checksum text");
    await client.query("alter table public.schema_migrations enable row level security");
    await client.query("commit");transaction=false;
    for(const p of plan.pending){
      await client.query("begin");transaction=true;
      await client.query(files.get(p.name)!);
      await client.query("insert into public.schema_migrations(name,checksum) values($1,$2)",[p.name,p.checksum]);
      await client.query("commit");transaction=false;console.log(`applied: ${p.name}`);
    }
  }finally{
    if(transaction)await client.query("rollback").catch(()=>{});
    if(locked)await client.query("select pg_advisory_unlock(763541,3)").catch(()=>{});
    await client.end();
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))void main().catch(error=>{
  console.error(error instanceof AdministratorIntegrationRequired ? error.message : "Migration unavailable or refused; no completion claim. Check target, TLS, ledger and immutable migration prerequisites.");
  process.exitCode=1;
});
