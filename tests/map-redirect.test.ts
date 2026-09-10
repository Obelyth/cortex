import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => vi.fn());
const go = vi.hoisted(() => vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
}));

vi.mock("../lib/gate", () => ({ requireSecret: gate }));
vi.mock("next/navigation", () => ({ redirect: go }));

import ConsoleMap from "../app/s/[secret]/console/map/page";
import StandaloneMap from "../app/s/[secret]/map/page";

const pages = [
  ["console Map", ConsoleMap],
  ["standalone Map", StandaloneMap],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(pages)("%s compatibility page", (_name, Page) => {
  it("gates before redirecting an authenticated bookmark to Ask", async () => {
    gate.mockResolvedValueOnce("door/with space");

    await expect(Page({ params: Promise.resolve({ secret: "door/with space" }) })).rejects.toThrow(
      "NEXT_REDIRECT:/s/door%2Fwith%20space/console/ask",
    );
    expect(gate).toHaveBeenCalledOnce();
    expect(go).toHaveBeenCalledOnce();
  });

  it("keeps an unauthorized bookmark fail-closed", async () => {
    gate.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));

    await expect(Page({ params: Promise.resolve({ secret: "wrong" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(go).not.toHaveBeenCalled();
  });
});
