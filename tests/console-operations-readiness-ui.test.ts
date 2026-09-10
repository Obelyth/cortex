import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it,vi} from "vitest";
import {readFileSync} from "node:fs";
import {getOperationsReadiness} from "../lib/console-operations-readiness";
import type {OperationsReadiness} from "../lib/console-operations-contract";
import {LensProvider} from "../app/s/[secret]/console/lens";
import {SettingsScreen,type SettingsScreenProps} from "../app/s/[secret]/console/settings/settings-screen";
import {focusOperationsHash} from "../app/s/[secret]/console/settings/operations-readiness-actions";
import {topLevelRules} from "./support/css";

vi.mock("next/navigation",()=>({useRouter:()=>({refresh:vi.fn()}),usePathname:()=>"/s/synthetic-console/console/settings"}));

const baseProps:SettingsScreenProps={
  ground:"ink",
  vm:{
    writable:false,storeState:"unconfigured",conflicts:[],providers:[],
    guest:{open:false,storeState:"unconfigured",scope:[],citations:false,dailyAsks:10,maxK:5,usedToday:null,queued:0},
  },
  modelOptions:[],activeModel:"",
  learning:{
    writable:false,storeState:"unconfigured",
    ansCache:{on:false,source:"built-in"},ttl:{days:7,min:1,max:30,source:"built-in"},
    cacheEntries:null,cacheHits24h:null,
    handoff:{bytes:24_000,min:4_000,max:100_000,source:"built-in"},
    watch:{
      supersededLink:{on:false,items:0},coaccessGap:{on:false,items:0},
      correctionChain:{on:false,items:0},oversizedPage:{on:false,items:0},
    },
    floor:{value:5,min:2,max:10,source:"built-in"},graph:{state:"off"},
    retrieval:{k:15,budgetBytes:400_000},
  },
  readers:[],readersNote:"no calls",doors:[],
  connect:{guestOpen:false,bearerSet:false,activeModel:null,activeSource:null,guestReader:"unresolved"},
  conflicts:[],
};

function renderSettings(operations:OperationsReadiness):string{
  return renderToStaticMarkup(createElement(LensProvider,null,
    createElement(SettingsScreen,{...baseProps,operations} as SettingsScreenProps),
  ));
}

function operationsMarkup(markup:string):string{
  const start=markup.indexOf('<section class="setOps"');
  const end=markup.indexOf("Environment reference",start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return markup.slice(start,end);
}

describe("Settings operations permissions walkthrough",()=>{
  it("keeps the native disclosure marker while preserving a 44px touch target",()=>{
    const css=readFileSync("app/s/[secret]/console/settings/settings.css","utf8");
    const rule=topLevelRules(css).find(entry=>entry.sel===".setOpsDetails summary");
    expect(rule).toBeDefined();
    expect(rule!.body).toMatch(/(?:^|;)\s*display\s*:\s*list-item\s*(?:;|$)/);
    expect(rule!.body).toMatch(/(?:^|;)\s*min-height\s*:\s*44px\s*(?:;|$)/);
  });

  it("focuses only a recognized operations hash target without polling",()=>{
    const focus=vi.fn(),scrollIntoView=vi.fn();
    const getById=vi.fn((id:string)=>id==="setOperations-vercel"?{focus,scrollIntoView} as unknown as HTMLElement:null);
    expect(focusOperationsHash("#setOperations-vercel",getById)).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({block:"start"});
    expect(focus).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith({preventScroll:true});
    expect(focusOperationsHash("#setReader",getById)).toBe(false);
    expect(focusOperationsHash("#setOperations-%",getById)).toBe(false);
    expect(getById).toHaveBeenCalledTimes(1);
  });

  it("renders all four focusable requirement targets before the service forms without secret entry",()=>{
    const view:OperationsReadiness={
      requirements:[
        {id:"source",state:"missing",missing:["CORTEX_APP_REPO","CORTEX_APP_BRANCH"],identities:[]},
        {id:"github",state:"missing",missing:["CORTEX_ACTIONS_TOKEN"],identities:[]},
        {id:"vercel",state:"invalid",missing:[],identities:[]},
        {id:"database",state:"present-unverified",missing:[],identities:[{label:"Target",value:"supabase:abcdefghijklmnopqrst:postgres"}]},
      ],
      providers:[],
    };
    const markup=renderSettings(view);
    const operations=operationsMarkup(markup);
    for(const id of ["source","github","vercel","database"]){
      expect(operations).toContain(`id="setOperations-${id}"`);
    }
    expect(operations.match(/tabindex="-1"/g)).toHaveLength(5);
    expect(operations).not.toContain("<input");
    expect(operations).not.toContain("<textarea");
    expect(markup.indexOf("Operations permissions")).toBeLessThan(markup.indexOf("Environment reference"));
    expect(operations).toContain("Return to Ops");
    expect(operations).toContain("Refresh setup status");
    expect(operations).toContain(".github/workflows/cortex-dashboard-checks.yml");
    expect(operations).toContain("supabase:&lt;project-ref&gt;:postgres");
    expect(operations).toContain("must match the project in the <code>SUPABASE_URL</code> hostname");
    expect(operations).toContain('href="/s/synthetic-console/console/ops"');
    expect(operations).toContain('type="button"');
    expect(operations).not.toContain("<form");
  });

  it("labels complete configuration as present but unverified and never claims working permission",()=>{
    const ref="abcdefghijklmnopqrst";
    const markup=operationsMarkup(renderSettings(getOperationsReadiness({
      CORTEX_APP_REPO:"fixture/app",CORTEX_APP_BRANCH:"main",CORTEX_ACTIONS_TOKEN:"canary-actions",
      CORTEX_VERCEL_TOKEN:"canary-vercel",CORTEX_VERCEL_PROJECT_ID:"prj_fixture",CORTEX_VERCEL_TEAM_ID:"team_fixture",
      CORTEX_MIGRATION_TARGET:`supabase:${ref}:postgres`,SUPABASE_URL:`https://${ref}.supabase.co`,SUPABASE_SERVICE_ROLE_KEY:"canary-database",
    })));
    expect(markup.match(/Present · unverified/g)).toHaveLength(4);
    expect(markup).toContain("fixture/app");
    expect(markup).toContain("prj_fixture");
    expect(markup).toContain("Presence is not proof");
    expect(markup).not.toContain("permission is working");
    expect(markup).not.toContain("canary-actions");
    expect(markup).not.toContain("canary-vercel");
    expect(markup).not.toContain("canary-database");
  });

  it("withholds malformed identities and gives every external next action noreferrer isolation",()=>{
    const markup=operationsMarkup(renderSettings(getOperationsReadiness({
      CORTEX_APP_REPO:"unsafe repository canary",CORTEX_APP_BRANCH:"feature//unsafe",
      CORTEX_ACTIONS_TOKEN:"present",CORTEX_VERCEL_TOKEN:"present",
      CORTEX_VERCEL_PROJECT_ID:"unsafe-project-canary",CORTEX_VERCEL_TEAM_ID:"unsafe-team-canary",
      CORTEX_MIGRATION_TARGET:"unsafe-target-canary",SUPABASE_URL:"https://unsafe.example",SUPABASE_SERVICE_ROLE_KEY:"present",
    })));
    for(const unsafe of ["unsafe repository canary","feature//unsafe","unsafe-project-canary","unsafe-team-canary","unsafe-target-canary","https://unsafe.example"]){
      expect(markup).not.toContain(unsafe);
    }
    expect(markup.match(/target="_blank" rel="noreferrer"/g)).toHaveLength(4);
  });

  it("shows the affected fields and safe corrections before opening technical help",()=>{
    const markup=operationsMarkup(renderSettings(getOperationsReadiness({
      CORTEX_APP_BRANCH:"main",CORTEX_ACTIONS_TOKEN:"present",CORTEX_VERCEL_TOKEN:"present",
      CORTEX_VERCEL_PROJECT_ID:"private-project-canary",CORTEX_VERCEL_TEAM_ID:"private-team-canary",
      CORTEX_MIGRATION_TARGET:"private-migration-canary",SUPABASE_URL:"https://abcdefghijklmnopqrst.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"present",
    })));
    const visible=markup.replace(/<details\b[\s\S]*?<\/details>/g,"");
    expect(visible).toContain("CORTEX_APP_REPO");
    expect(visible).toContain("CORTEX_VERCEL_PROJECT_ID");
    expect(visible).toContain("prj_");
    expect(visible).toContain("CORTEX_VERCEL_TEAM_ID");
    expect(visible).toContain("team_");
    expect(visible).toContain("CORTEX_MIGRATION_TARGET");
    expect(visible).toContain("same project-ref as SUPABASE_URL");
    expect(markup).not.toContain("private-");
  });

  it("gives each setup setting its own Config or Secret row and a copy-name control",()=>{
    const markup=operationsMarkup(renderSettings(getOperationsReadiness({})));
    const rows=markup.match(/<tr\b[\s\S]*?<\/tr>/g)??[];
    for(const [name,kind] of [
      ["CORTEX_APP_REPO","Config"],["CORTEX_APP_BRANCH","Config"],["CORTEX_ACTIONS_TOKEN","Secret"],
      ["CORTEX_VERCEL_TOKEN","Secret"],["CORTEX_VERCEL_PROJECT_ID","Config"],["CORTEX_VERCEL_TEAM_ID","Config"],
      ["CORTEX_MIGRATION_TARGET","Config"],["SUPABASE_URL","Config"],["SUPABASE_SERVICE_ROLE_KEY","Secret"],
      ["SUPABASE_DB_URL","Secret"],
    ]){
      const row=rows.find(row=>row.includes(`aria-label="Copy name ${name}"`));
      expect(row,`${name} needs its own labeled copy control`).toBeDefined();
      expect(row).toContain(`>${kind}<`);
      expect(row).toContain(`<code>${name}</code>`);
    }
  });

  it("shows safe corrections beside missing siblings before opening technical help",()=>{
    const markup=operationsMarkup(renderSettings(getOperationsReadiness({
      CORTEX_APP_BRANCH:"github_pat_syntheticOpaqueCredential123",
      CORTEX_VERCEL_PROJECT_ID:"bad-project-canary",CORTEX_VERCEL_TEAM_ID:"bad-team-canary",
      CORTEX_MIGRATION_TARGET:"bad-target-canary",SUPABASE_URL:"https://unsupported-canary.invalid",
    })));
    const visible=markup.replace(/<details\b[\s\S]*?<\/details>/g,"");
    expect(visible.match(/Setup needed/g)).toHaveLength(4);
    expect(visible).toContain("CORTEX_APP_BRANCH");
    expect(visible).toContain("Use a branch name");
    expect(visible).toContain("CORTEX_VERCEL_PROJECT_ID");
    expect(visible).toContain("prj_");
    expect(visible).toContain("CORTEX_VERCEL_TEAM_ID");
    expect(visible).toContain("team_");
    expect(visible).toContain("CORTEX_MIGRATION_TARGET");
    expect(visible).toContain("same project-ref as SUPABASE_URL");
    expect(visible).toContain("Use the supported hosted Supabase project URL");
    for(const unsafe of ["syntheticOpaqueCredential123","bad-project-canary","bad-team-canary","bad-target-canary","unsupported-canary"]){
      expect(markup).not.toContain(unsafe);
    }
  });
});
