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
 * This exported policy is authoritative for application egress and classification.
 */

/** Ordered: the specific token shapes run before the generic key=value rule, so a
 *  recognisable token is labelled by kind rather than swallowed by the catch-all.
 *
 *  Exported so the export gate (tests/no-brain-leakage.test.ts) can extract secret-shaped
 *  substrings from the real brain using THIS list rather than a second one that would drift. */
/**
 * The token alphabet (RFC 6750's b64token) at a width no English word after "bearer" reaches by
 * accident, AND a mark that a word does not carry: a digit, an underscore, a base64 `+` or `=`
 * anywhere, or 20+ characters. A slash is not a mark: "see notes/door.md" is a path, and base64
 * that carries a slash carries a plus, a digit or padding too. Without the mark, "Use bearer authentication for the door" and
 * "the bearer readiness row" came back from brain_ask as "Bearer <redacted>" — a memory system
 * censoring its own prose. Every token shape seen in a real log carries one of the marks or the
 * length; the one that need not, a short Basic credential, is caught by its scheme below.
 */
const TOKENISH = String.raw`(?=[A-Za-z0-9._~+\/-]*(?:[0-9_+=]|[A-Za-z0-9._~+\/-]{20}))[A-Za-z0-9._~+\/-]{8,}=*`;
/** A scheme word: Bearer, Basic, ApiKey, SSWS, GenieKey, Zoho-oauthtoken — a letter, then up to
 *  thirty letters, digits or hyphens. After "Authorization:" any of them says the rest is a value. */
const SCHEME = String.raw`[A-Za-z][A-Za-z0-9-]{1,30}`;

export const SECRETS: Array<[RegExp, string]> = [
  [/\bgithub_pat_[A-Za-z0-9_]*/g, "<redacted-token>"],
  // A header line. The value is one of: a known scheme followed by any 4+ token characters —
  // after "Authorization: Basic" or "Bearer" nothing is prose, and "Basic YTpi" is a credential
  // at four characters; any other scheme word followed by a token-shaped value (ApiKey, SSWS,
  // GenieKey, Splunk, Zoho-oauthtoken, whatever a vendor invents); or, with no scheme, a
  // token-shaped value. "Authorization: none is required for the guest door" is a sentence and
  // passes; the old rule ate it to the end of the line.
  [
    new RegExp(
      String.raw`\b(?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?(?:(?:Bearer|Basic|Token|Digest)[ \t]+[A-Za-z0-9._~+\/-]{4,}=*|${SCHEME}[ \t]+${TOKENISH}|${TOKENISH})`,
      "gi"
    ),
    "Authorization: <redacted>",
  ],
  // The scheme word on its own, anywhere: a pasted curl line, a JSON body, a note's prose. Only
  // a token-shaped value counts, for the reason TOKENISH gives.
  [new RegExp(String.raw`\bBearer[ \t]+${TOKENISH}`, "gi"), "Bearer <redacted>"],
  // Vendor-shaped tokens, identifiable on their own with no key name nearby. The masked
  // sk-…***… form is OpenAI's own invalid-key echo ("Incorrect API key provided:
  // sk-proj-********MA5A") — the provider masks the middle, but the visible slice of a real
  // key still has no business riding an error message out. AIza… is Google's API key shape,
  // load-bearing twice over: the operator's stack is GAS/Sheets, and the Gemini reader's error
  // bodies pass through here.
  [
    /\b(sk-[A-Za-z0-9_-]*\*{3,}[A-Za-z0-9_-]{0,12}|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})/g,
    "<redacted-token>",
  ],
  // A prefix on the key name is allowed on purpose: ADMIN_PASSWORD, DB-SECRET, vercelToken.
  // A plain \b(password) matches NONE of those, because underscore is a word character — and
  // ADMIN_PASSWORD=… is the exact shape of the live credential sitting in this brain's
  // archive. That near-miss is why this pattern is written the wide way. The optional quote
  // before the separator is JSON: in '{"token": "v"}' the char after the key name is a
  // closing quote, and provider error bodies — which now ride through here — are always JSON.
  // The prefix length is BOUNDED, not open. `[A-Za-z0-9_.-]*` is greedy and the six literal
  // alternatives sit behind it, so on a long unbroken run of class characters — a JWT, a
  // base64url blob, a hex digest, a minified line — the engine consumed the run and backtracked
  // over every position, once per start offset. Measured O(n^2): 4k chars 25ms, 16k 407ms, 32k
  // 1.6s. redact() runs on whole notes and on provider error bodies, so that was reachable.
  // 64 is far past any real key name and turns the inner walk into a constant.
  [
    /([A-Za-z0-9_.-]{0,64}(?:password|passwd|secret|token|api[_-]?key))["']?\s*[:=]\s*\S+/gi,
    "$1=<redacted>",
  ],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<redacted-jwt>"],
  // Stop before the next URL start: failed matches never rescan overlapping suffixes.
  // A credential-bearing nested URL is matched independently. Benign URLs are not matches.
  [/https?:\/\/(?:(?!https?:\/\/)[^\s])*[?&](?:token|key|secret)=[^\s&]+/gi, "<redacted-url>"],
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
