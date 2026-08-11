import type { MetadataRoute } from "next";

/**
 * The three public documents. /map is deliberately absent: it is an embedded demo
 * artifact that opts out of indexing with its own x-robots-tag header — the landing is
 * the page that should rank. Gated routes are not merely absent, they 404 without their
 * secret, so there is nothing else to list.
 */
const BASE = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : "https://obelyth-cortex.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["/", "/tools", "/guide"].map((path) => ({
    url: `${BASE}${path}`,
    changeFrequency: "monthly" as const,
    priority: path === "/" ? 1 : 0.7,
  }));
}
