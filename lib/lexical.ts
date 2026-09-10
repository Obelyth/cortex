/** CPU-only lexical preparation. Cache bounds govern retained work, never search eligibility. */
export const K1 = 1.5;
export const B = 1.0;

const SYMBOLIC: Array<[RegExp, string]> = [
  [/\bc\+\+/gi, " cplusplus "], [/\bc#/gi, " csharp "], [/\bf#/gi, " fsharp "],
  [/\bobjective-c\b/gi, " objectivec "], [/\.net\b/gi, " dotnet "],
];
const UNSPACED_SCRIPTS = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}";
const UNSPACED = new RegExp(`[${UNSPACED_SCRIPTS}]`, "u");
const SUBRUNS = new RegExp(`[${UNSPACED_SCRIPTS}][${UNSPACED_SCRIPTS}\\p{M}]*|[^${UNSPACED_SCRIPTS}]+`, "gu");
let segmenter: Intl.Segmenter | undefined;

export function tokenize(text: string): string[] {
  let t = text.toLowerCase();
  for (const [pattern, replacement] of SYMBOLIC) t = t.replace(pattern, replacement);
  // Preserve the original ASCII/symbolic path exactly, including single-letter terms.
  if (!/[^\x00-\x7f]/.test(t)) return t.replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean);
  const tokens: string[] = [];
  for (const match of t.normalize("NFC").matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)) {
    const word = match[0];
    if (!UNSPACED.test(word)) { tokens.push(word); continue; }
    for (const submatch of word.matchAll(SUBRUNS)) {
      const run = submatch[0];
      if (!UNSPACED.test(run)) { tokens.push(run); continue; }
      // Bound a native call without cutting across its word boundaries. An ordinary long
      // ASCII/Arabic span beside one CJK character does not consume this subrun budget.
      if (run.length > 65536) throw new Error("Unicode segmentation run exceeds 65536 UTF-16 units");
      if (typeof Intl.Segmenter !== "function") throw new Error("Unicode word segmentation unavailable in this runtime");
      segmenter ??= new Intl.Segmenter("und", { granularity: "word" });
      for (const part of segmenter.segment(run)) if (part.isWordLike) tokens.push(part.segment);
    }
  }
  return tokens;
}

interface Document { body: string; length: number; tf: ReadonlyMap<string, number> }
export interface LexicalScore { path: string; score: number; terms: string[] }
export interface PreparedLexical { score(question: string): LexicalScore[] }

class Index implements PreparedLexical {
  #documents = new Map<string, Document>();
  #df = new Map<string, number>();
  #average: number;
  readonly units: number;
  readonly termEntries: number;
  readonly records: number;

  constructor(files: Map<string, string>, previous?: Index) {
    let length = 0, units = 0, termEntries = 0;
    for (const [path, body] of files) {
      let document = previous ? previous.#documents.get(path) : undefined;
      if (!document || document.body !== body) {
        const tf = new Map<string, number>();
        let count = 0;
        for (const term of tokenize(body)) { tf.set(term, (tf.get(term) ?? 0) + 1); count++; }
        document = { body, length: count, tf };
      }
      this.#documents.set(path, document);
      for (const term of document.tf.keys()) {
        units += term.length; // retained document-term key
        if (!this.#df.has(term)) units += term.length; // retained view-wide frequency key
        this.#df.set(term, (this.#df.get(term) ?? 0) + 1);
      }
      length += document.length; units += path.length + body.length; termEntries += document.tf.size;
    }
    this.records = files.size; this.units = units; this.termEntries = termEntries;
    this.#average = length / (files.size || 1) || 1;
    Object.freeze(this);
  }

  matches(files: Map<string, string>): boolean {
    if (files.size !== this.#documents.size) return false;
    // Mutable Maps have no revision. Compare primitive values and iteration order without
    // tokenizing: stable score sorting preserves that order for comparator-equal paths.
    const previous = this.#documents.entries();
    for (const [path, body] of files) {
      const document = previous.next().value;
      if (!document || document[0] !== path || document[1].body !== body) return false;
    }
    return true;
  }

  score(question: string): LexicalScore[] {
    const terms = new Set(tokenize(question)), n = this.#documents.size || 1;
    const out: LexicalScore[] = [];
    for (const [path, document] of this.#documents) {
      let score = 0;
      const matched: string[] = [];
      for (const term of terms) {
        const f = document.tf.get(term) ?? 0;
        if (!f) continue;
        const d = this.#df.get(term) ?? 0;
        const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
        score += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * document.length) / this.#average));
        matched.push(term);
      }
      if (score > 0) out.push({ path, score, terms: matched });
    }
    out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return out;
  }
}

interface Entry {
  source: WeakRef<Map<string, string>>;
  scopeKey?: string;
  generation?: string;
  view?: Map<string, string>;
  index?: Index;
}
const entries: Entry[] = [];
const MAX_VIEWS = 4, MAX_RECORDS = 20_000, MAX_UNITS = 64 * 1024 * 1024, MAX_TERMS = 1_000_000;

function cost(entry: Entry) {
  let units = (entry.scopeKey?.length ?? 0) + (entry.generation?.length ?? 0) + (entry.index?.units ?? 0);
  // The auxiliary scoped Map is counted too, conservatively even when strings are shared
  // with prepared records. Weak source keys cannot keep hidden/full generations alive.
  if (entry.view) for (const [path, body] of entry.view) units += path.length + body.length;
  return { units, records: (entry.view?.size ?? 0) + (entry.index?.records ?? 0), terms: entry.index?.termEntries ?? 0 };
}
function retain(entry: Entry): void {
  const existing = entries.indexOf(entry);
  if (existing !== -1) entries.splice(existing, 1);
  const own = cost(entry);
  if (own.units > MAX_UNITS || own.records > MAX_RECORDS || own.terms > MAX_TERMS) return;
  entries.push(entry);
  for (;;) {
    const total = entries.reduce((sum, item) => {
      const c = cost(item); return { units: sum.units + c.units, records: sum.records + c.records, terms: sum.terms + c.terms };
    }, { units: 0, records: 0, terms: 0 });
    if (entries.length <= MAX_VIEWS && total.units <= MAX_UNITS && total.records <= MAX_RECORDS && total.terms <= MAX_TERMS) return;
    entries.shift();
  }
}
function forgetDeadSources(): void {
  for (let i = entries.length - 1; i >= 0; i--) if (!entries[i].source.deref()) entries.splice(i, 1);
}

/** Immutable prepared handle; scoring returns fresh caller-owned arrays on every invocation. */
export function prepareLexical(files: Map<string, string>): PreparedLexical {
  forgetDeadSources();
  const entry = entries.find(e => e.view === files || (!e.scopeKey && e.source.deref() === files)) ?? { source: new WeakRef(files) };
  if (!entry.index?.matches(files)) entry.index = new Index(files, entry.index);
  retain(entry);
  return entry.index;
}

/** Authorization filtering happens before preparation. Same generation/scope gets a stable
 * visible Map only after checking every currently visible path/body in order. Hidden bodies are not
 * compared, prepared, retained as keys, or included in document frequency. */
export function scopedLexicalFiles(source: Map<string, string>, scope: readonly string[], generation: string): Map<string, string> {
  forgetDeadSources();
  const scopeKey = JSON.stringify(scope);
  const entry = entries.find(e => e.source.deref() === source && e.scopeKey === scopeKey && e.generation === generation);
  const files = new Map<string, string>();
  for (const [path, body] of source) if (scope.some(s => path === s || (s.endsWith("/") && path.startsWith(s)))) files.set(path, body);
  if (entry?.view && files.size === entry.view.size) {
    const previous = entry.view.entries();
    let matches = true;
    for (const [path, body] of files) {
      const document = previous.next().value;
      if (!document || document[0] !== path || document[1] !== body) { matches = false; break; }
    }
    if (matches) { retain(entry); return entry.view; }
  }
  const next: Entry = { source: new WeakRef(source), scopeKey, generation, view: files };
  if (entry) entries.splice(entries.indexOf(entry), 1);
  retain(next);
  return files;
}
