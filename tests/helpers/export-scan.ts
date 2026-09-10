export type SourceHit = { file: string; line: number; origin: string };

// Decode literal string escapes without joining separately encoded lines.
export function unescaped(text: string): string {
  const short: Record<string, string> = { '"': '"', "'": "'", "`": "`", $: "$", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
  return text.replace(/\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(["'`$\\/bfnrt]))/g, (_, hex4: string | undefined, hex2: string | undefined, key: string | undefined) => {
    const value = hex4 ? String.fromCharCode(parseInt(hex4, 16)) : hex2 ? String.fromCharCode(parseInt(hex2, 16)) : short[key!];
    return value === "\n" ? "\0" : value;
  });
}

// Hash only short prefixes, then confirm every candidate with startsWith.
// Collisions add work, never a false result. Cost follows source size rather
// than source size multiplied by the number of private lines.
export function substringHits(sources: Array<[string, string]>, patterns: Iterable<[string, string]>): SourceHit[] {
  const entries = [...patterns];
  if (!entries.length) return [];
  const width = Math.min(...entries.map(([pattern]) => pattern.length));
  if (!width) throw new Error("empty pattern reached export scanner");
  const base = 0x01000193;
  const mask = (1 << 20) - 1;
  const maybe = new Uint8Array(mask + 1);
  const hash = (text: string) => { let h = 0; for (let i = 0; i < width; i++) h = (Math.imul(h, base) + text.charCodeAt(i)) | 0; return h; };
  let leaving = 1;
  for (let i = 1; i < width; i++) leaving = Math.imul(leaving, base);
  const buckets = new Map<number, Array<[string, string]>>();
  for (const entry of entries) {
    const h = hash(entry[0]);
    const bucket = buckets.get(h);
    if (bucket) bucket.push(entry); else buckets.set(h, [entry]);
    maybe[h & mask] = 1;
  }
  const hits: SourceHit[] = [];
  for (const [file, source] of sources) {
    const found = new Set<string>();
    const decoded = unescaped(source);
    for (const text of decoded === source ? [source] : [source, decoded]) {
      if (text.length < width) continue;
      let h = hash(text);
      for (let i = 0; ; i++) {
        if (maybe[h & mask]) for (const [pattern, origin] of buckets.get(h) ?? []) {
          if (found.has(pattern) || !text.startsWith(pattern, i)) continue;
          found.add(pattern);
          hits.push({ file, line: text.slice(0, i).split("\n").length, origin });
        }
        const arriving = i + width;
        if (arriving >= text.length) break;
        h = (h - Math.imul(text.charCodeAt(i), leaving)) | 0;
        h = (Math.imul(h, base) + text.charCodeAt(arriving)) | 0;
      }
    }
  }
  return hits;
}
