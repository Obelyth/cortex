"use client";
import { usePathname } from "next/navigation";

/**
 * Five sibling screens; every href is RELATIVE so the secret never appears in markup. The
 * active tab comes from the pathname's last segment.
 */
const TABS = ["overview", "corpus", "attention", "map", "guide"] as const;

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
