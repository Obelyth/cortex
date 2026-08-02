import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The gate's invariant is architectural: a Next.js layout's notFound() does NOT stop sibling
 * pages from executing and serializing, so every page under /s/[secret] must call
 * requireSecret() itself, before it reads anything. These tests pin both halves — the gate's
 * own behavior, and the presence of the call in every gated segment — because dropping the
 * call from one page is exactly the edit that ships silently.
 */

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

const params = (secret: string) => Promise.resolve({ secret });

describe("requireSecret", () => {
  const saved = process.env.CONNECTOR_PATH_SECRET;
  beforeEach(() => {
    process.env.CONNECTOR_PATH_SECRET = "the-right-secret";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CONNECTOR_PATH_SECRET;
    else process.env.CONNECTOR_PATH_SECRET = saved;
  });

  it("returns the secret on a match", async () => {
    const { requireSecret } = await import("../lib/gate");
    await expect(requireSecret(params("the-right-secret"))).resolves.toBe("the-right-secret");
  });

  it("404s on a mismatch", async () => {
    const { requireSecret } = await import("../lib/gate");
    await expect(requireSecret(params("wrong"))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("fails closed when the env var is unset — even on an empty-string 'match'", async () => {
    delete process.env.CONNECTOR_PATH_SECRET;
    const { requireSecret } = await import("../lib/gate");
    await expect(requireSecret(params(""))).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("every gated segment calls the gate itself", () => {
  const root = join(__dirname, "..", "app", "s", "[secret]");
  const sources = readdirSync(root, { recursive: true })
    .map(String)
    .filter((f) => /(^|\/)(page|layout)\.tsx$/.test(f))
    .map((f) => ({ file: f, src: readFileSync(join(root, f), "utf8") }));

  it("found the gated tree", () => {
    // The console alone is six page/layout files; a tiny count means the glob broke, not the app.
    expect(sources.length).toBeGreaterThanOrEqual(8);
  });

  it.each(sources.map((s) => [s.file, s.src] as const))(
    "%s calls requireSecret",
    (_file, src) => {
      expect(src).toMatch(/await requireSecret\(params\)/);
    },
  );

  it.each(sources.map((s) => [s.file, s.src] as const))(
    "%s gates before any corpus read",
    (_file, src) => {
      const gateAt = src.indexOf("requireSecret(");
      for (const call of ["health(", "buildAtlas(", "listCommits("]) {
        const dataAt = src.indexOf(call);
        if (dataAt !== -1) expect(gateAt).toBeLessThan(dataAt);
      }
    },
  );
});
