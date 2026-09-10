/**
 * The console's navigation table, deliberately NOT in tabs.tsx despite belonging to it.
 *
 * tabs.tsx is "use client" (it reads usePathname()), and both the landing redirects
 * (app/page.tsx, this segment's route.ts) are server code that needs LANDING_SEG as a plain
 * string. Importing a named export from a "use client" module into server code does not hand
 * back the value — Next replaces every export of a client module with a client reference stub,
 * so `${LANDING_SEG}` in a Server Component or a route handler serializes to the stub's
 * to-string, not "ops" (confirmed against a production build: the redirect Location header came
 * back carrying the stub's error text, not the segment). A plain, client-directive-free module
 * both sides can import avoids the boundary entirely. Tabs.tsx re-exports these two names so
 * `import { TABS, LANDING_SEG } from "./tabs"` still works for anything that already reads them
 * from there.
 */
export const LANDING_SEG = "ops";
// Typed as the broad ReadonlyArray, not an `as const` literal tuple: code checking that a
// segment is ABSENT from TABS (e.g. `t.seg === "attention"`) needs that comparison to stay
// assignable even though no row carries the literal — a narrower literal-union type would turn
// that check into a compile error instead of the runtime `false` it is testing for.
// Notes is gone (v2, 2026-09-05): the corpus explorer lives on Ask, and corpus/route.ts sends
// the old address there.
export const TABS: ReadonlyArray<{ seg: string; label: string }> = [
  { seg: "ops", label: "Ops" },
  { seg: "overview", label: "Overview" },
  { seg: "ask", label: "Ask" },
  { seg: "trends", label: "Trends" },
  { seg: "settings", label: "Settings" },
];
