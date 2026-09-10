import { z } from "zod";

export type OperationId =
  | "diagnostics" | "checks" | "migrations.check" | "migrations.apply"
  | "deploy.preview" | "deploy.production";
export type JobState = "queued" | "running" | "succeeded" | "failed" | "uncertain";
export interface JobCheck { name: string; state: "passed" | "failed" | "skipped" | "unavailable"; detail: string }
export interface ConsoleJob {
  id: string; operation: OperationId; state: JobState; requestedAt: string; updatedAt: string;
  sourceSha: string | null; target: string; checks: JobCheck[]; summary: string; providerId: string | null;
}
/** History rows deliberately state only the check count. Exact checks are fetched on open. */
export type ConsoleJobListItem = Omit<ConsoleJob, "checks"> & { checkCount: number };

export const operationIdSchema = z.enum(["diagnostics", "checks", "migrations.check", "migrations.apply", "deploy.preview", "deploy.production"]);
export const jobCheckSchema = z.object({ name: z.string().min(1).max(120), state: z.enum(["passed", "failed", "skipped", "unavailable"]), detail: z.string().max(500) }).strict();
const base = z.object({ id: z.uuidv4(), operation: operationIdSchema, state: z.enum(["queued", "running", "succeeded", "failed", "uncertain"]), requestedAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }), sourceSha: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(), target: z.string().min(1).max(160), summary: z.string().max(1000), providerId: z.string().max(256).nullable() }).strict();
export const consoleJobSchema = base.extend({ checks: z.array(jobCheckSchema).max(64) });
export const consoleJobListItemSchema = base.extend({ checkCount: z.number().int().min(0).max(64) });
export const consoleJobPageSchema = z.object({ items: z.array(consoleJobListItemSchema).max(25), nextCursor: z.string().max(256).nullable(), historyPolicy: z.string().max(300) }).strict();
export const jobPreparationSchema=z.object({operation:operationIdSchema,requestKey:z.uuidv4(),sourceSha:z.string().regex(/^[a-f0-9]{40}$/),target:z.string().max(160),pendingDigest:z.string().regex(/^[a-f0-9]{64}$/).nullable(),expiresAt:z.iso.datetime(),intent:z.string().max(4096),warning:z.string().max(500)}).strict();
export type JobPreparation=z.infer<typeof jobPreparationSchema>;
export const jobOutputSchema=z.object({available:z.boolean(),text:z.string().max(16384),clipped:z.boolean()}).strict();
export const providerCatalogSchema=z.object({providers:z.array(z.object({operation:operationIdSchema,configured:z.boolean(),detail:z.string().max(500),setupRequirement:z.enum(["source","github","vercel","database"]).optional()}).strict()).max(5)}).strict();
const acknowledgementSchema = z.object({ acknowledged: z.literal(true), job: consoleJobSchema }).strict();
const recoverySchema = z.object({ markedUncertain: z.literal(true), job: consoleJobSchema }).strict();

export function parseJobAcknowledgement(value: unknown, expected: ConsoleJob): ConsoleJob | null {
  const parsed = acknowledgementSchema.safeParse(value);
  if (!parsed.success) return null;
  const received = parsed.data.job;
  return received.id === expected.id
    && received.operation === expected.operation
    && received.target === expected.target
    && received.state === expected.state
    ? received
    : null;
}

export function parseJobRecovery(value: unknown, expected: ConsoleJob): ConsoleJob | null {
  const parsed = recoverySchema.safeParse(value);
  if (!parsed.success) return null;
  const received = parsed.data.job;
  // Any queued or running receipt can be fenced: a queued diagnostic whose request never claimed
  // it has no other exit (console_job_mark_uncertain, migration 20260909041000).
  return received.id === expected.id
    && received.operation === expected.operation
    && received.target === expected.target
    && (expected.state === "running" || expected.state === "queued")
    && received.state === "uncertain"
    ? received
    : null;
}
