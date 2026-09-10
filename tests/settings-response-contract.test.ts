import { describe, expect, it } from "vitest";

const valid = {
  reader: {
    defaultReader: "claude-sonnet-5",
    disabledProviders: ["google"],
    source: "store",
    conflicts: [],
  },
  learning: {
    ok: true,
    learning: {
      ansCache: true,
      ansCacheTtlDays: 30,
      handoffBudget: 100_000,
      watchSupersededLink: false,
      watchCoaccessGap: true,
      watchCorrectionChain: false,
      watchOversizedPage: true,
      coaccessFloor: 2,
    },
  },
  guest: {
    ok: true,
    guest: {
      scope: ["projects/", "notes/allowed.md", "notes/team/", "profile.md"],
      citations: false,
      dailyAsks: 1_000,
      maxK: 40,
      revision: "a".repeat(40),
    },
  },
} as const;

describe("client-safe Settings response contracts", () => {
  it.each(["reader", "learning", "guest"] as const)("accepts the complete valid %s receipt", async (family) => {
    const contract = await import("../app/s/[secret]/console/settings/response-contract").catch(() => null);
    expect(contract).not.toBeNull();
    if (!contract) return;
    expect(contract.parseSettingsReceipt(family, valid[family])).not.toBeNull();
  });

  it.each([
    ["reader", { ...valid.reader, defaultReader: "unlisted-reader" }],
    ["reader", { ...valid.reader, disabledProviders: ["not-a-provider"] }],
    ["reader", { ...valid.reader, defaultReader: "gemini-3.6-flash", disabledProviders: ["google"] }],
    ["reader", { ...valid.reader, internal: "not part of the DTO" }],
    ["learning", { ok: true, learning: { coaccessFloor: "not-a-number" } }],
    ["learning", { ok: true, learning: { ansCacheTtlDays: 31 } }],
    ["learning", { ok: true, learning: { handoffBudget: 3_999 } }],
    ["learning", { ok: true, learning: { watchCoaccessGap: "yes" } }],
    ["learning", { ok: true, learning: { unknownKnob: true } }],
    ["guest", { ok: true, guest: { ...valid.guest.guest, scope: [] } }],
    ["guest", { ok: true, guest: { ...valid.guest.guest, scope: ["notes/team"] } }],
    ["guest", { ok: true, guest: { ...valid.guest.guest, citations: "yes" } }],
    ["guest", { ok: true, guest: { ...valid.guest.guest, dailyAsks: 0 } }],
    ["guest", { ok: true, guest: { ...valid.guest.guest, dailyAsks: 1_001 } }],
    ["guest", { ok: true, guest: { ...valid.guest.guest, maxK: 41 } }],
    ["guest", { ok: true, guest: { ...valid.guest.guest, internal: true } }],
  ] as const)("rejects an out-of-domain or extra field in the complete %s receipt", async (family, value) => {
    const contract = await import("../app/s/[secret]/console/settings/response-contract").catch(() => null);
    expect(contract).not.toBeNull();
    if (!contract) return;
    expect(contract.parseSettingsReceipt(family, value)).toBeNull();
  });

  it.each([
    [
      "reader",
      { family: "reader", current: { defaultReader: "claude-sonnet-5", disabledProviders: ["not-a-provider"] } },
    ],
    [
      "learning",
      { family: "learning", current: { ansCache: false, coaccessFloor: "not-a-number" } },
    ],
    [
      "guest",
      { family: "guest", current: { ...valid.guest.guest, scope: [], dailyAsks: -1, maxK: 99_999 } },
    ],
  ] as const)("rejects a malformed %s reconciliation snapshot", async (family, value) => {
    const contract = await import("../app/s/[secret]/console/settings/response-contract").catch(() => null);
    expect(contract).not.toBeNull();
    if (!contract) return;
    expect(contract.parseSettingsSnapshot(family, value)).toBeNull();
  });
});
