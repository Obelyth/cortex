import type { Metadata } from "next";
import { Bebas_Neue, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/**
 * Faces are self-hosted: next/font/google fetches at BUILD time and serves from this origin,
 * so there is no runtime request to Google — no third-party font CDN in the loading path of a
 * page about keeping a private brain private.
 *
 * Display: Bebas Neue stands in for the licensed Steelfish face we cannot redistribute —
 * tall industrial caps for hero/section headers. Swap for a local Steelfish file later via
 * next/font/local on --font-display if the license allows.
 */
const display = Bebas_Neue({
  subsets: ["latin"],
  weight: "400",
  display: "swap",
  variable: "--font-display",
});
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
  metadataBase: new URL("https://obelyth-cortex.vercel.app"),
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
    <html
      lang="en"
      className={`${display.variable} ${hanken.variable} ${jetbrains.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
