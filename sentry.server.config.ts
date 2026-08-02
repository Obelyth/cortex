import * as Sentry from "@sentry/nextjs";

/**
 * The path secret IS the credential in this design, and Sentry attaches request context —
 * including the URL — to server error events. Scrub the /s/<secret>/ segment before anything
 * leaves the process, so opting into error reporting never ships the door key with the report.
 */
const scrub = (s: string) => s.replace(/\/s\/[^/?#]+/g, "/s/<redacted>");

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
      }
      return event;
    },
  });
}
