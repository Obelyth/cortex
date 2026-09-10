import { workingCommand, workingItem, workingPage, workingSaved, WORKING_MESSAGES, type WorkingCommand, type WorkingCursor, type WorkingErrorCode, type WorkingItem } from "./working-state-contract";
import type { BubbleKind } from "./bubble";

export class WorkingClientError extends Error {
  constructor(readonly code: WorkingErrorCode, readonly current?: WorkingItem) {super(WORKING_MESSAGES[code]);}
}
export function workingStateUrl(pathname: string): string {return `${pathname.replace(/\/+$/,"").replace(/\/(ask|overview)$/,"")}/working-state`;}
async function response(url: string, init: RequestInit, writing: boolean): Promise<unknown> {
  try {
    const res=await fetch(url,{...init,cache:"no-store",signal:AbortSignal.timeout(12_000)});
    const raw=await res.json();
    if(!res.ok) {
      const code=raw && typeof raw.code==="string" && Object.hasOwn(WORKING_MESSAGES,raw.code)?raw.code as WorkingErrorCode:writing?"uncertain":"unavailable";
      const current=workingItem.safeParse(raw?.current);
      throw new WorkingClientError(code,current.success?current.data:undefined);
    }
    return raw;
  }catch(e){if(e instanceof WorkingClientError)throw e;throw new WorkingClientError(writing?"uncertain":"unavailable");}
}
export async function requestWorkingChange(url:string,command:WorkingCommand) {
  const valid=workingCommand.safeParse(command);if(!valid.success)throw new WorkingClientError("invalid");
  const raw=await response(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(valid.data)},true);
  const saved=workingSaved.safeParse(raw);
  if(!saved.success || (command.action!=="add" && (saved.data.item.id!==command.id || saved.data.item.version<=command.version || (command.action==="drop" && saved.data.item.status!=="aged"))))throw new WorkingClientError("uncertain");
  return saved.data;
}
export async function readWorkingPage(url:string,project:string|null,before:WorkingCursor|null) {
  const q=new URLSearchParams();if(project!==null)q.set("project",project);
  if(before){q.set("before",before.touched_at);q.set("beforeId",String(before.id));}
  const raw=await response(`${url}?${q}`,{},false);const parsed=workingPage.safeParse(raw);
  if(!parsed.success || parsed.data.total<parsed.data.items.length || parsed.data.items.some(i=>i.status!=="open"))throw new WorkingClientError("unavailable");
  return parsed.data;
}
export async function readWorkingItem(url:string,id:number) {
  const raw=await response(`${url}?id=${id}`,{},false) as {item?:unknown};
  const parsed=workingItem.safeParse(raw?.item);if(!parsed.success || parsed.data.id!==id)throw new WorkingClientError("unavailable");return parsed.data;
}
export type WorkingDraft={kind:BubbleKind;project:string;body:string};
/** Redacted fields are preserved at the database unless replacement was chosen explicitly. */
export function editorCommand(draft:WorkingDraft,item:WorkingItem,replaceBody:boolean,replaceProject:boolean,maskedDraft={body:false,project:false}):WorkingCommand {
  return {action:"edit",id:item.id,version:item.version,kind:draft.kind,
    ...((!item.bodyRedacted&&!maskedDraft.body)||replaceBody?{body:draft.body}:{}),
    ...((!item.projectRedacted&&!maskedDraft.project)||replaceProject?{project:draft.project}:{}),
  };
}
