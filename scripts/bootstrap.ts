/** Administrator-only SQL bundle generation. No DSN read, connection, or remote execution.
 * Paste the complete printed transaction into the provider's SQL dashboard after review. */
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
// @ts-expect-error Native Node 22 strips types but requires the literal .ts extension; Next emits no script JS here.
import {migrationPlan,readMigrationFiles} from "./migrate.ts";

const quote=(value:string)=>`'${value.replaceAll("'","''")}'`;
const HELPER_BODY=`
declare command record;
begin
  for command in select * from pg_catalog.pg_event_trigger_ddl_commands() loop
    if command.command_tag in ('CREATE TABLE','CREATE TABLE AS','SELECT INTO')
      and exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
        where c.oid=command.objid and n.nspname='public' and c.relkind in ('r','p')) then
      execute pg_catalog.format('alter table %s enable row level security',command.objid::pg_catalog.regclass);
    end if;
  end loop;
end
`;
const ROLE_CHECK=`do $cortex_roles$
begin
 if (select count(*) from pg_catalog.pg_roles where rolname in ('anon','authenticated','service_role'))<>3
   or not exists(select 1 from pg_catalog.pg_roles where rolname='service_role' and rolbypassrls) then
   raise exception 'Existing anon/authenticated/service_role roles and service_role BYPASSRLS are required; bootstrap does not alter roles';
 end if;
end $cortex_roles$;`;

/** A real, invoker-only event-trigger function. It is deliberately NOT attached: installing
 * a helper must not change the customer's global DDL policy. Cortex tables set RLS explicitly. */
export function prerequisiteSql():string {
  const definition=`create function public.rls_auto_enable() returns event_trigger language plpgsql security invoker set search_path='' as ${quote(HELPER_BODY)}`;
  return `${ROLE_CHECK}
do $cortex_helper$
declare existing pg_catalog.pg_proc;
begin
 select p.* into existing from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='rls_auto_enable' and p.pronargs=0;
 if found then
   if existing.prosrc is distinct from ${quote(HELPER_BODY)} or existing.prorettype<>'pg_catalog.event_trigger'::pg_catalog.regtype
     or existing.prosecdef or existing.prolang<>(select oid from pg_catalog.pg_language where lanname='plpgsql')
     or existing.proconfig is distinct from array['search_path=""']::text[] then
     raise exception 'Incompatible rls_auto_enable prerequisite; no existing definition was overwritten';
   end if;
 else
   execute ${quote(definition)};
 end if;
end $cortex_helper$;
revoke all on function public.rls_auto_enable() from public,anon,authenticated,service_role;`;
}

const EMPTY_CHECK=`do $cortex_empty$
begin
 if exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and not exists(select 1 from pg_catalog.pg_depend d where d.classid='pg_catalog.pg_class'::regclass and d.objid=c.oid and d.deptype='e'))
 or exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and not(p.proname='rls_auto_enable' and p.pronargs=0)
     and not exists(select 1 from pg_catalog.pg_depend d where d.classid='pg_catalog.pg_proc'::regclass and d.objid=p.oid and d.deptype='e'))
 or exists(select 1 from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid=t.typnamespace
   where n.nspname='public' and t.typelem=0
     and not exists(select 1 from pg_catalog.pg_depend d where d.classid='pg_catalog.pg_type'::regclass and d.objid=t.oid and d.deptype='e')) then
   raise exception 'Pristine bootstrap requires an empty dedicated public application namespace; no reset or merge was attempted';
 end if;
end $cortex_empty$;`;

const FINISH=`do $cortex_finish$
declare table_name text; contains_rows boolean;
begin
 for table_name in select c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind in ('r','p')
     and c.relname not in ('schema_migrations','sync_state','console_job_mutation_guard','cortex_installation') loop
   execute pg_catalog.format('select exists(select 1 from public.%I)',table_name) into contains_rows;
   if contains_rows then raise exception 'Pristine bootstrap found unexpected user data; transaction rolled back';end if;
 end loop;
 if (select count(*) from public.sync_state)<>1 or not exists(select 1 from public.sync_state where id and head_sha='')
   or (select count(*) from public.console_job_mutation_guard)<>1
   or not exists(select 1 from public.console_job_mutation_guard where singleton and job_id is null)
   or exists(select 1 from public.cortex_installation) then
   raise exception 'Pristine bootstrap scaffold validation failed; transaction rolled back';
 end if;
 if exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity
     and not exists(select 1 from pg_catalog.pg_depend d where d.classid='pg_catalog.pg_class'::regclass and d.objid=c.oid and d.deptype='e')) then
   raise exception 'Cortex table RLS validation failed';
 end if;
 revoke all on function public.rls_auto_enable() from public,anon,authenticated,service_role;
 insert into public.cortex_installation(id,mode) values(true,'pristine');
end $cortex_finish$;`;

export function pristineBootstrapSql(files:Map<string,string>):string {
  const plan=migrationPlan(files,{state:"absent",rows:[]});
  let sql=`-- ONE EXPLICIT ADMINISTRATOR TRANSACTION. Review the complete bundle before execution.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
select pg_advisory_xact_lock(763541,3);
${ROLE_CHECK}
${EMPTY_CHECK}
${prerequisiteSql()}
create table public.schema_migrations(name text primary key,applied_at timestamptz not null default now(),checksum text not null);
alter table public.schema_migrations enable row level security;
revoke all on public.schema_migrations from public,anon,authenticated;
grant select on public.schema_migrations to service_role;
`;
  for(const {name,checksum} of plan.pending){
    sql+=`\n-- IMMUTABLE FILE ${name} SHA256 ${checksum}\n${files.get(name)!}\n`;
    sql+=`insert into public.schema_migrations(name,checksum) values(${quote(name)},${quote(checksum)});\n`;
  }
  return `${sql}\n${FINISH}\ncommit;\n`;
}

export function main(args=process.argv.slice(2)):void {
  if(args.length!==1||!["--print-pristine","--print-prerequisite"].includes(args[0]))throw new Error("Choose --print-pristine or --print-prerequisite; this tool only prints SQL");
  process.stdout.write(args[0]==="--print-pristine"?pristineBootstrapSql(readMigrationFiles()):`begin;\n${prerequisiteSql()}\ncommit;\n`);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))try{main();}catch{console.error("Bootstrap bundle unavailable; review immutable files and explicit mode. No connection was opened.");process.exitCode=1;}
