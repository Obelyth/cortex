"use client";
/**
 * The appearance switch. The brand is dark-first and defines no light palette, so light mode is
 * a re-lit set of the same semantic tokens applied to the console root — not a second design
 * system. The choice persists in localStorage and is applied before paint by a tiny inline
 * script in the layout, so a reload never flashes the wrong ground.
 */
import { useEffect, useState } from "react";

const KEY = "cortex-appearance";

export function Appearance() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") setTheme(saved);
  }, []);

  const pick = (next: "dark" | "light") => {
    setTheme(next);
    localStorage.setItem(KEY, next);
    document.documentElement.dataset.appearance = next;
  };

  return (
    <>
      <span className="conAp">
        {(["dark", "light"] as const).map((k) => (
          <button key={k} type="button" aria-pressed={theme === k}
            className={theme === k ? "conApBtn conApOn" : "conApBtn"}
            onClick={() => pick(k)}>
            {k}
          </button>
        ))}
      </span>
    </>
  );
}
