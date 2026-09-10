import { describe, expect, it } from "vitest";
import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import nextConfig from "../next.config";

describe("private deployment response headers", () => {
  // These requests exercise the real configured route matchers. Removing a route
  // or applying the protections only to rendered HTML must fail this contract.
  it.each([
    "/",
    "/s",
    "/s/synthetic-path/console",
    "/s/synthetic-path/console/ask?q=synthetic-question",
    "/s/synthetic-path/console/attention/queue",
    "/s/wrong-path/console",
    "/api",
    "/api/mcp",
    "/api/s/synthetic-path/mcp",
    "/api/g/synthetic-guest/mcp",
    "/api/ops/report",
    "/api/ops/sweep",
  ])("does not advertise or forward the private URL for %s", async (path) => {
    const response = await unstable_getResponseFromNextConfig({
      url: `https://cortex.example${path}`,
      nextConfig,
    });
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive, nosnippet");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.has("location")).toBe(false);
    expect(response.headers.has("link")).toBe(false);
  });

  it("does not change public brand asset responses", async () => {
    const response = await unstable_getResponseFromNextConfig({
      url: "https://cortex.example/brand/obelyth-emblem.png",
      nextConfig,
    });
    expect(response.headers.has("x-robots-tag")).toBe(false);
    expect(response.headers.has("referrer-policy")).toBe(false);
  });
});
