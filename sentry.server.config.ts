import * as Sentry from "@sentry/nextjs";

/**
 * The path secret IS the credential in this design, and Sentry attaches request context —
 * including the URL — to server error events. Scrub the /s/<secret>/ segment before anything
 * leaves the process, so opting into error reporting never ships the door key with the report.
 */
/**
 * EVERY secret-bearing segment, not just the console's. The first cut matched `/s/<secret>`
 * alone, which left the guest door — `/api/g/<secret>/mcp` — shipping its key verbatim, since
 * that URL contains no `/s/` substring. Both doors are path-secret doors; both get scrubbed.
 */
const scrub = (s: string) => s.replace(/\/(api\/)?([sg])\/[^/?#]+/g, "/$1$2/<redacted>");

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0,
    beforeSend(event) {
      if (event.request?.url) event.request.url = scrub(event.request.url);
      const headers = event.request?.headers;
      if (headers) {
        for (const k of ["Referer", "referer"]) {
          const v = headers[k];
          if (typeof v === "string") headers[k] = scrub(v);
        }
        // The console cookie is the device stamp — a passcode-derived credential (lib/stamp.ts;
        // it used to be the path secret verbatim), so there is still nothing in this header
        // worth keeping. Dropped rather than scrubbed: a cookie jar is a bag of credentials,
        // and scrubbing one name leaves the rest.
        for (const k of ["Cookie", "cookie"]) delete headers[k];
      }
      // The entry route's passcode prompt POSTs the passcode as a form body. Bodies carry no
      // context an error report needs here; dropped wholesale so a throw mid-verify can never
      // ship the one credential the whole lock is made of.
      if (event.request && "data" in event.request) delete event.request.data;
      return event;
    },
  });
}
