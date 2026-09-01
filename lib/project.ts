/**
 * project — the two pure helpers that decide "does this belong to that project".
 *
 * They lived in handoff.ts, which was fine while only the handoff bundle asked the question. The
 * boot call asks it too now (brain_context can scope its recent-activity and working-state to one
 * project, so cross-project material stops riding into an unrelated session), and brain.ts →
 * bubble.ts already form an import chain handoff sits above — so a shared low-level home is the
 * only one that does not draw a cycle. handoff.ts re-exports both for its existing callers.
 */

/** A project name as the bubble and the log tags use it: bare, lowercase. */
export function normaliseProject(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^projects\//, "")
    .replace(/\.md$/, "")
    .trim();
}

/**
 * Does an entry heading's tag text mention the project? Boundary-aware substring, so the tag
 * "cortex-learning" mentions cortex while "vortex" does not — the same match the log router and
 * the handoff bundle already use, kept in one place so the boot call and the handoff cannot
 * disagree about what an entry is about.
 */
export function mentionsProject(tagText: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(tagText);
}
