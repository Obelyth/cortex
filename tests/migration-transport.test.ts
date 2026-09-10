import {describe,expect,it} from "vitest";
import {Client} from "pg";
import {createRequire} from "node:module";
import {secureMigrationConfig,migrationTarget,migrationPlan,migrationHash} from "../scripts/migrate";
const require=createRequire(import.meta.url);
const {validateWorkflow}=require("../scripts/dashboard-workflow.cjs");
const ref="abcdefghijklmnopqrst",other="zyxwvutsrqponmlkjihg";
describe("fixed migration target and TLS",()=>{
  it("preserves certificate and hostname verification through the installed driver",()=>{
    const config=secureMigrationConfig(`postgresql://postgres:synthetic@db.${ref}.supabase.co:5432/postgres?sslmode=verify-full`);
    const client=new Client(config);const ssl=(client as unknown as {connectionParameters:{ssl:{rejectUnauthorized:boolean;servername:string;checkServerIdentity:unknown}}}).connectionParameters.ssl;
    expect(ssl.rejectUnauthorized).toBe(true);expect(ssl.servername).toBe(`db.${ref}.supabase.co`);expect(typeof ssl.checkServerIdentity).toBe("function");
    expect(config.connectionString).not.toContain("sslmode");
  });
  it("accepts an absent workflow CA represented by an empty secret",()=>{
    expect(secureMigrationConfig(`postgresql://postgres:synthetic@db.${ref}.supabase.co/postgres`,"").ssl).toMatchObject({rejectUnauthorized:true});
  });
  it("refuses encoded Unix-socket hosts before pg can bypass TLS",()=>{
    expect(()=>secureMigrationConfig("postgresql://postgres:synthetic@%2Ftmp/postgres")).toThrow("Invalid database connection");
  });
  it("derives the same value-free project identity from direct and session-pooler DSNs",()=>{
    const target=`supabase:${ref}:postgres`;
    expect(migrationTarget(`https://${ref}.supabase.co`,"api")).toBe(target);
    expect(migrationTarget(`postgresql://postgres:synthetic@db.${ref}.supabase.co:5432/postgres`,"database")).toBe(target);
    expect(migrationTarget(`postgresql://postgres.${ref}:synthetic@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,"database")).toBe(target);
    expect(migrationTarget(`postgresql://postgres.${other}:synthetic@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,"database")).not.toBe(target);
  });
  it.each([`postgresql://postgres:synthetic@aws-0-us-east-1.pooler.supabase.com/postgres`,`postgresql://postgres.${ref}:synthetic@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,`postgresql://postgres:synthetic@db.${ref}.supabase.co/other`,`postgresql://postgres.${other}:synthetic@db.${ref}.supabase.co/postgres`])("rejects ambiguous or mismatched database format",uri=>expect(()=>migrationTarget(uri,"database")).toThrow());
  it("keeps empty-file, checksum drift, and out-of-order refusals",()=>{
    const name="20990101000000_one.sql",files=new Map([[name,"select 1;"]]);
    expect(()=>migrationPlan(new Map([[name," "]]),{state:"present",rows:[]})).toThrow(/Empty/);
    expect(()=>migrationPlan(files,{state:"present",rows:[{name,checksum:migrationHash("select 2;")}]})).toThrow(/drift/);
    expect(()=>migrationPlan(files,{state:"present",rows:[{name:"20990102000000_two.sql",checksum:null}]})).toThrow(/Out-of-order/);
  });
});
describe("fixed workflow execution boundary",()=>{
  const valid={REQUEST_ID:"11111111-1111-4111-8111-111111111111",SOURCE_SHA:"b".repeat(40),GITHUB_SHA:"b".repeat(40),OPERATION:"checks",TARGET_IDENTITY:"github:fixture/app",GITHUB_REPOSITORY:"fixture/app",PENDING_DIGEST:""};
  it("refuses ref drift, arbitrary operations and cross-repository target before execution",()=>{
    expect(validateWorkflow(valid)).toEqual({operation:"checks"});
    for(const change of [{GITHUB_SHA:"c".repeat(40)},{OPERATION:"shell"},{TARGET_IDENTITY:"github:other/app"},{REQUEST_ID:"$(touch /tmp/unwanted)"}])expect(()=>validateWorkflow({...valid,...change})).toThrow();
  });
});
