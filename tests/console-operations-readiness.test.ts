import {describe,expect,it,vi} from "vitest";
import {providerReadiness} from "../lib/console-job-providers";
import {providerCatalogSchema} from "../lib/console-job-contract";
import {getOperationsReadiness,resolveProviderConfiguration} from "../lib/console-operations-readiness";

const databaseRef="abcdefghijklmnopqrst";
const completeEnv={
  CORTEX_APP_REPO:"fixture/app",
  CORTEX_APP_BRANCH:"main",
  CORTEX_ACTIONS_TOKEN:"canary-actions-authority",
  CORTEX_VERCEL_TOKEN:"canary-vercel-authority",
  CORTEX_VERCEL_PROJECT_ID:"prj_fixture",
  CORTEX_VERCEL_TEAM_ID:"team_fixture",
  CORTEX_MIGRATION_TARGET:`supabase:${databaseRef}:postgres`,
  SUPABASE_URL:`https://${databaseRef}.supabase.co`,
  SUPABASE_SERVICE_ROLE_KEY:"canary-database-authority",
};

const requirement=(env:Record<string,string|undefined>,id:"source"|"github"|"vercel"|"database")=>
  getOperationsReadiness(env).requirements.find(entry=>entry.id===id);

describe("operations readiness",()=>{
  it("points a deployment blocked by missing Vercel authority to that requirement",()=>{
    const providers=providerReadiness({
      CORTEX_APP_REPO:"fixture/app",CORTEX_APP_BRANCH:"main",
      CORTEX_ACTIONS_TOKEN:"canary-actions",
    });
    expect(providers.find(provider=>provider.operation==="deploy.production"))
      .toMatchObject({configured:false,setupRequirement:"vercel"});
  });

  it("reports source absence in fixed variable order without accepting content configuration",()=>{
    const readiness=getOperationsReadiness({
      BRAIN_REPO:"fixture/brain",
      GITHUB_TOKEN:"canary-content-token",
    });
    expect(readiness.requirements).toContainEqual({
      id:"source",state:"missing",
      missing:["CORTEX_APP_REPO","CORTEX_APP_BRANCH"],identities:[],
    });
    expect(readiness.requirements).toContainEqual({
      id:"github",state:"missing",missing:["CORTEX_ACTIONS_TOKEN"],identities:[],
    });
    expect(readiness.providers.find(entry=>entry.operation==="checks")).toMatchObject({
      configured:false,
      detail:"Missing configuration: CORTEX_APP_REPO, CORTEX_APP_BRANCH, CORTEX_ACTIONS_TOKEN",
      setupRequirement:"source",
    });
    expect(JSON.stringify(readiness)).not.toContain("canary-content-token");
  });

  it.each([
    {source:{CORTEX_APP_REPO:"fixture/app.git",CORTEX_APP_BRANCH:"main"},field:"CORTEX_APP_REPO",reason:"Use owner/repository without a URL or .git suffix."},
    {source:{CORTEX_APP_REPO:"fixture/app",CORTEX_APP_BRANCH:"feature//unsafe"},field:"CORTEX_APP_BRANCH",reason:"Use a branch name without spaces, .. or //, and without a trailing /, . or .lock."},
  ])("identifies the malformed source field without publishing either identity",({source,field,reason})=>{
    const env={...completeEnv,...source};
    expect(requirement(env,"source")).toEqual({id:"source",state:"invalid",missing:[],identities:[],issues:[{field,reason}]});
    expect(resolveProviderConfiguration("checks",env)).toEqual({
      ok:false,code:"unavailable",
      detail:"Invalid CORTEX_APP_REPO or CORTEX_APP_BRANCH",
      setupRequirement:"source",
    });
  });

  it("treats whitespace authority as missing in each permission group",()=>{
    const readiness=getOperationsReadiness({
      ...completeEnv,
      CORTEX_ACTIONS_TOKEN:" \t ",
      CORTEX_VERCEL_TOKEN:"  ",
      SUPABASE_SERVICE_ROLE_KEY:"\n",
    });
    expect(readiness.requirements).toEqual([
      {id:"source",state:"present-unverified",missing:[],identities:[{label:"Repository",value:"fixture/app"},{label:"Branch",value:"main"}]},
      {id:"github",state:"missing",missing:["CORTEX_ACTIONS_TOKEN"],identities:[]},
      {id:"vercel",state:"missing",missing:["CORTEX_VERCEL_TOKEN"],identities:[]},
      {id:"database",state:"missing",missing:["SUPABASE_SERVICE_ROLE_KEY"],identities:[]},
    ]);
  });

  it("accepts an absent or whitespace Vercel team as a personal-project identity",()=>{
    for(const team of [undefined," \t "]){
      const env={...completeEnv,CORTEX_VERCEL_TEAM_ID:team};
      expect(requirement(env,"vercel")).toEqual({
        id:"vercel",state:"present-unverified",missing:[],
        identities:[{label:"Project",value:"prj_fixture"}],
      });
      expect(resolveProviderConfiguration("deploy.production",env)).toEqual({
        ok:true,
        value:{
          target:"vercel:prj_fixture:production",
          execution:{provider:"vercel",repository:"fixture/app",branch:"main",project:"prj_fixture",team:null,pendingDigest:null},
        },
      });
    }
  });

  it.each(["malformed-team-canary"," team_fixture "])("rejects a supplied malformed Vercel team without exposing project or team input: %j",team=>{
    const env={...completeEnv,CORTEX_VERCEL_TEAM_ID:team};
    expect(requirement(env,"vercel")).toEqual({id:"vercel",state:"invalid",missing:[],identities:[],issues:[{
      field:"CORTEX_VERCEL_TEAM_ID",reason:"Use a team_ ID followed by letters and numbers. Leave unset for a personal project.",
    }]});
    expect(resolveProviderConfiguration("deploy.preview",env)).toEqual({
      ok:false,code:"unavailable",
      detail:"Invalid CORTEX_VERCEL_PROJECT_ID or CORTEX_VERCEL_TEAM_ID",
      setupRequirement:"vercel",
    });
    expect(JSON.stringify(getOperationsReadiness(env))).not.toContain(team);
  });

  it("marks a database-origin mismatch invalid and preserves the existing conflict code",()=>{
    const env={...completeEnv,CORTEX_MIGRATION_TARGET:"supabase:zyxwvutsrqponmlkjihg:postgres"};
    expect(requirement(env,"database")).toEqual({id:"database",state:"invalid",missing:[],identities:[],issues:[{
      field:"CORTEX_MIGRATION_TARGET",reason:"Use supabase:<project-ref>:postgres with the same project-ref as SUPABASE_URL.",
    }]});
    expect(resolveProviderConfiguration("migrations.apply",env)).toEqual({
      ok:false,code:"conflict",
      detail:"Confirmation changed or expired · review a fresh plan before dispatch",
      setupRequirement:"database",
    });
  });

  it("reports every malformed Vercel identity even when missing source blocks deployment first",()=>{
    const env={...completeEnv,CORTEX_APP_REPO:undefined,CORTEX_VERCEL_PROJECT_ID:"token-pasted-as-project",CORTEX_VERCEL_TEAM_ID:"token-pasted-as-team"};
    const readiness=getOperationsReadiness(env);
    expect(readiness.providers.find(provider=>provider.operation==="deploy.preview")).toMatchObject({configured:false,setupRequirement:"source"});
    expect(requirement(env,"vercel")).toEqual({id:"vercel",state:"invalid",missing:[],identities:[],issues:[
      {field:"CORTEX_VERCEL_PROJECT_ID",reason:"Use a prj_ ID followed by letters and numbers."},
      {field:"CORTEX_VERCEL_TEAM_ID",reason:"Use a team_ ID followed by letters and numbers. Leave unset for a personal project."},
    ]});
    expect(JSON.stringify(readiness)).not.toContain("token-pasted");
  });

  it("identifies an unsupported database URL without changing its unavailable result or exposing the URL",()=>{
    const env={...completeEnv,SUPABASE_URL:"https://secret-canary.invalid/?token=private"};
    expect(requirement(env,"database")).toEqual({id:"database",state:"invalid",missing:[],identities:[],issues:[{
      field:"SUPABASE_URL",reason:"Use the supported hosted Supabase project URL: https://<project-ref>.supabase.co.",
    }]});
    expect(resolveProviderConfiguration("migrations.check",env)).toMatchObject({ok:false,code:"unavailable",setupRequirement:"database"});
    expect(JSON.stringify(getOperationsReadiness(env))).not.toContain("secret-canary");
  });

  it.each([
    {field:"CORTEX_APP_REPO",value:"fixture/github_pat_syntheticOpaqueCredential123",reason:"Use owner/repository without a URL or .git suffix."},
    {field:"CORTEX_APP_BRANCH",value:"github_pat_syntheticOpaqueCredential123",reason:"Use a branch name without spaces, .. or //, and without a trailing /, . or .lock."},
    {field:"CORTEX_APP_BRANCH",value:"ghp_syntheticOpaqueCredential123",reason:"Use a branch name without spaces, .. or //, and without a trailing /, . or .lock."},
  ])("rejects credential-shaped $field even when its source syntax is valid",({field,value,reason})=>{
    const env={...completeEnv,[field]:value};
    const readiness=getOperationsReadiness(env);
    expect(requirement(env,"source")).toEqual({id:"source",state:"invalid",missing:[],identities:[],issues:[{field,reason}]});
    expect(resolveProviderConfiguration("checks",env)).toEqual({
      ok:false,code:"unavailable",detail:"Invalid CORTEX_APP_REPO or CORTEX_APP_BRANCH",setupRequirement:"source",
    });
    expect(JSON.stringify(readiness)).not.toContain("syntheticOpaqueCredential123");
    expect(JSON.stringify(readiness)).not.toContain("<redacted");
  });

  it.each([
    {id:"source" as const,patch:{CORTEX_APP_REPO:undefined,CORTEX_APP_BRANCH:"feature//invalid"},missing:["CORTEX_APP_REPO"],fields:["CORTEX_APP_BRANCH"],operation:"checks" as const},
    {id:"source" as const,patch:{CORTEX_APP_REPO:"fixture/app.git",CORTEX_APP_BRANCH:" "},missing:["CORTEX_APP_BRANCH"],fields:["CORTEX_APP_REPO"],operation:"checks" as const},
    {id:"vercel" as const,patch:{CORTEX_VERCEL_TOKEN:undefined,CORTEX_VERCEL_PROJECT_ID:"bad-project",CORTEX_VERCEL_TEAM_ID:"bad-team"},missing:["CORTEX_VERCEL_TOKEN"],fields:["CORTEX_VERCEL_PROJECT_ID","CORTEX_VERCEL_TEAM_ID"],operation:"deploy.preview" as const},
    {id:"vercel" as const,patch:{CORTEX_VERCEL_PROJECT_ID:undefined,CORTEX_VERCEL_TEAM_ID:"bad-team"},missing:["CORTEX_VERCEL_PROJECT_ID"],fields:["CORTEX_VERCEL_TEAM_ID"],operation:"deploy.preview" as const},
    {id:"database" as const,patch:{SUPABASE_SERVICE_ROLE_KEY:undefined,SUPABASE_URL:"https://unsupported.invalid",CORTEX_MIGRATION_TARGET:"bad-target"},missing:["SUPABASE_SERVICE_ROLE_KEY"],fields:["SUPABASE_URL","CORTEX_MIGRATION_TARGET"],operation:"migrations.check" as const},
    {id:"database" as const,patch:{SUPABASE_URL:undefined,CORTEX_MIGRATION_TARGET:"bad-target"},missing:["SUPABASE_URL"],fields:["CORTEX_MIGRATION_TARGET"],operation:"migrations.check" as const},
    {id:"database" as const,patch:{SUPABASE_URL:undefined,CORTEX_MIGRATION_TARGET:"supabase:abcdefghijklmnopqrst:postgres\n"},missing:["SUPABASE_URL"],fields:["CORTEX_MIGRATION_TARGET"],operation:"migrations.check" as const},
    {id:"database" as const,patch:{CORTEX_MIGRATION_TARGET:undefined,SUPABASE_URL:"https://unsupported.invalid"},missing:["CORTEX_MIGRATION_TARGET"],fields:["SUPABASE_URL"],operation:"migrations.check" as const},
    {id:"database" as const,patch:{SUPABASE_SERVICE_ROLE_KEY:undefined,CORTEX_MIGRATION_TARGET:"supabase:zyxwvutsrqponmlkjihg:postgres"},missing:["SUPABASE_SERVICE_ROLE_KEY"],fields:["CORTEX_MIGRATION_TARGET"],operation:"migrations.check" as const},
  ])("retains missing-state gating while reporting each present invalid field in $id",({id,patch,missing,fields,operation})=>{
    const env={...completeEnv,...patch};
    const row=requirement(env,id)!;
    expect(row).toMatchObject({id,state:"missing",missing,identities:[]});
    expect(row.issues?.map(issue=>issue.field)).toEqual(fields);
    expect(row.issues?.every(issue=>issue.reason.length>0)).toBe(true);
    expect(resolveProviderConfiguration(operation,env)).toEqual({
      ok:false,code:"unavailable",detail:`Missing configuration: ${missing.join(", ")}`,setupRequirement:id,
    });
    const serialized=JSON.stringify(getOperationsReadiness(env));
    for(const unsafe of ["feature//invalid","fixture/app.git","bad-project","bad-team","https://unsupported.invalid","bad-target","supabase:zyxwvutsrqponmlkjihg:postgres"]){
      expect(serialized).not.toContain(unsafe);
    }
  });

  it("returns fixed validated identities and the unchanged execution target without network reads",()=>{
    const originalFetch=globalThis.fetch;
    globalThis.fetch=vi.fn(()=>{throw new Error("readiness must not fetch");});
    try{
      const readiness=getOperationsReadiness(completeEnv);
      expect(readiness.requirements).toEqual([
        {id:"source",state:"present-unverified",missing:[],identities:[{label:"Repository",value:"fixture/app"},{label:"Branch",value:"main"}]},
        {id:"github",state:"present-unverified",missing:[],identities:[]},
        {id:"vercel",state:"present-unverified",missing:[],identities:[{label:"Project",value:"prj_fixture"},{label:"Team",value:"team_fixture"}]},
        {id:"database",state:"present-unverified",missing:[],identities:[{label:"Target",value:`supabase:${databaseRef}:postgres`}]},
      ]);
      expect(readiness.providers).toHaveLength(5);
      expect(readiness.providers.every(entry=>entry.configured)).toBe(true);
      expect(resolveProviderConfiguration("migrations.check",completeEnv)).toEqual({
        ok:true,
        value:{
          target:`supabase:${databaseRef}:postgres`,
          execution:{provider:"github",repository:"fixture/app",branch:"main",project:null,team:null,pendingDigest:null},
        },
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    }finally{globalThis.fetch=originalFetch;}
  });

  it("never serializes credentials, malformed identities, URLs, or mismatched targets",()=>{
    const unsafe=[
      "malformed-repository-canary","unsafe//branch-canary","canary-actions-authority",
      "canary-vercel-authority","malformed-project-canary","malformed-team-canary",
      "https://database-canary.invalid/path?secret=canary","canary-database-authority",
      "mismatched-target-canary",
    ];
    const serialized=JSON.stringify(getOperationsReadiness({
      CORTEX_APP_REPO:"malformed-repository-canary",
      CORTEX_APP_BRANCH:"unsafe//branch-canary",
      CORTEX_ACTIONS_TOKEN:"canary-actions-authority",
      CORTEX_VERCEL_TOKEN:"canary-vercel-authority",
      CORTEX_VERCEL_PROJECT_ID:"malformed-project-canary",
      CORTEX_VERCEL_TEAM_ID:"malformed-team-canary",
      CORTEX_MIGRATION_TARGET:"mismatched-target-canary",
      SUPABASE_URL:"https://database-canary.invalid/path?secret=canary",
      SUPABASE_SERVICE_ROLE_KEY:"canary-database-authority",
    }));
    for(const value of unsafe)expect(serialized).not.toContain(value);
  });

  it("accepts the optional fixed requirement enum in provider catalogs and rejects arbitrary anchors",()=>{
    expect(providerCatalogSchema.safeParse({providers:[{
      operation:"checks",configured:false,detail:"Setup required",setupRequirement:"github",
    }]}).success).toBe(true);
    expect(providerCatalogSchema.safeParse({providers:[{
      operation:"checks",configured:false,detail:"Setup required",
    }]}).success).toBe(true);
    expect(providerCatalogSchema.safeParse({providers:[{
      operation:"checks",configured:false,detail:"Setup required",setupRequirement:"arbitrary-anchor",
    }]}).success).toBe(false);
  });
});
