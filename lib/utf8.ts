/** Browser-compatible UTF-8 accounting. Never use JS string length for byte ceilings. */
const pointBytes=(point:number)=>point<=0x7f?1:point<=0x7ff?2:point<=0xffff?3:4;

export function utf8Bytes(text: string): number {
  let bytes=0;for(const point of text)bytes+=pointBytes(point.codePointAt(0)!);return bytes;
}

/** Prefix bounded in UTF-16 source units, preserving existing field ceilings and pairs. */
export function utf16Prefix(text:string,maxUnits:number):string {
  let end=Math.max(0,Math.floor(maxUnits));
  if(end>=text.length)return text;
  if(end>0&&text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff&&text.charCodeAt(end)>=0xdc00&&text.charCodeAt(end)<=0xdfff)end--;
  return text.slice(0,end);
}

/** Longest code-point-aligned prefix whose UTF-8 representation fits `maxBytes`. */
export function utf8Prefix(text: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes)) return text;
  if (maxBytes <= 0) return "";
  let out = "";
  let spent = 0;
  for (const point of text) {
    const bytes = pointBytes(point.codePointAt(0)!);
    if (spent + bytes > maxBytes) break;
    out += point;
    spent += bytes;
  }
  return out;
}

/** Longest code-point-aligned suffix whose UTF-8 representation fits `maxBytes`. */
export function utf8Suffix(text: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes)) return text;
  if (maxBytes <= 0) return "";
  let start = text.length;
  let spent = 0;
  while (start > 0) {
    let previous=start-1;
    const last=text.charCodeAt(previous);
    if(last>=0xdc00&&last<=0xdfff&&previous>0&&text.charCodeAt(previous-1)>=0xd800&&text.charCodeAt(previous-1)<=0xdbff)previous--;
    const bytes = pointBytes(text.codePointAt(previous)!);
    if (spent + bytes > maxBytes) break;
    spent += bytes;
    start=previous;
  }
  return text.slice(start);
}
