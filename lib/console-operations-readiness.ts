import type {ProviderContext} from "./console-jobs";
import type {
  OperationsReadiness,
  OperationsRequirement,
  OperationsRequirementId,
  OperationsRequirementIssue,
  ProviderOperationId,
} from "./console-operations-contract";
import {migrationTarget} from "../scripts/migrate";
import {redact} from "./redact";

export type OperationsEnvironment=Record<string,string|undefined>;
type Configuration={target:string;execution:ProviderContext};
export type ProviderConfigurationResult=
  | {ok:true;value:Configuration}
  | {ok:false;code:"unavailable"|"conflict";detail:string;setupRequirement:OperationsRequirementId};

const OPERATIONS:readonly ProviderOperationId[]=[
  "checks","migrations.check","migrations.apply","deploy.preview","deploy.production",
];
const REPOSITORY=/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const BRANCH=/^[-A-Za-z0-9_][A-Za-z0-9_/.-]{0,99}$/;
const PROJECT=/^prj_[A-Za-z0-9]{1,100}$/;
const TEAM=/^team_[A-Za-z0-9]{1,100}$/;
const MIGRATION_TARGET=/^supabase:[a-z]{20}:postgres$/;
const PRESENT_DETAIL="Configured presence only · prepare verifies source and prerequisites";
const CONFLICT_DETAIL="Confirmation changed or expired · review a fresh plan before dispatch";
const CORRECTION:Record<OperationsRequirementIssue["field"],string>={
  CORTEX_APP_REPO:"Use owner/repository without a URL or .git suffix.",
  CORTEX_APP_BRANCH:"Use a branch name without spaces, .. or //, and without a trailing /, . or .lock.",
  CORTEX_VERCEL_PROJECT_ID:"Use a prj_ ID followed by letters and numbers.",
  CORTEX_VERCEL_TEAM_ID:"Use a team_ ID followed by letters and numbers. Leave unset for a personal project.",
  SUPABASE_URL:"Use the supported hosted Supabase project URL: https://<project-ref>.supabase.co.",
  CORTEX_MIGRATION_TARGET:"Use supabase:<project-ref>:postgres with the same project-ref as SUPABASE_URL.",
};

const isMissing=(env:OperationsEnvironment,name:string)=>!env[name]?.trim();
const missing=(env:OperationsEnvironment,names:readonly string[])=>names.filter(name=>isMissing(env,name));
const optionalTeam=(env:OperationsEnvironment)=>env.CORTEX_VERCEL_TEAM_ID?.trim()?env.CORTEX_VERCEL_TEAM_ID!:null;
const identitySafe=(value:string)=>redact(value)===value;
const repositoryValid=(repository:string)=>REPOSITORY.test(repository)&&!repository.endsWith(".git")&&identitySafe(repository);
const branchValid=(branch:string)=>BRANCH.test(branch)
  &&!branch.includes("..")&&!branch.includes("//")&&!branch.endsWith("/")
  &&!branch.endsWith(".")&&!branch.endsWith(".lock")&&identitySafe(branch);
const sourceValid=(repository:string,branch:string)=>repositoryValid(repository)&&branchValid(branch);
const projectValid=(project:string)=>PROJECT.test(project)&&identitySafe(project);
const teamValid=(team:string)=>TEAM.test(team)&&identitySafe(team);

function requirement(id:OperationsRequirementId,state:OperationsRequirement["state"],values:string[]=[],identities:OperationsRequirement["identities"]=[]):OperationsRequirement{
  return{id,state,missing:values,identities};
}

function incompleteRequirement(id:OperationsRequirementId,absent:string[],fields:OperationsRequirementIssue["field"][]):OperationsRequirement{
  return{
    ...requirement(id,absent.length?"missing":"invalid",absent),
    ...(fields.length?{issues:fields.map(field=>({field,reason:CORRECTION[field]}))}:{}),
  };
}

function sourceRequirement(env:OperationsEnvironment):OperationsRequirement{
  const absent=missing(env,["CORTEX_APP_REPO","CORTEX_APP_BRANCH"]);
  const repository=env.CORTEX_APP_REPO!,branch=env.CORTEX_APP_BRANCH!;
  const fields:OperationsRequirementIssue["field"][]=[
    ...(!isMissing(env,"CORTEX_APP_REPO")&&!repositoryValid(repository)?["CORTEX_APP_REPO" as const]:[]),
    ...(!isMissing(env,"CORTEX_APP_BRANCH")&&!branchValid(branch)?["CORTEX_APP_BRANCH" as const]:[]),
  ];
  if(absent.length||fields.length)return incompleteRequirement("source",absent,fields);
  return requirement("source","present-unverified",[],[
    {label:"Repository",value:repository},{label:"Branch",value:branch},
  ]);
}

function githubRequirement(env:OperationsEnvironment):OperationsRequirement{
  const absent=missing(env,["CORTEX_ACTIONS_TOKEN"]);
  return absent.length?requirement("github","missing",absent):requirement("github","present-unverified");
}

function vercelRequirement(env:OperationsEnvironment):OperationsRequirement{
  const absent=missing(env,["CORTEX_VERCEL_TOKEN","CORTEX_VERCEL_PROJECT_ID"]);
  const project=env.CORTEX_VERCEL_PROJECT_ID!,team=optionalTeam(env);
  const fields:OperationsRequirementIssue["field"][]=[
    ...(!isMissing(env,"CORTEX_VERCEL_PROJECT_ID")&&!projectValid(project)?["CORTEX_VERCEL_PROJECT_ID" as const]:[]),
    ...(team!==null&&!teamValid(team)?["CORTEX_VERCEL_TEAM_ID" as const]:[]),
  ];
  if(absent.length||fields.length)return incompleteRequirement("vercel",absent,fields);
  return requirement("vercel","present-unverified",[],[
    {label:"Project",value:project},...(team?[{label:"Team",value:team}]:[]),
  ]);
}

function supportedMigrationTarget(url:string):string|undefined{
  if(!identitySafe(url))return;
  try{
    const target=migrationTarget(url,"api");
    return identitySafe(target)?target:undefined;
  }catch{return;}
}

function databaseEvaluation(env:OperationsEnvironment):{
  requirement:OperationsRequirement;
  target?:string;
  failure?:Extract<ProviderConfigurationResult,{ok:false}>;
}{
  const absent=missing(env,["CORTEX_MIGRATION_TARGET","SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY"]);
  const urlPresent=!isMissing(env,"SUPABASE_URL"),targetPresent=!isMissing(env,"CORTEX_MIGRATION_TARGET");
  const target=urlPresent?supportedMigrationTarget(env.SUPABASE_URL!):undefined;
  const configuredTarget=env.CORTEX_MIGRATION_TARGET!;
  const fields:OperationsRequirementIssue["field"][]=[];
  if(urlPresent&&target===undefined)fields.push("SUPABASE_URL");
  if(targetPresent&&(!MIGRATION_TARGET.test(configuredTarget)||!identitySafe(configuredTarget)||(target!==undefined&&target!==configuredTarget))){
    fields.push("CORTEX_MIGRATION_TARGET");
  }
  if(absent.length)return{requirement:incompleteRequirement("database",absent,fields)};
  if(target===undefined)return{
    requirement:incompleteRequirement("database",[],fields),
    failure:{ok:false,code:"unavailable",detail:"CORTEX_MIGRATION_TARGET requires a supported hosted Supabase target",setupRequirement:"database"},
  };
  if(fields.length)return{
    requirement:incompleteRequirement("database",[],fields),
    failure:{ok:false,code:"conflict",detail:CONFLICT_DETAIL,setupRequirement:"database"},
  };
  return{requirement:requirement("database","present-unverified",[],[{label:"Target",value:target}]),target};
}

const missingRequirement=(names:readonly string[]):OperationsRequirementId=>{
  const first=names[0];
  if(first==="CORTEX_APP_REPO"||first==="CORTEX_APP_BRANCH")return"source";
  if(first==="CORTEX_ACTIONS_TOKEN")return"github";
  if(first==="CORTEX_VERCEL_TOKEN"||first==="CORTEX_VERCEL_PROJECT_ID")return"vercel";
  return"database";
};

export function resolveProviderConfiguration(operation:ProviderOperationId,env:OperationsEnvironment):ProviderConfigurationResult{
  const deploy=operation.startsWith("deploy."),migrations=operation.startsWith("migrations.");
  const needed=[
    "CORTEX_APP_REPO","CORTEX_APP_BRANCH","CORTEX_ACTIONS_TOKEN",
    ...(deploy?["CORTEX_VERCEL_TOKEN","CORTEX_VERCEL_PROJECT_ID"]:[]),
    ...(migrations?["CORTEX_MIGRATION_TARGET","SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY"]:[]),
  ];
  const absent=missing(env,needed);
  if(absent.length)return{
    ok:false,code:"unavailable",detail:`Missing configuration: ${absent.join(", ")}`,
    setupRequirement:missingRequirement(absent),
  };

  const repository=env.CORTEX_APP_REPO!,branch=env.CORTEX_APP_BRANCH!;
  if(!sourceValid(repository,branch))return{
    ok:false,code:"unavailable",detail:"Invalid CORTEX_APP_REPO or CORTEX_APP_BRANCH",setupRequirement:"source",
  };

  const project=deploy?env.CORTEX_VERCEL_PROJECT_ID!:null;
  const team=deploy?optionalTeam(env):null;
  if(deploy&&(!projectValid(project!)||(team!==null&&!teamValid(team))))return{
    ok:false,code:"unavailable",detail:"Invalid CORTEX_VERCEL_PROJECT_ID or CORTEX_VERCEL_TEAM_ID",setupRequirement:"vercel",
  };

  let target=deploy
    ?`vercel:${project}:${operation==="deploy.production"?"production":"preview"}`
    :`github:${repository}`;
  if(migrations){
    const database=databaseEvaluation(env);
    if(database.failure)return database.failure;
    target=database.target!;
  }
  return{ok:true,value:{
    target,
    execution:{provider:deploy?"vercel":"github",repository,branch,project,team,pendingDigest:null},
  }};
}

export function getOperationsReadiness(env:OperationsEnvironment=process.env):OperationsReadiness{
  const requirements=[sourceRequirement(env),githubRequirement(env),vercelRequirement(env),databaseEvaluation(env).requirement];
  const providers=OPERATIONS.map(operation=>{
    const result=resolveProviderConfiguration(operation,env);
    return result.ok
      ?{operation,configured:true,detail:PRESENT_DETAIL}
      :{operation,configured:false,detail:result.detail,setupRequirement:result.setupRequirement};
  });
  return{requirements,providers};
}
