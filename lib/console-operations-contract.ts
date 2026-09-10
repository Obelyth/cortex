export type OperationsRequirementId="source"|"github"|"vercel"|"database";
export type RequirementState="missing"|"invalid"|"present-unverified";
export type ProviderOperationId="checks"|"migrations.check"|"migrations.apply"|"deploy.preview"|"deploy.production";

export interface OperationsRequirementIssue {
  field:"CORTEX_APP_REPO"|"CORTEX_APP_BRANCH"|"CORTEX_VERCEL_PROJECT_ID"|"CORTEX_VERCEL_TEAM_ID"|"SUPABASE_URL"|"CORTEX_MIGRATION_TARGET";
  /** Fixed setup guidance only; never an environment value or caught error. */
  reason:string;
}

export interface OperationsRequirement {
  id:OperationsRequirementId;
  state:RequirementState;
  missing:string[];
  identities:Array<{label:string;value:string}>;
  issues?:OperationsRequirementIssue[];
}

export interface ProviderReadinessEntry {
  operation:ProviderOperationId;
  configured:boolean;
  detail:string;
  setupRequirement?:OperationsRequirementId;
}

export interface OperationsReadiness {
  requirements:OperationsRequirement[];
  providers:ProviderReadinessEntry[];
}

export const operationsRequirementAnchor=(id:OperationsRequirementId)=>`setOperations-${id}`;
