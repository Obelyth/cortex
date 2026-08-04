import type { Metadata } from "next";
import { Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/**
 * Both faces are self-hosted: next/font/google fetches at BUILD time and serves from this
 * origin, so there is no runtime request to Google — no third-party font CDN in the loading
 * path of a page about keeping a private brain private.
 *
 * The DISPLAY slot ships empty on purpose. The reference deployment uses a licensed display
 * face we cannot redistribute; headers fall back to Hanken bold here. To add your own: drop a
 * font in public/fonts/, add a next/font/local block exposing --font-display, and put its
 * variable class on // suppressHydrationWarning is for ONE attribute: the console layout stamps data-appearance
    // on <html> pre-paint (from localStorage) so a reload never flashes the wrong ground. The
    // server cannot know that value, the mismatch is by design.
    <html> below.
 */
const hanken = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-hanken",
});
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  // Derived from the deployment so every self-hosted instance emits canonical and Open Graph
  // URLs for its own host. Vercel injects VERCEL_PROJECT_PRODUCTION_URL (bare hostname, no
  // scheme) into every build; the literal below is only the final fallback for builds that
  // run outside Vercel, where absolute metadata URLs have no host to resolve against.
  metadataBase: new URL(
    process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "https://obelyth-cortex.vercel.app",
  ),
  title: "Cortex by Obelyth — one memory, every surface",
  description:
    "Your notes, in one place, available to Claude everywhere you use it. Ask a question and get the answer plus the exact line it came from — checked automatically, or an honest “that isn't in here.”",
  alternates: { canonical: "/" },
  openGraph: {
    title: "Cortex by Obelyth — one memory, every surface",
    description:
      "A private markdown brain served to every Claude surface over MCP, with a read path that proves its own citations. Open source, AGPL-3.0.",
    url: "/",
    siteName: "Cortex by Obelyth",
    type: "website",
    images: [{ url: "/brand/obelyth-emblem.png", width: 256, height: 256, alt: "The Obelyth emblem" }],
  },
  twitter: { card: "summary" },
  // The product site is public and indexable. Gated routes 404 without the secret, and the
  // raw demo-map route still opts itself out with its own x-robots-tag header.
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html suppressHydrationWarning
      lang="en"
      className={`${hanken.variable} ${jetbrains.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
