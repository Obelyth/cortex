import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => lifecycle.effects.push(effect),
    useState: <T,>(initial: T | (() => T)) => [
      typeof initial === "function" ? (initial as () => T)() : initial,
      vi.fn(),
    ] as const,
  };
});

import { StatusChip } from "../app/s/[secret]/console/status-chip";

beforeEach(() => {
  lifecycle.effects.length = 0;
  vi.stubGlobal("window", {
    location: { pathname: "/" },
    setInterval: vi.fn(() => 1),
    clearInterval: vi.fn(),
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
});

describe("console status route derivation", () => {
  it.each([
    ["top-level", "/s/console/console/ops"],
    ["nested", "/s/console/console/attention/readers"],
  ])("anchors the %s request to the console route when the secret is console", (_level, pathname) => {
    window.location.pathname = pathname;
    StatusChip();
    expect(lifecycle.effects).toHaveLength(1);
    lifecycle.effects[0]();
    expect(fetch).toHaveBeenCalledWith("/s/console/console/status", expect.objectContaining({ cache: "no-store" }));
  });
});
