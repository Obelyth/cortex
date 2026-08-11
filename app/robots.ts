import type { MetadataRoute } from "next";

/**
 * Allow everything, name nothing. A Disallow line for the secret-gated paths would
 * advertise in a public file exactly what the gate exists to hide — those routes answer
 * an empty 404 without their secret, which is protection enough. /map opts out of
 * indexing with its own x-robots-tag response header rather than a listing here.
 */
const BASE = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : "https://obelyth-cortex.vercel.app";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${BASE}/sitemap.xml`,
  };
}
