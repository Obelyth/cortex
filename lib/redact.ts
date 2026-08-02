/**
 * redact — strip credential-shaped strings on the way OUT of the brain.
 *
 * The brain is a working memory of a real person's projects, so credentials end up in it:
 * pasted from a deploy log, quoted from a config file, written down while debugging. There
 * is one in this repo right now. Storing them is the underlying mistake, but a memory system
 * that emits them on request turns a bad habit into an exfiltration channel — an agent that
 * has been prompt-injected by a web page it was asked to summarise can call a search tool and
 * read a production password straight into someone else's context.
 *
 * So this is applied at EGRESS, not at write time. Writing is the operator's business; what leaves
 * the server is the system's. Redaction is visible (`<redacted>`, never silent deletion) so
 * an answer that depended on a secret reads as censored rather than as wrong.
 *
 * Port of brain/tools/brain_ask.py scrub() — same patterns, same intent, so the two
 * implementations cannot disagree about what counts as a secret.
 */

/** Ordered: the specific token shapes run before the generic key=value rule, so a
 *  recognisable token is labelled by kind rather than swallowed by the catch-all. */
const SECRETS: Array<[RegExp, string]> = [
  // Vendor-shaped tokens, identifiable on their own with no key name nearby.
  [
    /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/g,
    "<redacted-token>",
  ],
  // A prefix on the key name is allowed on purpose: ADMIN_PASSWORD, DB-SECRET, vercelToken.
  // A plain \b(password) matches NONE of those, because underscore is a word character — and
  // ADMIN_PASSWORD=… is the exact shape of the live credential sitting in this brain's
  // archive. That near-miss is why this pattern is written the wide way.
  [
    /([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key))\s*[:=]\s*\S+/gi,
    "$1=<redacted>",
  ],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<redacted-jwt>"],
  [/https?:\/\/[^\s]*[?&](?:token|key|secret)=[^\s&]+/gi, "<redacted-url>"],
];

/** Redact every credential shape. Safe on undefined/empty; never throws. */
export function redact(text: string): string {
  let out = text;
  for (const [pat, repl] of SECRETS) out = out.replace(pat, repl);
  return out;
}

/** True when redact() would change the text — for telling a caller that output was censored
 *  rather than letting them read a `<redacted>` and wonder if the note literally says that. */
export function hasSecret(text: string): boolean {
  return redact(text) !== text;
}
