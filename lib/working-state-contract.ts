import { z } from "zod";
import { bubbleBody, bubbleKind, bubbleProject } from "./bubble-fields";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const body = bubbleBody.refine(s => s.trim().length > 0);
export const workingCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), requestKey: z.string().uuid(), kind: bubbleKind, body, project: bubbleProject }).strict(),
  z.object({ action: z.literal("edit"), id: positive, version: positive, kind: bubbleKind.optional(), body: body.optional(), project: bubbleProject.optional() }).strict()
    .refine(c => c.body !== undefined || c.project !== undefined || c.kind !== undefined),
  z.object({ action: z.literal("drop"), id: positive, version: positive }).strict(),
]);
export type WorkingCommand = z.infer<typeof workingCommand>;
const timestamp = z.string().max(50).refine(s => /^\d{4}-\d\d-\d\dT/.test(s) && Number.isFinite(Date.parse(s)));
export const workingCursor = z.object({ touched_at: timestamp, id: positive });
export type WorkingCursor = z.infer<typeof workingCursor>;
export const workingQuery = z.object({ project: bubbleProject.nullable(), before: workingCursor.nullable() });
export type WorkingQuery = z.infer<typeof workingQuery>;

/** Minimal browser DTO. Raw table metadata, request keys and digests never cross this boundary. */
export const workingItem = z.object({
  id: positive, version: positive, kind: bubbleKind, project: z.string().max(400), body: z.string().max(8000),
  status: z.enum(["open", "filed", "aged"]), touchedAt: timestamp,
  bodyRedacted: z.boolean(), projectRedacted: z.boolean(),
});
export type WorkingItem = z.infer<typeof workingItem>;
export const workingPage = z.object({ items: z.array(workingItem).max(20), total: z.number().int().nonnegative(), swept: z.number().int().nonnegative(), next: workingCursor.nullable() });
export type WorkingPage = z.infer<typeof workingPage>;
export const workingSaved = z.object({ outcome: z.literal("saved"), item: workingItem });
export const WORKING_MESSAGES = {
  invalid: "Check the project, kind and short notes (maximum 2,000 characters).",
  missing: "This working item is no longer available. Refresh working state; your draft is still here.",
  conflict: "This item changed, was filed, or aged out. Refresh the item before saving; your draft is still here.",
  key_conflict: "This save key already belongs to different notes. Resolve the earlier save before starting a new handoff.",
  migration_required: "Working-state editing requires the bubble_console_working_state database migration. Ask the operator to apply it; your draft is still here.",
  unavailable: "Working state is unavailable. Retry when the store returns; your draft is still here.",
  uncertain: "The save outcome could not be verified; it may already have completed. Retry the same add, or refresh an edited item before saving again. Your draft is still here.",
} as const;
export type WorkingErrorCode = keyof typeof WORKING_MESSAGES;
