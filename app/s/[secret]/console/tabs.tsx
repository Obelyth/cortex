"use client";
import { usePathname } from "next/navigation";

/**
 * Six sibling screens; every href is RELATIVE so the secret never appears in markup. The
 * active tab comes from the pathname's last segment.
 *
 * Readers sits second, next to overview, because it answers the question the overview now
 * raises: the numbers there are an aggregate over several models, and this is where you find
 * out which ones.
 */
const TABS = ["overview", "readers", "corpus", "attention", "map", "guide", "settings"] as const;

export function Tabs({ attention }: { attention: number }) {
  const last = (usePathname() ?? "").split("/").filter(Boolean).pop();
  return (
    <nav className="conTabs" aria-label="Console">
      {TABS.map((t) => (
        <a key={t} href={t} className={`conTab${t === last ? " on" : ""}`}
          aria-current={t === last ? "page" : undefined}>
          {t}
          {t === "attention" && attention > 0 && <span className="conTabN">{attention}</span>}
        </a>
      ))}
    </nav>
  );
}
