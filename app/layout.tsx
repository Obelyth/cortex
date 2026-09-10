import type { Metadata } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/**
 * Both faces are self-hosted. next/font/google fetches at BUILD time and serves from this
 * origin, so there is no runtime request to Google — no third-party font CDN in the loading
 * path of a page about keeping a private brain private.
 *
 * Archivo replaced Steelfish + Hanken Grotesk in the console redesign, and one variable file
 * does both jobs: the `wdth` axis runs 62–125, so "Archivo Expanded" is this same file at
 * wdth 125 rather than a second download. Display type takes the wide end, running UI text
 * sits at the default 100. Steelfish was compressed, which is the opposite of the reference's
 * wide geometric proportion — that proportion is the point of the change, not a side effect.
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
  title: "CORTEX by OBELYTH — one memory, every surface",
  description:
    "A private markdown brain served to every Claude surface over MCP, with a read path that proves its own citations.",
  // The console is private and the landing describes a personal system — neither wants indexing.
  robots: { index: false, follow: false },
  icons: { icon: "/favicon.svg" },
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
