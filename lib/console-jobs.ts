import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { runDefaultDiagnostics, type DiagnosticRun } from "./console-diagnostics";
import { consoleJobSchema, jobCheckSchema, operationIdSchema, type ConsoleJob, type ConsoleJobListItem, type JobCheck, type OperationId } from "./console-job-contract";
export type { ConsoleJob, ConsoleJobListItem, JobCheck, JobState, OperationId } from "./console-job-contract";

export interface JobRequest { operation: OperationId; requestKey: string; target?: string; sourceSha?: string | null }
export interface ProviderContext { provider:"github"|"vercel"; repository:string; branch:string; project:string|null; team:string|null; pendingDigest:string|null }
export interface JobAdmission { requestKey: string; fingerprint: string; operation: OperationId; target: string; sourceSha: string | null; execution?:ProviderContext; unresolvedId?:string|null; expiresAt?:string }
/** `active` names the receipt holding the (operation,target) slot when the store can say. */
export type EnqueueResult = { outcome: "enqueued" | "replay"; job: ConsoleJob } | { outcome: "active"; job?: ConsoleJob } | { outcome: "key_conflict" | "capacity" | "mutation_busy" | "conflict" };
export type ClaimResult = { outcome: "claimed"; job: ConsoleJob; token: string } | { outcome: "not_claimed"; job: ConsoleJob };
/** `resumed`: an uncertain receipt returned to running on a verified provider status — a mutation
 *  holds the guard again. `conflict`: the provider still reports an acknowledged receipt running
 *  while a later command owns its target or another mutation holds the guard; the row stays
 *  uncertain and its summary names the holder (migration 20260909041000). */
export type PublishResult = { outcome: "published" | "resumed" | "stale" | "conflict"; job: ConsoleJob };
export interface JobCompletion { state: "running" | "succeeded" | "failed" | "uncertain"; checks: JobCheck[]; summary: string; providerId: string | null; sourceSha?: string | null }
export interface ProviderClaim {job:ConsoleJob;execution:ProviderContext;token:string|null;pollToken:string}
export interface ConsoleJobStore {
  enqueue(input: JobAdmission): Promise<EnqueueResult>;
  claim(id: string, ownerToken: string): Promise<ClaimResult>;
  publish(id: string, token: string, completion: JobCompletion): Promise<PublishResult>;
  get(id: string): Promise<ConsoleJob | null>;
  findByRequest(requestKey: string): Promise<{job:ConsoleJob;fingerprint:string} | null>;
  list(cursor?: string | null): Promise<{ items: ConsoleJobListItem[]; nextCursor: string | null }>;
  acknowledgeUncertain(id: string): Promise<ConsoleJob>;
  markUncertain(id: string): Promise<ConsoleJob>;
  lastUnresolved?():Promise<string|null>;
  claimReconciliation?(id:string):Promise<ProviderClaim|null>;
  publishReconciliation?(id:string,token:string,pollToken:string,completion:JobCompletion):Promise<PublishResult>;
  releaseReconciliation?(id:string,pollToken:string):Promise<void>;
  migrationLedger?():Promise<import("../scripts/migrate").MigrationLedger>;
}

export type JobErrorCode = "invalid" | "key_conflict" | "capacity" | "mutation_busy" | "active" | "schema_required" | "unavailable" | "malformed" | "uncertain" | "conflict";
const ERROR_MESSAGE: Record<JobErrorCode, string> = {
  invalid: "invalid command request", key_conflict: "request key was already used for different input", capacity: "command capacity reached · try after an active job finishes",
  mutation_busy: "another migration or deployment command is unresolved", active: "this operation and target already have an active command",
  schema_required: "command history is not installed · apply the tracked console_jobs migrations through 20260909043000 once from the provider dashboard, then refresh",
  unavailable: "command history unavailable", malformed: "command store returned an invalid response", uncertain: "command outcome uncertain · recheck its receipt before retrying",
  conflict:"Confirmation changed or expired · review a fresh plan before dispatch",
};
export class JobError extends Error {
  /** `activeId`: for `active`, the receipt that holds the slot, so a route can hand it to the operator. */
  constructor(public readonly code: JobErrorCode, message = ERROR_MESSAGE[code], public readonly activeId?: string) { super(message); }
}

const requestSchema = z.object({ operation: operationIdSchema, requestKey: z.uuidv4(), target: z.string().trim().min(1).max(160).optional(), sourceSha: z.string().regex(/^[0-9a-f]{7,64}$/).nullable().optional() }).strict();
const canonical = (input: { operation: OperationId; target: string; sourceSha: string | null }) => JSON.stringify({ operation: input.operation, target: input.target, sourceSha: input.sourceSha });

export function prepareJobRequest(raw: JobRequest): JobAdmission {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new JobError("invalid");
  const target = parsed.data.target ?? "deployment";
  const sourceSha = parsed.data.sourceSha ?? null;
  return { ...parsed.data, target, sourceSha, fingerprint: createHash("sha256").update(canonical({ operation: parsed.data.operation, target, sourceSha })).digest("hex") };
}

export interface ConsoleOperationAdapter {
  supports(operation: OperationId): boolean;
  execute(operation: OperationId, target: string, signal: AbortSignal,job:ConsoleJob): Promise<JobCompletion>;
}
export interface RequestJobDependencies {
  store: ConsoleJobStore;
  diagnostics?: () => Promise<DiagnosticRun>;
  adapters?: ConsoleOperationAdapter[];
}
const completionSchema=z.object({state:z.enum(["running","succeeded","failed","uncertain"]),checks:z.array(jobCheckSchema).max(64),summary:z.string().max(1000),providerId:z.string().max(256).nullable(),sourceSha:z.string().regex(/^[0-9a-f]{7,64}$/).nullable().optional()}).strict();
// PostgreSQL jsonb text adds member separators that JSON.stringify omits. Keep a fixed cushion
// below the database's 32,768-byte check after measuring the complete UTF-8 result envelope.
const MAX_DURABLE_RESULT_BYTES = 32_000;
const resultBytes = (completion: JobCompletion) => Buffer.byteLength(JSON.stringify({ checks: completion.checks, summary: completion.summary }), "utf8");

function fitDurableCompletion(completion: JobCompletion): JobCompletion {
  if (resultBytes(completion) <= MAX_DURABLE_RESULT_BYTES) return completion;
  return {
    ...completion,
    checks: [{ name: "result envelope", state: "unavailable", detail: "Detailed results exceeded the durable receipt limit and were omitted." }],
    summary: `${completion.state === "succeeded" ? "Succeeded" : completion.state === "failed" ? "Failed" : "Outcome uncertain"} · detailed results exceeded the durable receipt limit`,
  };
}

const validatedJob = (value: unknown): ConsoleJob => {
  const parsed = consoleJobSchema.safeParse(value);
  if (!parsed.success) throw new JobError("malformed");
  return parsed.data;
};

function unsupported(operation: OperationId): JobCompletion {
  const provider = operation === "checks" ? "checks provider" : operation.startsWith("deploy.") ? "deployment provider" : "migration provider";
  return { state: "failed", checks: [{ name: provider, state: "unavailable", detail: `${provider} not configured · add explicit authority in Settings` }], summary: `${provider} not configured · no dispatch performed`, providerId: null };
}

export async function requestJob(raw: JobRequest, deps: RequestJobDependencies): Promise<ConsoleJob> {
  return executeJobAdmission(prepareJobRequest(raw),deps);
}
export async function executeJobAdmission(input:JobAdmission,deps:RequestJobDependencies):Promise<ConsoleJob>{
  let admission: EnqueueResult;
  try {
    admission = await deps.store.enqueue(input);
  } catch (error) {
    if (!(error instanceof JobError) || error.code !== "uncertain") throw error;
    const recovered = await deps.store.findByRequest(input.requestKey).catch(() => null);
    if (recovered && recovered.fingerprint !== input.fingerprint) throw new JobError("key_conflict");
    const reconciled=recovered?.job??null;
    if (!reconciled) throw error;
    admission = { outcome: "replay", job: validatedJob(reconciled) };
  }
  if (admission.outcome === "active") {
    // The refusal names the receipt holding the slot. A queued receipt whose request never claimed
    // it is the operator's to fence ("Mark lost response uncertain"); without the id every later
    // click lands on the same refusal.
    const held = admission.job ? consoleJobSchema.safeParse(admission.job) : null;
    const activeId = held?.success ? held.data.id : undefined;
    throw new JobError("active", activeId ? `${ERROR_MESSAGE.active} · receipt ${activeId} holds it · open it and, if its request never claimed it, mark its lost response uncertain` : undefined, activeId);
  }
  if (admission.outcome !== "enqueued" && admission.outcome !== "replay") throw new JobError(admission.outcome);
  const admitted = validatedJob(admission.job);
  const ownerToken = randomUUID();
  let claim: ClaimResult;
  try {
    claim = await deps.store.claim(admitted.id, ownerToken);
  } catch (error) {
    if (!(error instanceof JobError) || error.code !== "uncertain") throw error;
    // A lost claim reply is safe to retry only with the same durable owner. SQL either returns
    // that owner's original dispatch token or refuses it; a different caller never inherits it.
    // That contract is the two-argument console_job_claim(job_id, owner_token) from migration
    // 20260908163000. The adapter always names owner_token, so a database still on the
    // one-argument overload answers 404/PGRST202 and the store reports schema_required — it can
    // never fall through to the unfenced claim and dispatch a second worker.
    claim = await deps.store.claim(admitted.id, ownerToken);
  }
  if (claim.outcome === "not_claimed") return validatedJob(claim.job);
  validatedJob(claim.job);

  let completion: JobCompletion;
  try {
    if (input.operation === "diagnostics") {
      const result = await (deps.diagnostics ?? runDefaultDiagnostics)();
      completion = { state: result.checks.some((check) => check.state === "failed") ? "failed" : "succeeded", checks: result.checks, summary: result.summary, providerId: null, sourceSha: result.sourceSha };
    } else {
      const adapter = deps.adapters?.find((candidate) => candidate.supports(input.operation));
      completion = adapter ? await adapter.execute(input.operation, input.target, AbortSignal.timeout(30_000),admitted) : unsupported(input.operation);
    }
  } catch (error) {
    console.error(`[console jobs] ${input.operation} outcome uncertain; provider detail suppressed`);
    completion = { state: "uncertain", checks: [{ name: input.operation, state: "unavailable", detail: "completion was not confirmed · recheck before retrying" }], summary: "Outcome uncertain · recheck before retrying", providerId: null };
  }
  const parsedCompletion=completionSchema.safeParse(completion);
  if(!parsedCompletion.success)completion={state:"uncertain",checks:[{name:input.operation,state:"unavailable",detail:"provider returned an invalid completion · recheck before retrying"}],summary:"Outcome uncertain · invalid completion",providerId:null};
  else completion=parsedCompletion.data;
  completion=fitDurableCompletion(completion);
  try {
    const result = await deps.store.publish(admitted.id, claim.token, completion);
    return validatedJob(result.job);
  } catch (error) {
    const reconciled = await deps.store.get(admitted.id).catch(() => null);
    if (reconciled && ["succeeded", "failed", "uncertain"].includes(reconciled.state)) return validatedJob(reconciled);
    throw new JobError("uncertain");
  }
}
