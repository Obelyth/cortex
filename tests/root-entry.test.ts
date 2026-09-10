import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The bare domain is the operator's habit — and the exact page a leaked link's holder tries
 * next. It forwards only a device whose stamp validates against the passcode derivation;
 * everything else, including a device still carrying the pre-passcode cookie (the raw path
 * secret), gets the same anonymous 404 as a stranger.
 */

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

import Root from "../app/page";
import { STAMP_COOKIE, stampValue } from "../lib/stamp";

const SECRET = "b".repeat(64);

beforeEach(() => {
  vi.stubEnv("CONNECTOR_PATH_SECRET", SECRET);
  vi.stubEnv("CONSOLE_PASSCODE", "opens the board");
  jar.clear();
});

describe("the bare domain", () => {
  it("forwards a stamped device straight to the board", async () => {
    jar.set(STAMP_COOKIE, stampValue()!);
    await expect(Root()).rejects.toThrow(`NEXT_REDIRECT:/s/${SECRET}/console/ops`);
  });

  it("404s a device with no cookie at all", async () => {
    await expect(Root()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s the pre-passcode cookie — the raw secret is no longer a stamp", async () => {
    jar.set(STAMP_COOKIE, SECRET);
    await expect(Root()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("fails closed while the passcode is unconfigured, even against a once-real stamp", async () => {
    jar.set(STAMP_COOKIE, stampValue()!);
    vi.stubEnv("CONSOLE_PASSCODE", "");
    await expect(Root()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
