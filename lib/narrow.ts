/**
 * narrow — BM25 over full file text, used ONLY to pick candidates for the metered surface.
 *
 * This is deliberately not the old scorer. Two differences that matter:
 *
 *   1. It ranks the ACTUAL TEXT, not a generated 66-token summary line. Measured on the
 *      brain's 185-label eval, ranking summaries gets 55% top-1; ranking full text gets
 *      ~80%. The summary was the bug.
 *   2. It never decides the answer. It hands the reader a shortlist and the reader reads.
 *      Top-10 recall is ~99%, so the shortlist is a cost optimisation, not a gatekeeper —
 *      which is what the old path got wrong and what capped it at 55%.
 *
 * Why it exists at all: the free surfaces (shells, Claude Code) can afford the whole corpus.
 * The phone goes through a metered model, and a top-10 pack is ~5x smaller. Measured: Haiku
 * on the full corpus is unreliable (47-98% across runs); on a narrowed pack it recovers.
 */

const WORD = /[^a-z0-9]+/g;
const K1 = 1.2;
const B = 0.75;

/**
 * Names that are mostly punctuation. Stripping non-alphanumerics turns `C#` into `c`, `C++`
 * into `c` and `.NET` into `net`, so a question about them ranked on a bare letter — or on
 * nothing. Fold them to a spellable token first, on both the question and the documents, so
 * the two sides still meet.
 */
const SYMBOLIC: Array<[RegExp, string]> = [
  [/\bc\+\+/gi, " cplusplus "],
  [/\bc#/gi, " csharp "],
  [/\bf#/gi, " fsharp "],
  [/\bobjective-c\b/gi, " objectivec "],
  [/\.net\b/gi, " dotnet "],
];

export function tokenize(text: string): string[] {
  let t = text.toLowerCase();
  for (const [pat, repl] of SYMBOLIC) t = t.replace(pat, repl);
  // Single characters are KEPT. Dropping them lost the only distinguishing term in questions
  // like "is R installed" or "the H drive" — `r` appears standalone in 2 notes and was
  // unreachable. Keeping them is safe because BM25 already handles the noise: a letter that
  // occurs in every note gets an IDF near zero, so `a` and `i` cost nothing, while a genuinely
  // rare `r` scores high. Filtering by length was doing badly what IDF does well.
  return t.replace(WORD, " ").split(" ").filter((w) => w.length > 0);
}

export interface Scored {
  path: string;
  score: number;
}

/**
 * Rank files by BM25 against the question. Only files with a positive score are returned —
 * a zero score means no lexical signal at all, and padding a shortlist with them would make
 * "recall@k" measure nothing but "the file exists". (The Python eval had exactly that bug.)
 */
export function rank(files: Map<string, string>, question: string): Scored[] {
  const paths = [...files.keys()];
  const toks = new Map<string, string[]>();
  const df = new Map<string, number>();
  for (const p of paths) {
    const t = tokenize(files.get(p) ?? "");
    toks.set(p, t);
    for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const n = paths.length || 1;
  const avgdl = paths.reduce((a, p) => a + (toks.get(p)?.length ?? 0), 0) / n || 1;

  const tf = new Map<string, Map<string, number>>();
  for (const p of paths) {
    const m = new Map<string, number>();
    for (const w of toks.get(p) ?? []) m.set(w, (m.get(w) ?? 0) + 1);
    tf.set(p, m);
  }

  const kws = new Set(tokenize(question));
  const out: Scored[] = [];
  for (const p of paths) {
    const dl = toks.get(p)?.length ?? 0;
    let s = 0;
    for (const w of kws) {
      const f = tf.get(p)?.get(w) ?? 0;
      if (!f) continue;
      const d = df.get(w) ?? 0;
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      s += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * dl) / avgdl));
    }
    if (s > 0) out.push({ path: p, score: s });
  }
  // Deterministic: score desc, then path asc so equal scores never reorder between calls.
  out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return out;
}

/**
 * The candidate pack handed to a metered reader.
 *
 * When nothing scores, fall back to the k LARGEST notes rather than the whole corpus. The old
 * fallback shipped everything — measured on the real brain that is 77 notes and ~79.8k tokens
 * against a ~17k k=10 pack, a silent 4.5x on the bill, and it fired on inputs as ordinary as
 * `"???"` or an emoji, because those tokenize to nothing. A caller who typos should not be
 * charged for a full read they did not ask for; `full: true` is how you ask for that.
 */
export function narrow(files: Map<string, string>, question: string, k = 10): string[] {
  const top = rank(files, question).slice(0, k).map((s) => s.path);
  if (top.length) return top;
  return [...files.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, k)
    .map(([p]) => p);
}
