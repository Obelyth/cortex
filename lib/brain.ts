import type { BrainFile } from "./github";
import { getFile, listTree, putFile } from "./github";
import { isLive, loadCorpus } from "./corpus";
import { buildRouter, safeText, MAX_DESCRIPTION, type Temperature } from "./frontmatter";
import { mirrorStore } from "./mirror";
import { logDigest } from "./digest";
import { logNoteAccess } from "./access";
import { bubbleStore, renderBubble } from "./bubble";
import { redact } from "./redact";

// Write policy: what a caller may create or overwrite. Deliberately narrow.
const PATH_RE =
  /^(profile\.md|INDEX\.md|(projects|notes|log)\/[A-Za-z0-9._-]+\.md|archive\/[A-Za-z0-9._/-]+\.md)$/;


export function validatePath(path: string): void {
  if (!PATH_RE.test(path) || path.includes("..")) {
    throw new Error(
      `Invalid brain path: ${path}. Allowed: profile.md, INDEX.md, projects/*.md, notes/*.md, log/*.md, archive/**.md`
    );
  }
}

export function todayStamp(): { date: string; time: string } {
  const tz = process.env.BRAIN_TZ ?? "America/Los_Angeles";
  const now = new Date();
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  return { date, time };
}

/**
 * The last `n` local dates, newest first.
 *
 * Exported because the DST behaviour is the interesting part and deserves to be tested directly
 * rather than inferred from which files something happened to fetch. Arithmetic is done in UTC on
 * a date that was *formatted* in BRAIN_TZ, so the day boundary follows the operator's clock while the
 * subtraction cannot be bitten by a 23- or 25-hour local day.
 */
export function lastNDates(n: number): string[] {
  const tz = process.env.BRAIN_TZ ?? "America/Los_Angeles";
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, m, d] = fmt.format(new Date()).split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d - i));
    out.push(
      `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`
    );
  }
  return out;
}

/** Days of log the boot call considers at all. */
const RECENT_DAYS = 7;

/**
 * Bytes of verbatim log the boot call will spend, newest first.
 *
 * A BUDGET, NOT A DAY COUNT, and the difference is not academic. The first cut of this expanded
 * "the two most recent days" — which on the live brain is up to 24 KB for a single day, because a
 * groundskeeper night is an essay. Two such days is ~9k tokens and the boot call had barely
 * improved on the raw dump it replaced. A day count bounds how MANY things you read; it does not
 * bound how much you read, and the thing that costs is the second one.
 *
 * So days are expanded newest-first while the budget holds, and every day that does not fit gets
 * its derived digest line instead. A quiet week shows several days in full; one enormous day shows
 * as a digest and says so. Either way the boot call has a ceiling.
 */
const RECENT_BUDGET_BYTES = 8_000;

/**
 * The boot call.
 *
 * WHAT CHANGED AND WHY. This used to return `profile.md` + `INDEX.md` + seven raw day-logs. On the
 * live brain that measured ~11.8k tokens — and a floor, not a ceiling, since only four of the seven
 * days existed. It also grew every single day, because the logs are the fastest-growing thing in
 * the corpus, so the price of booting rose whether or not the new material was relevant.
 *
 * Worse, the two big pieces were the wrong shape. `INDEX.md` was 83 bare paths that describe
 * nothing, so a reader could not tell what any note held without opening it. And seven days of
 * verbatim log answered "what has been written down lately" when the question a boot call actually
 * asks is "what were we doing".
 *
 * Now: profile in full, the router (paths WITH descriptions), the two most recent days that exist
 * in full, and every older day as one derived line. Nothing became unreachable — an elided day is
 * named, digested, and one `brain_read` away, which is stated in the output rather than left for
 * the reader to work out.
 *
 * ONE COMMIT, ONE SNAPSHOT. It now reads the corpus tarball instead of making nine Contents API
 * calls. That is fewer requests, and more importantly every part of the reply comes from the same
 * commit — the old version could interleave a profile from one commit with a log from the next.
 * The SHA is printed, so a reader can always tell what it was handed.
 */
export async function getContext(): Promise<string> {
  // The corpus and the bubble have no data dependency, and both sit on the boot path — the one
  // call every session on every surface pays. Serial awaits once stacked their worst cases into
  // a ~40s stall; now the slower of the two is the ceiling.
  const store = bubbleStore();
  const scoreStore = mirrorStore();
  const [corpus, bubbleOutcome, scores] = await Promise.all([
    loadCorpus(),
    store
      ? store.open().then(
          (read) => ({ state: "read" as const, read }),
          (e) => {
            console.error(`[bubble] boot read failed, expanding logs instead: ${String(e)}`);
            return { state: "failed" as const };
          }
        )
      : Promise.resolve({ state: "absent" as const }),
    // Temperatures ride the same parallel fetch as everything else on the boot path. Null means
    // "no scoring available", and the router then renders every row — the pre-phase-4 behaviour.
    // scores() already swallows its own failures, but this sits inside a Promise.all on the boot
    // path: one unhandled rejection here would take down the whole call. Belt and braces, matching
    // the bubble fetch three lines above.
    scoreStore ? scoreStore.scores().catch(() => null) : Promise.resolve(null),
  ]);

  const temps = new Map<string, { temperature: Temperature }>();
  for (const s of scores ?? []) temps.set(s.path, { temperature: s.temperature });

  const parts: string[] = [];
  parts.push("# PROFILE\n\n" + (corpus.files.get("profile.md") ?? "(profile.md missing)"));
  parts.push(buildRouter(corpus.files, temps));

  // THE BUBBLE REPLACES THE RAW LOG DUMP (spec §7.3) — when it has anything to say. Working
  // state answers "what were we doing"; seven days of verbatim log was always a poor proxy for
  // that question. But a bubble with nothing in it must not make boot LESS informative than
  // phase 2 did, so an empty (or absent, on a zero-env deploy, or failing) bubble degrades to
  // the old behaviour: expand recent days under the byte budget. One question, best available
  // answerer.
  const bubbleSection = bubbleOutcome.state === "read" ? renderBubble(bubbleOutcome.read) : "";

  const present = lastNDates(RECENT_DAYS).filter((d) => corpus.files.has(`log/${d}.md`));
  const expand: string[] = [];
  const elide: string[] = [];

  if (bubbleSection) {
    parts.push(bubbleSection);
    // Every day rides as a derived digest line — one brain_read away, never verbatim at boot.
    elide.push(...present);
  } else {
    // Only days that exist are candidates, so a quiet weekend does not spend the budget deciding
    // about absent files instead of the days that actually have something in them.
    let spent = 0;
    for (const d of present) {
      const text = corpus.files.get(`log/${d}.md`)!;
      // A day that would overflow is digested, and the walk CONTINUES — one enormous Tuesday must
      // not hide the three short days behind it, which a `break` here would do.
      if (spent + text.length <= RECENT_BUDGET_BYTES) {
        expand.push(d);
        spent += text.length;
      } else {
        elide.push(d);
      }
    }
  }

  if (present.length > 0) {
    const blocks = [
      ...expand.map((d) => `--- log/${d}.md ---\n${corpus.files.get(`log/${d}.md`)}`),
      ...elide.map((d) => {
        const { description } = logDigest(corpus.files.get(`log/${d}.md`)!);
        // Through safeText like every other note-derived string that reaches a caller. This was the
        // one render site that interpolated raw, so the line the budget uses to REPLACE an
        // oversized day had no ceiling of its own.
        return `--- log/${d}.md · ${safeText(description, MAX_DESCRIPTION)} · not expanded — brain_read log/${d}.md for the full day ---`;
      }),
    ];
    parts.push(`# RECENT (last ${RECENT_DAYS} days)\n\n${blocks.join("\n\n")}`);
  }

  logNoteAccess(["profile.md", ...expand.map((d) => `log/${d}.md`)], "brain_context", "boot");

  const body = parts.join("\n\n");
  return (
    `${body}\n\n---\n` +
    `brain @${corpus.sha.slice(0, 12)} · ${corpus.files.size} notes routed · ` +
    `${expand.length} day${expand.length === 1 ? "" : "s"} expanded, ${elide.length} digested · ` +
    (bubbleSection ? "bubble live · " : bubbleOutcome.state === "failed" ? "bubble unavailable — brain_bubble may still work · " : "") +
    `~${Math.round(body.length / 4)} tokens. Open any note with brain_read, or brain_corpus for a set.`
  );
}


const READ_CHUNK_SIZE = 8;


export async function readNote(path: string): Promise<string> {
  validatePath(path);
  const f = await getFile(path);
  if (!f) throw new Error(`Note not found: ${path}`);
  // Redaction is announced, not silent: a reader who sees `<redacted>` and no explanation
  // cannot tell whether the note literally says that. Announcing it also tells the operator a
  // credential is sitting in his notes, which is the thing he actually needs to know.
  const safe = redact(f.content);
  return safe === f.content
    ? safe
    : `${safe}\n\n---\n(NOTE: credential-shaped values in this file were redacted on the way out. Read the file directly if you need the real value.)`;
}

function joinAppend(existing: string | undefined, addition: string, whenMissing: string): string {
  return existing ? existing.replace(/\s+$/, "") + "\n\n" + addition : whenMissing;
}

async function regenerateBareIndex(): Promise<void> {
  const paths = (await listTree()).filter((p) => p !== "INDEX.md");
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const dir = p.includes("/") ? p.split("/")[0] : "Root";
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(p);
  }
  const order = ["Root", "projects", "notes", "log", "archive"];
  const body = order
    .filter((d) => groups.has(d))
    .map((d) => `## ${d}\n` + groups.get(d)!.sort().map((p) => `- ${p}`).join("\n"))
    .join("\n\n");
  const content = `# INDEX\n\n_Auto-generated by cortex on every write — do not edit by hand._\n\n${body}`;
  const existing = await getFile("INDEX.md");
  if (existing?.content === content) return; // unchanged tree → no commit churn
  await putFile("INDEX.md", content, "brain: regenerate index", existing?.sha);
}


// The bare INDEX.md path listing is the only generated catalogue left. It exists for
// brain_context, which ships it as a map of what the brain contains; nothing ranks it.
// Reported through the indexWarning channel rather than failing the write — the note is
// already committed by then, and losing the write to save the catalogue is backwards.
async function regenerateIndexes(): Promise<void> {
  await regenerateBareIndex();
}

/**
 * Surgical replacement inside a note: `find` must occur EXACTLY once, and the edit is refused
 * otherwise — loudly, with the count, so the caller quotes more context instead of guessing.
 *
 * This mode exists because its absence was rotting the brain. Without it, every correction was
 * an append: the new truth landed at the bottom of the file while the stale claim stayed
 * standing above it, verbatim, still quotable — the exact shape the hard-verify landmine test
 * kept catching in long-lived project notes. replace-the-whole-note was the only alternative, and
 * nobody rewrites 18,000 tokens to fix one line. Now the one line is the operation.
 *
 * Spliced by index, not String.replace: a replacement containing `$&` or `$'` would be
 * interpreted as a substitution pattern, and a correction that quotes shell or regex is not
 * an edge case in this corpus — it is the median note.
 */
function applyEdit(text: string, find: string, replacement: string, path: string): string {
  const n = text.split(find).length - 1;
  if (n === 0) {
    throw new Error(
      `edit failed: the text to replace was not found in ${path} — read the note first and copy the passage exactly, whitespace included`
    );
  }
  if (n > 1) {
    throw new Error(
      `edit failed: the text to replace appears ${n} times in ${path} — include more surrounding context so it matches exactly once`
    );
  }
  const i = text.indexOf(find);
  return text.slice(0, i) + replacement + text.slice(i + find.length);
}

export async function writeNote(
  path: string,
  content: string,
  mode: "create" | "replace" | "append" | "edit",
  find?: string
): Promise<{ path: string; commitSha: string; indexWarning?: string }> {
  validatePath(path);
  const existing = await getFile(path);
  if (mode === "create" && existing) {
    throw new Error(`${path} already exists — use replace or append.`);
  }
  if ((mode === "replace" || mode === "edit") && !existing) {
    throw new Error(`${path} does not exist — use create.`);
  }
  if (mode === "edit" && !find) {
    throw new Error(`edit needs \`find\` — the exact text the new content replaces.`);
  }
  const finalContent =
    mode === "append"
      ? joinAppend(existing?.content, content, content)
      : mode === "edit"
        ? applyEdit(existing!.content, find!, content, path)
        : content;
  const { commitSha } = await putFile(
    path,
    finalContent,
    `brain: ${mode} ${path}`,
    existing?.sha,
    // On a sha-conflict retry the edit re-applies against the FRESH content — and re-runs the
    // uniqueness checks, because the concurrent write may have removed or duplicated the target.
    // Failing the retry loudly beats splicing into a file that no longer says what we read.
    mode === "append"
      ? (fresh) => joinAppend(fresh?.content, content, content)
      : mode === "edit"
        ? (fresh) => {
            if (!fresh) throw new Error(`edit failed: ${path} disappeared mid-write`);
            return applyEdit(fresh.content, find!, content, path);
          }
        : undefined
  );
  let indexWarning: string | undefined;
  try {
    await regenerateIndexes();
  } catch (e) {
    indexWarning = e instanceof Error ? e.message : String(e);
  }
  return { path, commitSha, indexWarning };
}


export async function capture(
  text: string,
  tags?: string[]
): Promise<{ path: string; commitSha: string; indexWarning?: string }> {
  const { date, time } = todayStamp();
  const path = `log/${date}.md`;
  const heading = tags && tags.length > 0 ? `## ${time} · ${tags.join(", ")}` : `## ${time}`;
  const entry = `${heading}\n\n${text}\n`;
  const existing = await getFile(path);
  const whenMissing = `# Log ${date}\n\n${entry}`;
  const finalContent = joinAppend(existing?.content, entry, whenMissing);
  const { commitSha } = await putFile(
    path,
    finalContent,
    `brain: capture ${date} ${time}`,
    existing?.sha,
    (fresh) => joinAppend(fresh?.content, entry, whenMissing)
  );
  let indexWarning: string | undefined;
  try {
    await regenerateIndexes();
  } catch (e) {
    indexWarning = e instanceof Error ? e.message : String(e);
  }
  return { path, commitSha, indexWarning };
}
