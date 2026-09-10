"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LANDING_SEG, TABS } from "./nav";
import { consoleRoutePath } from "./route-path";

// Re-exported so `import { TABS, LANDING_SEG } from "./tabs"` keeps working — the values
// themselves live in nav.ts (a plain module, no "use client") so server code (app/page.tsx,
// this segment's route.ts) can read LANDING_SEG as the real string. See nav.ts for why.
export { LANDING_SEG, TABS };

/**
 * Seven became six: Models and Connect live inside Settings (the owner's standing merge).
 * The bar itself follows the design file exactly — top placement, uppercase mono, a cyan
 * underline on the active tab. Labels are the design's vocabulary; segments keep their URLs.
 *
 * Ops leads (spec §5): the landing screen and the tab you land on, because it is the one place
 * the register lives and controls act. Ask sits right after Overview: it is the only screen
 * that uses the brain rather than measuring it, and the one a newcomer needs first once they've
 * seen the board is healthy. Everything after it is telemetry. The Inbox tab is gone — its
 * queue moved into the Ops rail, and its badge count now feeds the notices bell (Task 13).
 */
const MERGED = new Set(["readers", "guide", "attention"]);   // attention → ops

export function Tabs({ badge }: Readonly<{ badge?: number }> = {}) {
  const pathname = usePathname() ?? "";
  const segments = consoleRoutePath(pathname)?.segments ?? [];
  const last = segments.at(-1) ?? "";
  const active = MERGED.has(last) ? (last === "attention" ? "ops" : "settings") : last;
  // A relative link keeps the path secret out of server-authored props. Each `../` removes one
  // nested route level beyond the current page's leaf; a normal tab is already at depth one.
  const prefix = "../".repeat(Math.max(0, segments.length - 1));
  return (
    <nav className="conTabs" aria-label="Console">
      {TABS.map((t) => (
        <Link
          key={t.seg}
          href={`${prefix}${t.seg}`}
          prefetch={false}
          className={`conTab${t.seg === active ? " on" : ""}`}
          aria-current={t.seg === active ? "page" : undefined}
        >
          {t.label}
          {t.seg === "ops" && badge != null && badge > 0 && <span className="conTabN">{badge}</span>}
        </Link>
      ))}
    </nav>
  );
}
