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
 * variable class on <html> below.
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
  title: "CORTEX by OBELYTH — one memory, every surface",
  description:
    "A private markdown brain served to every Claude surface over MCP, with a read path that proves its own citations.",
  // The console is private and the landing describes a personal system — neither wants indexing.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${hanken.variable} ${jetbrains.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
