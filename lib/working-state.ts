import { z } from "zod";
import { bubbleStore, BubbleManagementError } from "./bubble";
import { redact } from "./redact";
import { workingCommand, workingCursor, workingItem, workingPage, workingQuery, WORKING_MESSAGES, type WorkingCommand, type WorkingErrorCode, type WorkingItem } from "./working-state-contract";

export class WorkingStateError extends Error {
  constructor(readonly code: WorkingErrorCode, readonly current?: WorkingItem) { super(WORKING_MESSAGES[code]); }
}
const record = workingItem.omit({ touchedAt: true, bodyRedacted: true, projectRedacted: true }).extend({ touched_at: z.string() });
function dto(value: unknown): WorkingItem {
  const r = record.parse(value);
  const body = redact(r.body); const project = redact(r.project);
  return workingItem.parse({ id:r.id,version:r.version,kind:r.kind,project,body,status:r.status,touchedAt:r.touched_at,bodyRedacted:body!==r.body,projectRedacted:project!==r.project });
}
function store() {
  const s = bubbleStore();
  if (!s) throw new WorkingStateError("unavailable");
  if (!s.manage || !s.change) throw new WorkingStateError("migration_required");
  return { manage:s.manage, change:s.change };
}
function failure(e: unknown, writing: boolean): never {
  if (e instanceof WorkingStateError) throw e;
  if (e instanceof BubbleManagementError && e.migrationRequired) throw new WorkingStateError("migration_required");
  throw new WorkingStateError(writing ? "uncertain" : "unavailable");
}
export async function changeWorkingState(input: unknown) {
  const parsed = workingCommand.safeParse(input);
  if (!parsed.success) throw new WorkingStateError("invalid");
  const command: WorkingCommand = parsed.data;
  try {
    const raw = z.object({ outcome:z.enum(["saved","conflict","missing","key_conflict","invalid"]),item:z.unknown().optional() }).parse(await store().change(command));
    if (raw.outcome !== "saved") throw new WorkingStateError(raw.outcome, raw.outcome === "conflict" ? dto(raw.item) : undefined);
    const item = dto(raw.item);
    if (command.action !== "add" && (item.id !== command.id || item.version <= command.version || (command.action === "drop" && item.status !== "aged"))) throw new Error("invalid result");
    return { outcome:"saved" as const,item };
  } catch(e) { failure(e,true); }
}
export async function readWorkingState(input: unknown) {
  const parsed = workingQuery.safeParse(input);
  if (!parsed.success) throw new WorkingStateError("invalid");
  try {
    const raw = z.object({items:z.array(z.unknown()).max(20),total:z.number().int().nonnegative(),swept:z.number().int().nonnegative(),next:workingCursor.nullable()}).parse(await store().manage(parsed.data));
    const page = workingPage.parse({...raw,items:raw.items.map(dto)});
    if (page.total < page.items.length || page.items.some(i=>i.status!=="open")) throw new Error("invalid page");
    return page;
  } catch(e) { failure(e,false); }
}
export async function readWorkingItem(id: number) {
  if (!Number.isSafeInteger(id) || id<1) throw new WorkingStateError("invalid");
  try { const raw=await store().manage({id}); if(raw===null) throw new WorkingStateError("missing"); return dto(raw); }
  catch(e) { failure(e,false); }
}
