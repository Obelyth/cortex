"use client";
import { usePathname } from "next/navigation";

/**
 * Seven became six: Models and Connect live inside Settings (the owner's standing merge).
 * The bar itself follows the design file exactly — top placement, uppercase mono, a cyan
 * underline on the active tab. Labels are the design's vocabulary; segments keep their URLs.
 */
/* Ask sits second, right after Overview: it is the only screen that uses the brain rather than
   measuring it, and it is the one a newcomer needs first. Everything after it is telemetry. */
const TABS = [
  { seg: "overview", label: "Overview" },
  { seg: "ask", label: "Ask" },
  { seg: "trends", label: "Trends" },
  { seg: "corpus", label: "Notes" },
  { seg: "attention", label: "Inbox" },
  { seg: "map", label: "Map" },
  { seg: "settings", label: "Settings" },
] as const;

const MERGED = new Set(["readers", "guide"]);

export function Tabs({ attention }: { attention: number }) {
  const last = (usePathname() ?? "").split("/").filter(Boolean).pop() ?? "";
  const active = MERGED.has(last) ? "settings" : last;
  return (
    <nav className="conTabs" aria-label="Console">
      {TABS.map((t) => (
        <a
          key={t.seg}
          href={t.seg}
          className={`conTab${t.seg === active ? " on" : ""}`}
          aria-current={t.seg === active ? "page" : undefined}
        >
          {t.label}
          {t.seg === "attention" && attention > 0 && <span className="conTabN">{attention}</span>}
        </a>
      ))}
    </nav>
  );
}
