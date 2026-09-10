import { describe, expect, it, vi } from "vitest";

describe("the Settings write lifecycle", () => {
  it("confirms a valid response only when it belongs to the requested family", async () => {
    const lifecycle = await import("../app/s/[secret]/console/settings/write-lifecycle").catch(() => null);
    expect(lifecycle).not.toBeNull();
    if (!lifecycle) return;
    const fetcher = vi.fn(async () =>
      Response.json({
        defaultReader: "claude-opus-5",
        disabledProviders: [],
        source: "store",
        conflicts: [],
      })
    );

    await expect(
      lifecycle.performSettingsWrite(
        "/s/masked/console/settings/save",
        { defaultReader: "claude-opus-5" },
        fetcher,
      ),
    ).resolves.toMatchObject({ status: "confirmed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["malformed", new Response("not json", { status: 200 })],
    ["wrong-family", Response.json({ ok: true, guest: { scope: ["projects/"] } })],
  ])("does not publish %s HTTP 200 as a saved reader setting", async (_label, postResponse) => {
    const lifecycle = await import("../app/s/[secret]/console/settings/write-lifecycle").catch(() => null);
    expect(lifecycle).not.toBeNull();
    if (!lifecycle) return;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return postResponse;
      return Response.json({
        family: "reader",
        current: { defaultReader: "claude-sonnet-5", disabledProviders: [] },
      });
    });

    await expect(
      lifecycle.performSettingsWrite(
        "/s/masked/console/settings/save",
        { defaultReader: "claude-opus-5" },
        fetcher,
      ),
    ).resolves.toMatchObject({
      status: "unconfirmed",
      error: expect.stringMatching(/completion unconfirmed/i),
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toBe("/s/masked/console/settings/save?family=reader");
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "GET", cache: "no-store" });
  });

  it("reconciles actual current settings after a committed write loses its response without claiming that response committed it", async () => {
    const lifecycle = await import("../app/s/[secret]/console/settings/write-lifecycle").catch(() => null);
    expect(lifecycle).not.toBeNull();
    if (!lifecycle) return;
    let current = "claude-sonnet-5";
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        current = "claude-opus-5";
        throw new TypeError("synthetic response loss after commit");
      }
      return Response.json({
        family: "reader",
        current: { defaultReader: current, disabledProviders: [] },
      });
    });

    const result = await lifecycle.performSettingsWrite(
      "/s/masked/console/settings/save",
      { defaultReader: "claude-opus-5" },
      fetcher,
    );
    expect(result).toMatchObject({
      status: "reconciled",
      error: expect.stringMatching(/completion unconfirmed.*current settings match/i),
    });
    expect("error" in result ? result.error : "").not.toMatch(/saved|wrote|did not reach/i);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("validates learning and guest responses against their requested patch", async () => {
    const lifecycle = await import("../app/s/[secret]/console/settings/write-lifecycle").catch(() => null);
    expect(lifecycle).not.toBeNull();
    if (!lifecycle) return;

    await expect(
      lifecycle.performSettingsWrite(
        "/save",
        { learning: { ansCache: false } },
        vi.fn(async () => Response.json({ ok: true, learning: { ansCache: false } })),
      ),
    ).resolves.toMatchObject({ status: "confirmed" });
    await expect(
      lifecycle.performSettingsWrite(
        "/save",
        { guest: { citations: true } },
        vi.fn(async () =>
          Response.json({
            ok: true,
          guest: { scope: ["projects/"], citations: true, dailyAsks: 50, maxK: 8, revision: "a".repeat(40) },
          }),
        ),
      ),
    ).resolves.toMatchObject({ status: "confirmed" });
  });

  it.each([
    {
      family: "learning",
      body: { learning: { ansCache: false } },
      wrong: { ok: true, guest: { scope: ["projects/"], citations: false, dailyAsks: 50, maxK: 8 } },
      fresh: { family: "learning", current: { ansCache: true } },
    },
    {
      family: "guest",
      body: { guest: { citations: true } },
      wrong: { ok: true, learning: { ansCache: false } },
      fresh: {
        family: "guest",
        current: { scope: ["projects/"], citations: false, dailyAsks: 50, maxK: 8 },
      },
    },
  ])("rejects a wrong-family 200 for the $family family", async ({ body, wrong, fresh }) => {
    const { performSettingsWrite } = await import("../app/s/[secret]/console/settings/write-lifecycle");
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST" ? Response.json(wrong) : Response.json(fresh)
    );
    await expect(performSettingsWrite("/save", body, fetcher)).resolves.toMatchObject({
      status: "unconfirmed",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      family: "reader",
      body: { defaultReader: "claude-opus-5" },
      malformed: {
        defaultReader: "claude-opus-5",
        disabledProviders: ["not-a-provider"],
        source: "store",
        conflicts: [],
      },
      fresh: { family: "reader", current: { defaultReader: "claude-sonnet-5", disabledProviders: [] } },
    },
    {
      family: "learning",
      body: { learning: { ansCache: false } },
      malformed: { ok: true, learning: { ansCache: false, coaccessFloor: "not-a-number" } },
      fresh: { family: "learning", current: { ansCache: true, coaccessFloor: 5 } },
    },
    {
      family: "guest",
      body: { guest: { citations: true } },
      malformed: {
        ok: true,
        guest: { scope: [], citations: true, dailyAsks: -1, maxK: 99_999 },
      },
      fresh: {
        family: "guest",
        current: { scope: ["projects/"], citations: false, dailyAsks: 50, maxK: 8 },
      },
    },
  ])("does not confirm a matching field inside an invalid complete $family receipt", async ({ body, malformed, fresh }) => {
    const { performSettingsWrite } = await import("../app/s/[secret]/console/settings/write-lifecycle");
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST" ? Response.json(malformed) : Response.json(fresh)
    );
    await expect(performSettingsWrite("/save", body, fetcher)).resolves.toMatchObject({
      status: "unconfirmed",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      family: "reader",
      body: { defaultReader: "claude-opus-5" },
      malformed: {
        family: "reader",
        current: { defaultReader: "claude-opus-5", disabledProviders: ["not-a-provider"] },
      },
    },
    {
      family: "learning",
      body: { learning: { ansCache: false } },
      malformed: {
        family: "learning",
        current: { ansCache: false, coaccessFloor: "not-a-number" },
      },
    },
    {
      family: "guest",
      body: { guest: { citations: true } },
      malformed: {
        family: "guest",
        current: { scope: [], citations: true, dailyAsks: -1, maxK: 99_999 },
      },
    },
  ])("does not reconcile a matching field inside an invalid complete $family snapshot", async ({ body, malformed }) => {
    const { performSettingsWrite } = await import("../app/s/[secret]/console/settings/write-lifecycle");
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json({ ok: true, wrongFamily: {} })
        : Response.json(malformed)
    );
    await expect(performSettingsWrite("/save", body, fetcher)).resolves.toMatchObject({
      status: "unconfirmed",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
