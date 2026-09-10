"use client";

import {useState} from "react";
import type {
  OperationsReadiness,
  OperationsRequirement,
  OperationsRequirementId,
  ProviderReadinessEntry,
} from "@/lib/console-operations-contract";
import {operationsRequirementAnchor} from "@/lib/console-operations-contract";
import {OperationsReadinessActions} from "./operations-readiness-actions";
import {copyExactText} from "./clipboard";
import styles from "./operations-readiness.module.css";

const setupDestinations={
  source:"https://vercel.com/dashboard",
  github:"https://github.com/settings/personal-access-tokens",
  vercel:"https://vercel.com/account/tokens",
  database:"https://supabase.com/dashboard",
} as const;

type SetupField={name:string;kind:"Config"|"Secret";find:string;optional?:boolean};
const setupFields:Record<OperationsRequirementId,readonly SetupField[]>={
  source:[
    {name:"CORTEX_APP_REPO",kind:"Config",find:"GitHub application repository · copy owner/repository from its address."},
    {name:"CORTEX_APP_BRANCH",kind:"Config",find:"GitHub application repository · use its approved default or configured branch."},
  ],
  github:[
    {name:"CORTEX_ACTIONS_TOKEN",kind:"Secret",find:"GitHub personal access tokens · create a dedicated token for the selected application repository."},
  ],
  vercel:[
    {name:"CORTEX_VERCEL_TOKEN",kind:"Secret",find:"Vercel account settings → Tokens · create a dedicated token for the owning account or team."},
    {name:"CORTEX_VERCEL_PROJECT_ID",kind:"Config",find:"Vercel project settings · copy the Project ID beginning prj_."},
    {name:"CORTEX_VERCEL_TEAM_ID",kind:"Config",find:"Vercel team settings · copy the Team ID beginning team_ for a team-owned project. Leave unset for a personal project.",optional:true},
  ],
  database:[
    {name:"CORTEX_MIGRATION_TARGET",kind:"Config",find:"Build supabase:<project-ref>:postgres from the project-ref in SUPABASE_URL."},
    {name:"SUPABASE_URL",kind:"Config",find:"Supabase project API settings · copy the Project URL for the same project."},
    {name:"SUPABASE_SERVICE_ROLE_KEY",kind:"Secret",find:"Supabase project API keys · use the service_role key for the same project."},
    {name:"SUPABASE_DB_URL",kind:"Secret",find:"Supabase project Connect dialog · database connection string. Workflow only: save in the protected cortex-database GitHub environment."},
  ],
};

function SetupFieldRow({field}:Readonly<{field:SetupField}>) {
  const [copyState,setCopyState]=useState<"idle"|"copied"|"failed">("idle");
  return <tr>
    <td><span className={styles.kind}>{field.kind}</span></td>
    <th scope="row">
      <code>{field.name}</code>
      {field.optional&&<span className={styles.optional}>Optional · team projects</span>}
      <button className={styles.copyName} type="button" aria-label={`Copy name ${field.name}`} onClick={async()=>{
        const result=await copyExactText(field.name);
        setCopyState(result.ok?"copied":"failed");
      }}>Copy name</button>
      <span className={styles.copyStatus} role="status">{copyState==="copied"?"Name copied":copyState==="failed"?"Copy failed · select the name above":""}</span>
    </th>
    <td>{field.find}</td>
  </tr>;
}

function SetupFields({id}:Readonly<{id:OperationsRequirementId}>) {
  return <table className={styles.fields}>
    <caption>Settings to add · Config identifies a source or target; Secret grants access.</caption>
    <thead><tr><th scope="col">Type</th><th scope="col">Setting name</th><th scope="col">Where to find it</th></tr></thead>
    <tbody>{setupFields[id].map(field=><SetupFieldRow key={field.name} field={field}/>)}</tbody>
  </table>;
}

const requirementCopy:Record<OperationsRequirementId,{
  title:string;
  enables:string;
  action:string;
  guidance:React.ReactNode;
}>={
  source:{
    title:"Application source",
    enables:"Pins the application repository and branch used by checks, migration review and deployments.",
    action:"Open hosting project",
    guidance:<p>These settings identify application source. They do not fall back to the notes repository.</p>,
  },
  github:{
    title:"GitHub permissions",
    enables:"Allows checks and migration commands to start the fixed GitHub Actions workflow after confirmation.",
    action:"Create GitHub token",
    guidance:<><p>The dedicated token needs Actions read/write and Contents read. Install <code>.github/workflows/cortex-dashboard-checks.yml</code> on the default and configured branch.</p><p>Do not reuse a notes content token.</p></>,
  },
  vercel:{
    title:"Deployment permissions",
    enables:"Allows confirmed preview and production deployment commands for one pinned Vercel project.",
    action:"Create Vercel token",
    guidance:<><p>Link the application repository and enable Vercel System Environment Variables in the hosting project settings.</p><p>A Vercel token can affect its owning account or team even though Cortex pins every request to one project. Use dedicated authority with the narrowest ownership available. A token being present does not prove that it can deploy.</p></>,
  },
  database:{
    title:"Database migration target",
    enables:"Allows migration checks and confirmed applies against one matching hosted Supabase project.",
    action:"Open Supabase project",
    guidance:<><p>Use the 20-letter project-ref in <code>{"supabase:<project-ref>:postgres"}</code>. It must match the project in the <code>SUPABASE_URL</code> hostname.</p><p>Initial or legacy schema setup requires reviewed administration. Never reset an existing database or invent migration ledger records.</p></>,
  },
};

const stateCopy:Record<OperationsRequirement["state"],string>={
  missing:"Setup needed",
  invalid:"Needs correction",
  "present-unverified":"Present · unverified",
};

const operationLabels:Record<ProviderReadinessEntry["operation"],string>={
  checks:"Run checks",
  "migrations.check":"Check migrations",
  "migrations.apply":"Apply migrations",
  "deploy.preview":"Deploy preview",
  "deploy.production":"Deploy production",
};

function blockedCommands(providers:readonly ProviderReadinessEntry[],id:OperationsRequirementId):ProviderReadinessEntry["operation"][] {
  return providers.filter(provider=>!provider.configured&&provider.setupRequirement===id).map(provider=>provider.operation);
}

function Requirement({requirement,providers}:Readonly<{requirement:OperationsRequirement;providers:readonly ProviderReadinessEntry[]}>) {
  const copy=requirementCopy[requirement.id];
  const blocked=blockedCommands(providers,requirement.id);
  return <article className="setOpsRequirement">
    <div className="setOpsHead">
      <div className="setOpsTitle">
        <h4 id={operationsRequirementAnchor(requirement.id)} tabIndex={-1}>{copy.title}</h4>
        <p>{copy.enables}</p>
      </div>
      <span className={`setOpsState setOpsState-${requirement.state}`}>{stateCopy[requirement.state]}</span>
    </div>
    {requirement.identities.length>0&&<dl className="setOpsIdentities">
      {requirement.identities.map(identity=><div key={identity.label}><dt>{identity.label}</dt><dd>{identity.value}</dd></div>)}
    </dl>}
    {requirement.issues?.map(issue=><p className={styles.correction} key={issue.field}>
      <code>{issue.field}</code> · {issue.reason}
    </p>)}
    {requirement.missing.length>0&&<p className={styles.correction}>Missing in this runtime: <code>{requirement.missing.join(" · ")}</code>.</p>}
    {blocked.length>0&&<p className="setOpsBlocked">Blocked here: {blocked.map(operation=>operationLabels[operation]).join(" · ")}</p>}
    <div className="setOpsNextRow">
      <a className="setOpsNext" href={setupDestinations[requirement.id]} target="_blank" rel="noreferrer">{copy.action}</a>
      <details className="setOpsDetails">
        <summary>Technical setup</summary>
        <div><SetupFields id={requirement.id}/>{copy.guidance}</div>
      </details>
    </div>
  </article>;
}

export function OperationsReadinessPanel({view}:Readonly<{view:OperationsReadiness}>) {
  return <section className="setOps" aria-labelledby="setOperations">
    <div className="setOpsIntro">
      <h3 id="setOperations" tabIndex={-1}>Operations permissions</h3>
      <p>Complete this one-time provider setup before using checks, migrations or deployments in Ops. Cortex reports only safe configuration presence here. Presence is not proof that a token works or has the required permission.</p>
    </div>
    <div className="setOpsRequirements">
      {view.requirements.map(requirement=><Requirement key={requirement.id} requirement={requirement} providers={view.providers}/>)}
    </div>
    <div className="setOpsDeployment">
      <b>Make the first deployment from Vercel.</b>
      <p>Save runtime settings in the Cortex hosting project’s Environment Variables. Select Production for the live Cortex app; also select Preview if you run Cortex in preview deployments. This scope belongs to the app running these commands.</p>
      <p>Config and Secret settings both require a new deployment before Cortex can see changes. Refreshing the old runtime cannot load newly saved values. Start that deployment in Vercel for the selected environment, open the new deployment, then return here to refresh setup status.</p>
    </div>
    <OperationsReadinessActions />
  </section>;
}
