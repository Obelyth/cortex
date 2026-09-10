import { describe, expect, it } from "vitest";
import {
  configurationAcknowledgementSchema,
  configurationRecordSchema,
  newConfigurationRequestKey,
  requestKeyTimestamp,
} from "../lib/console-configuration-contract";

describe("client-safe configuration contract", () => {
  it("generates UUIDv7 request keys from browser crypto entropy and preserves the timestamp", () => {
    const now = Date.UTC(2026, 8, 8, 23, 30, 0);
    const entropy = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
    const key = newConfigurationRequestKey(now, (target) => target.set(entropy));
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(requestKeyTimestamp(key)).toBe(now);
  });

  it("rejects v4, malformed and non-canonical UUIDv7 identities", () => {
    expect(requestKeyTimestamp("11111111-1111-4111-8111-111111111111")).toBeNull();
    expect(requestKeyTimestamp("not-a-key")).toBeNull();
    expect(requestKeyTimestamp("FFFFFFFF-FFFF-7FFF-8FFF-FFFFFFFFFFFF")).toBeNull();
  });

  it("rejects server records containing values, unknown fields or invalid result names", () => {
    const valid = {
      capability: "reader-openai",
      target: "vercel:prj_fixture:personal:production",
      revision: 1,
      status: "finished",
      requestKey: "0199-ignored",
      result: { state: "saved-pending-deployment", accepted: ["OPENAI_API_KEY"], failed: [] },
      acknowledged: false,
      updatedAt: "2026-09-08T23:00:00.000Z",
    };
    expect(configurationRecordSchema.safeParse(valid).success).toBe(false);
    const requestKey = newConfigurationRequestKey();
    expect(configurationRecordSchema.safeParse({ ...valid, requestKey }).success).toBe(true);
    expect(configurationRecordSchema.safeParse({ ...valid, requestKey, value: "secret" }).success).toBe(false);
    expect(configurationRecordSchema.safeParse({ ...valid, requestKey, result: { ...valid.result, accepted: ["ARBITRARY"] } }).success).toBe(false);
  });

  it("requires an acknowledgment response to carry an uncertain acknowledged receipt", () => {
    const requestKey = newConfigurationRequestKey();
    const envelope = {
      acknowledged: true,
      warning: "the provider write may still finish",
      record: {
        capability: "reader-openai",
        target: "vercel:prj_fixture:personal:production",
        revision: 1,
        status: "uncertain",
        requestKey,
        result: null,
        acknowledged: true,
        updatedAt: "2026-09-08T23:00:00.000Z",
      },
    };
    expect(configurationAcknowledgementSchema.safeParse(envelope).success).toBe(true);
    expect(configurationAcknowledgementSchema.safeParse({ ...envelope, record: { ...envelope.record, status: "running", acknowledged: false } }).success).toBe(false);
    expect(configurationAcknowledgementSchema.safeParse({ ...envelope, record: { ...envelope.record, acknowledged: false } }).success).toBe(false);
  });
});
