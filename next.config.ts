import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // lib/migrations.ts reads supabase/migrations/ at request time to compare against the live
  // ledger. A serverless bundle carries only the files the tracer saw imported, so the directory
  // is named here for every route; without it the check goes quiet in production and works only
  // in dev, which is the wrong way round.
  outputFileTracingIncludes: { "/**": ["./supabase/migrations/*.sql"] },
};

export default nextConfig;
