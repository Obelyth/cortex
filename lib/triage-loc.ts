/**
 * triage-loc — the one place that maps a triage item's `loc` string back to the single note
 * path its console actions write to and its links open. The `loc` is display text with four
 * distinct producers, so the reverse lives here, tested, rather than inline in the client where
 * it could silently fall out of step with a shape health.ts or inbox.ts adds:
 *
 *   "path"            a stale-stamp item (health.ts) — the note alone.
 *   "path:line"       a credential-shaped or superseded-link item — the path, the line dropped.
 *   "path · L3, L7"   an unmarked retired-tool item (health.ts) — the path, the refs dropped.
 *   "path ↔ path"     a co-read or correction pair (inbox.ts) — the FIRST path, the canonical
 *                     one to open; the settle action names it in its own label so the operator
 *                     sees which end of the pair it settles.
 *
 * The " · L" shape was the one the parser did not know: it fell through to the ":line" branch,
 * found no trailing digits after the last colon, and returned "path · L3" verbatim — so "open
 * the note" filtered the ledger on a needle no path contains and landed on an empty screen, and
 * the "ask the brain" link carried the same junk. Every unmarked retired-tool finding hit it.
 *
 * The two separators are exclusive by construction: a note path holds neither a space, a middot,
 * nor a "↔", so " ↔ " marks only a pair and " · " marks only a ref list, and a bare ":line" is
 * the only shape a real line number appears in.
 */
export function noteOf(loc: string): string {
  const pair = loc.indexOf(" ↔ ");
  if (pair > 0) return loc.slice(0, pair);
  const refs = loc.indexOf(" · ");
  if (refs > 0) return loc.slice(0, refs);
  const cut = loc.lastIndexOf(":");
  return cut > 0 && /^\d+$/.test(loc.slice(cut + 1)) ? loc.slice(0, cut) : loc;
}
