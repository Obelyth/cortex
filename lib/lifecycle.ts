/**
 * lifecycle — what the brain does with a note that stopped being used.
 *
 * THE MACHINERY WAS BUILT AND NEVER CALLED. note_scores has bucketed every note hot/warm/cold
 * since 2026-08-06, and `propose_deletions(min_age_days)` has been able to nominate the ones that
 * are cold AND never read AND unpinned AND untouched for six months since the same day. A grep
 * across lib/, app/, ops/, scripts/ and .github/ on 2026-09-04 found no caller for that function
 * and exactly one consumer of the table it fills: a number on a console card. So the corpus grew
 * for a month with a retirement path that nothing walked.
 *
 * PROPOSING IS NOT DELETING, and this module keeps that line. propose_deletions inserts rows with
 * a reason and stops; the decision column stays null until a person fills it. Nothing here removes
 * a note, and nothing here should ever learn how — the brain's own doctrine is that history is
 * corrected in place rather than rewritten, and a retirement is a correction someone has to sign.
 */
export type Candidate = { path: string; reason: string };
export type TempCount = { temperature: string; n: number };

/** The one-screen summary a routine can act on, or a person can read in five seconds. */
export function summariseLifecycle(temps: TempCount[], candidates: Candidate[]): string {
  const total = temps.reduce((a, t) => a + t.n, 0);
  const of = (name: string) => temps.find((t) => t.temperature === name)?.n ?? 0;
  const pct = (n: number) => (total ? `${((n / total) * 100).toFixed(0)}%` : "0%");
  const lines = [
    `corpus ${total} scored notes — hot ${of("hot")} (${pct(of("hot"))}) · warm ${of("warm")} (${pct(of("warm"))}) · cold ${of("cold")} (${pct(of("cold"))})`,
    `retirement candidates awaiting a decision: ${candidates.length}`,
  ];
  // The reasons carry the age, which is the only part a reader needs to judge the batch. Listed
  // in full rather than counted: a number invites a rubber stamp, a list invites a look.
  for (const c of [...candidates].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    lines.push(`  ${c.path} — ${c.reason}`);
  }
  if (!candidates.length) {
    lines.push("  (none — a note that was read even once is never nominated)");
  }
  return lines.join("\n");
}
