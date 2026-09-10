import { z } from "zod";
import {
  JobError,
  type ClaimResult,
  type ConsoleJob,
  type ConsoleJobStore,
  type EnqueueResult,
  type JobAdmission,
  type JobCompletion,
  type PublishResult,
} from "./console-jobs";
import { consoleJobListItemSchema, consoleJobSchema, type ConsoleJobListItem } from "./console-job-contract";

const TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const providerContextSchema=z.object({provider:z.enum(["github","vercel"]),repository:z.string().max(200),branch:z.string().max(100),project:z.string().max(120).nullable(),team:z.string().max(120).nullable(),pendingDigest:z.string().regex(/^[a-f0-9]{64}$/).nullable()}).strict();
const rawRow = z.object({
  id: z.uuidv4(), operation: z.string(), state: z.string(), requested_at: z.string(), updated_at: z.string(),
  source_sha: z.string().nullable(), target: z.string(), result: z.unknown(), provider_id: z.string().nullable(),
}).passthrough();
const storedResult = z.object({ checks: z.array(z.unknown()).max(64).default([]), summary: z.string().max(1000).default("") }).passthrough();
const rawListRow = z.object({ id: z.uuidv4(), operation: z.string(), state: z.string(), requested_at: z.string(), updated_at: z.string(), source_sha: z.string().nullable(), target: z.string(), summary: z.string(), check_count: z.number().int(), provider_id: z.string().nullable() }).strict();

function job(value: unknown): ConsoleJob {
  const raw = rawRow.parse(value);
  const result = storedResult.parse(raw.result ?? {});
  return consoleJobSchema.parse({ id: raw.id, operation: raw.operation, state: raw.state, requestedAt: raw.requested_at, updatedAt: raw.updated_at, sourceSha: raw.source_sha, target: raw.target, checks: result.checks, summary: result.summary, providerId: raw.provider_id });
}
function listItem(value: unknown): ConsoleJobListItem {
  const raw=rawListRow.parse(value);
  return consoleJobListItemSchema.parse({id:raw.id,operation:raw.operation,state:raw.state,requestedAt:raw.requested_at,updatedAt:raw.updated_at,sourceSha:raw.source_sha,target:raw.target,summary:raw.summary,checkCount:raw.check_count,providerId:raw.provider_id});
}

async function boundedJson(res: Response,maxBytes=MAX_RESPONSE_BYTES): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      void reader.cancel();
      throw new JobError("malformed");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new JobError("malformed"); }
}

function missingSchema(status: number, value: unknown): boolean {
  const code = value && typeof value === "object" ? (value as Record<string, unknown>).code : null;
  return status === 404 && (code === "PGRST202" || code === "PGRST205" || code === "42P01");
}

type Cursor = { requestedAt: string; id: string };
function encodeCursor(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString("base64url"); }
export function decodeJobCursor(value: string): Cursor {
  try {
    const parsed = z.object({ requestedAt: z.iso.datetime({ offset: true }), id: z.uuidv4() }).strict().parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (value.length > 256) throw new Error("long");
    return parsed;
  } catch { throw new JobError("invalid"); }
}

let override: ConsoleJobStore | null | undefined;
export function __setConsoleJobStore(store: ConsoleJobStore | null | undefined): void { override = store; }

export function consoleJobStore(): ConsoleJobStore | null {
  if (override !== undefined) return override;
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;

  async function call(path: string, init: RequestInit = {},maxBytes=MAX_RESPONSE_BYTES): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${base}/rest/v1/${path}`, {
        ...init,
        cache: "no-store",
        headers: { apikey: key!, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch { throw new JobError(init.method === "POST" ? "uncertain" : "unavailable"); }
    const value = await boundedJson(res,maxBytes);
    if (!res.ok) {
      if (missingSchema(res.status, value)) throw new JobError("schema_required");
      throw new JobError(init.method === "POST" ? "uncertain" : "unavailable");
    }
    return value;
  }
  const rpc = (name: string, body: object) => call(`rpc/${name}`, { method: "POST", body: JSON.stringify(body) });
  const outcome = (value: unknown) => z.object({ outcome: z.string(), job: z.unknown().optional(), token: z.string().optional() }).strict().parse(value);

  const store: ConsoleJobStore = {
    async enqueue(input: JobAdmission): Promise<EnqueueResult> {
      let value: ReturnType<typeof outcome>;
      try { value = outcome(await rpc(input.execution?"console_job_enqueue_provider":"console_job_enqueue", { request_key: input.requestKey, input_fingerprint: input.fingerprint, operation_name: input.operation, target_name: input.target, source_sha: input.sourceSha,...(input.execution?{execution_value:input.execution,expires_at:input.expiresAt,unresolved_id:input.unresolvedId??null}:{}) })); }
      catch (error) { if (error instanceof JobError) throw error; throw new JobError("malformed"); }
      if (value.outcome === "active") {
        // Databases before 20260909041000 answer `active` without the receipt; a malformed one
        // degrades to the plain refusal rather than failing the whole admission.
        let held: ConsoleJob | undefined;
        try { held = value.job ? job(value.job) : undefined; } catch { held = undefined; }
        return { outcome: "active", ...(held ? { job: held } : {}) };
      }
      if (["key_conflict", "capacity", "mutation_busy","conflict"].includes(value.outcome)) return { outcome: value.outcome as "key_conflict" | "capacity" | "mutation_busy" | "conflict" };
      if ((value.outcome === "enqueued" || value.outcome === "replay") && value.job) return { outcome: value.outcome, job: job(value.job) };
      throw new JobError("malformed");
    },
    async claim(id, ownerToken): Promise<ClaimResult> {
      let value: ReturnType<typeof outcome>;
      try { value = outcome(await rpc("console_job_claim", { job_id: id, owner_token: ownerToken })); } catch (error) { if (error instanceof JobError) throw error; throw new JobError("malformed"); }
      if (value.outcome === "claimed" && value.job && z.uuidv4().safeParse(value.token).success) return { outcome: "claimed", job: job(value.job), token: value.token! };
      if (value.outcome === "not_claimed" && value.job) return { outcome: "not_claimed", job: job(value.job) };
      throw new JobError("malformed");
    },
    async publish(id, token, completion): Promise<PublishResult> {
      let value: ReturnType<typeof outcome>;
      try {
        value = outcome(await rpc("console_job_publish", { job_id: id, claim_token: token, completion_state: completion.state, result_value: { checks: completion.checks, summary: completion.summary }, provider_identity: completion.providerId, source_sha: completion.sourceSha ?? null }));
      } catch (error) { if (error instanceof JobError) throw error; throw new JobError("malformed"); }
      if ((value.outcome === "published" || value.outcome === "resumed" || value.outcome === "stale" || value.outcome === "conflict") && value.job) return { outcome: value.outcome, job: job(value.job) };
      throw new JobError("malformed");
    },
    async get(id) {
      let value: unknown;
      try { value = await call(`console_jobs?select=id,operation,state,requested_at,updated_at,source_sha,target,result,provider_id&id=eq.${encodeURIComponent(id)}&limit=1`); }
      catch (error) { throw error instanceof JobError ? error : new JobError("malformed"); }
      try{const rows = z.array(z.unknown()).max(1).parse(value);return rows[0] ? job(rows[0]) : null;}catch{throw new JobError("malformed");}
    },
    async findByRequest(requestKey) {
      let value: unknown;
      try { value = await call(`console_jobs?select=id,operation,state,requested_at,updated_at,source_sha,target,result,provider_id,input_fingerprint&request_key=eq.${encodeURIComponent(requestKey)}&limit=1`); }
      catch (error) { throw error instanceof JobError ? error : new JobError("malformed"); }
      try{const rows = z.array(z.unknown()).max(1).parse(value);
        if(!rows[0])return null;
        const fingerprint=z.object({input_fingerprint:z.string().regex(/^[0-9a-f]{64}$/)}).passthrough().parse(rows[0]).input_fingerprint;
        return {job:job(rows[0]),fingerprint};
      }catch{throw new JobError("malformed");}
    },
    async list(cursor = null) {
      const before = cursor ? decodeJobCursor(cursor) : null;
      const filter = before ? `&or=(requested_at.lt.${encodeURIComponent(before.requestedAt)},and(requested_at.eq.${encodeURIComponent(before.requestedAt)},id.lt.${before.id}))` : "";
      let value: unknown;
      try { value = await call(`console_jobs?select=id,operation,state,requested_at,updated_at,source_sha,target,summary,check_count,provider_id&order=requested_at.desc,id.desc&limit=26${filter}`); }
      catch (error) { throw error instanceof JobError ? error : new JobError("malformed"); }
      let rows:ConsoleJobListItem[];try{rows=z.array(z.unknown()).max(26).parse(value).map(listItem);}catch{throw new JobError("malformed");}
      const items = rows.slice(0, 25);
      const last = rows.length > 25 ? items.at(-1)! : null;
      return { items, nextCursor: last ? encodeCursor({ requestedAt: last.requestedAt, id: last.id }) : null };
    },
    async acknowledgeUncertain(id) {
      let value: ReturnType<typeof outcome>;
      try { value = outcome(await rpc("console_job_acknowledge_uncertain", { job_id: id })); } catch (error) { if (error instanceof JobError) throw error; throw new JobError("malformed"); }
      if (value.outcome === "acknowledged" && value.job) return job(value.job);
      throw new JobError("malformed");
    },
    async markUncertain(id) {
      let value: ReturnType<typeof outcome>;
      try { value = outcome(await rpc("console_job_mark_uncertain", { job_id: id })); } catch (error) { if (error instanceof JobError) throw error; throw new JobError("malformed"); }
      if (value.outcome === "marked_uncertain" && value.job) return job(value.job);
      if (value.outcome === "not_running") throw new JobError("invalid", "only queued or running commands can be marked uncertain");
      throw new JobError("malformed");
    },
    async lastUnresolved(){
      try{const rows=z.array(z.object({last_unresolved_id:z.uuidv4().nullable()}).strict()).length(1).parse(await call("console_job_mutation_guard?select=last_unresolved_id&singleton=eq.true&limit=1"));return rows[0].last_unresolved_id;}catch(error){throw error instanceof JobError?error:new JobError("malformed");}
    },
    async claimReconciliation(id){
      const raw=await rpc("console_job_reconcile_claim",{job_id:id});
      const none=z.object({outcome:z.literal("not_claimed")}).strict().safeParse(raw);if(none.success)return null;
      try{const value=z.object({outcome:z.literal("claimed"),job:z.unknown(),token:z.uuidv4().nullable(),pollToken:z.uuidv4(),execution:providerContextSchema}).strict().parse(raw);return{job:job(value.job),token:value.token,pollToken:value.pollToken,execution:value.execution};}catch{throw new JobError("malformed");}
    },
    async publishReconciliation(id,token,pollToken,completion){
      const value=outcome(await rpc("console_job_reconcile_publish",{job_id:id,claim_token:token,poll_owner:pollToken,completion_state:completion.state,result_value:{checks:completion.checks,summary:completion.summary},provider_identity:completion.providerId}));
      if((value.outcome==="published"||value.outcome==="resumed"||value.outcome==="stale"||value.outcome==="conflict")&&value.job)return{outcome:value.outcome,job:job(value.job)};throw new JobError("malformed");
    },
    async releaseReconciliation(id,pollToken){
      try{z.object({released:z.boolean()}).strict().parse(await rpc("console_job_reconcile_release",{job_id:id,poll_owner:pollToken}));}catch(error){throw error instanceof JobError?error:new JobError("malformed");}
    },
    async migrationLedger(){
      try{return z.object({state:z.enum(["present","absent","legacy"]),rows:z.array(z.object({name:z.string().max(255),checksum:z.string().regex(/^[a-f0-9]{64}$/).nullable()}).strict()).max(2000)}).strict().parse(await call("rpc/console_job_migration_ledger",{method:"POST",body:"{}"},512*1024));}catch(error){throw error instanceof JobError?error:new JobError("malformed");}
    },
  };
  return store;
}

export const CONSOLE_JOB_HISTORY = "Terminal diagnostics and checks are retained for 30 days; mutation, deployment, active and uncertain receipts are not automatically pruned.";
