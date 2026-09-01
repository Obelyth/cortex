import type { Metadata } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/**
 * Both faces are self-hosted. next/font/google fetches at BUILD time and serves from this
 * origin, so there is no runtime request to Google — no third-party font CDN in the loading
 * path of a page about keeping a private brain private.
 *
 * Archivo replaced the previous Hanken Grotesk + display-slot pairing in the console
 * redesign, and one variable file does both jobs: the `wdth` axis runs 62–125, so
 * "Archivo Expanded" is this same file at wdth 125 rather than a second download. Display
 * type takes the wide end, running UI text sits at the default 100.
 *
 * JetBrains Mono is unchanged and load-bearing: mono is what marks a value as functional —
 * every ID, metric and timestamp.
 */
const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  display: "swap",
  variable: "--font-archivo",
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
  // suppressHydrationWarning is gone with the thing that needed it: the console used to stamp
  // data-appearance on <html> pre-paint from localStorage, which the server could not know.
  // The light/dark toggle was removed, so the mismatch it silenced no longer exists, and
  // leaving the suppression in place would hide real hydration bugs.
  return (
    <html lang="en" className={`${archivo.variable} ${jetbrains.variable}`}>
      <body>{children}</body>
    </html>
  );
}
