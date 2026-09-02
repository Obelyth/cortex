import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Mirrors tsconfig's "@/*" -> "./*" mapping. Regex (not a plain "@" string
// key) so it only matches the "@/..." local-root prefix and doesn't also
// swallow scoped package specifiers like "@modelcontextprotocol/sdk".
const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@\//, replacement: `${rootDir}/` }],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    unstubEnvs: true,
    unstubGlobals: true,
    coverage: {
      provider: "v8",
      include: ["app/**/*.{ts,tsx}", "lib/**/*.ts"],
      reporter: ["text-summary", "lcov"],
    },
  },
});
