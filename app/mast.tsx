import Link from "next/link";

/**
 * The public masthead: the OBELYTH emblem, the wordmark, the byline, and the four public
 * destinations. The gated console and the real map are deliberately absent — a public nav must
 * not advertise what the secret protects. The demo map at /map is the public stand-in.
 *
 * The emblem is the one warm note the brand allows: the bone obelisk keeps its tone; everything
 * else on the page stays in the cool slate/steel/cyan system.
 */
const TABS = [
  { label: "Overview", href: "/" },
  { label: "Tools", href: "/tools" },
  { label: "Map", href: "/map" },
  { label: "Guide", href: "/guide" },
];

export function Mast({ active }: { active: string }) {
  return (
    <div className="mast">
      <span className="brand">
        {/* eslint-disable-next-line @next/next/no-img-element -- static asset, fixed size */}
        <img className="emblem" src="/brand/obelyth-emblem.png" alt="" width={34} height={34} />
        <span className="brandText">
          <h1>Cortex</h1>
          <span className="byline">by OBELYTH</span>
        </span>
      </span>
      <nav className="tabs" aria-label="Site">
        {TABS.map((t) => (
          <Link key={t.href} href={t.href} className={`tab${t.href === active ? " on" : ""}`}
            aria-current={t.href === active ? "page" : undefined}>
            {t.label}
          </Link>
        ))}
      </nav>
      <span className="spacer" />
      <span className="eyebrow">private memory server</span>
    </div>
  );
}

/** The brand line every public page closes on. */
export function BrandFoot() {
  return (
    <div className="brandFoot">
      {/* eslint-disable-next-line @next/next/no-img-element -- static asset, fixed size */}
      <img className="emblem" src="/brand/obelyth-emblem.png" alt="OBELYTH" width={22} height={22} />
      <span className="mono">
        CORTEX BY OBELYTH<span className="dim"> — DATA. INFRASTRUCTURE. ASSURED.</span>
      </span>
    </div>
  );
}
