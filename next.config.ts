import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // lib/migrations.ts reads supabase/migrations/ at request time to compare against the live
  // ledger. A serverless bundle carries only the files the tracer saw imported, so the directory
  // is named here for every route; without it the check goes quiet in production and works only
  // in dev, which is the wrong way round.
  outputFileTracingIncludes: { "/**": ["./supabase/migrations/*.sql"] },
  async headers() {
    // The deployment is private. Cover raw HTML, JSON, redirects and refusals,
    // not just React metadata. Never publish credential-bearing route names.
    // These hints supplement authentication; they cannot enforce access control.
    return ["/", "/s/:path*", "/api/:path*"].map((source) => ({
      source,
      headers: [
        { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" },
        { key: "Referrer-Policy", value: "no-referrer" },
      ],
    }));
  },
};

export default nextConfig;
