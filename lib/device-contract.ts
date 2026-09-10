import { z } from "zod";
import { hasSecret } from "./redact";

export const DEVICE_CATEGORIES = ["computer", "phone", "tablet", "other"] as const;
export const deviceLabel = z.string().trim().min(1).max(60).refine(s => new TextEncoder().encode(s).length <= 240 && !/[\x00-\x1f\x7f]/.test(s) && !hasSecret(s));
const id = z.uuidv4();
const timestamp = z.iso.datetime({ offset: true });
export const deviceItem = z.strictObject({ id, label: z.string().min(1).max(240), category: z.enum(DEVICE_CATEGORIES).nullable(), createdAt: timestamp, updatedAt: timestamp, lastSeenAt: timestamp.nullable() });
export type DeviceItem = z.infer<typeof deviceItem>;
export const deviceRoster = z.strictObject({ items: z.array(deviceItem).max(50), currentId: id.nullable() }).refine(r => r.currentId === null || r.items.some(i => i.id === r.currentId));
export type DeviceRoster = z.infer<typeof deviceRoster>;
export const deviceCommand = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("prepare") }),
  z.strictObject({ action: z.literal("register"), intent: z.string().min(1).max(200), label: deviceLabel, category: z.enum(DEVICE_CATEGORIES).nullable() }),
  z.strictObject({ action: z.literal("rename"), id, updatedAt: timestamp, label: deviceLabel }),
  z.strictObject({ action: z.literal("forget"), id, updatedAt: timestamp }),
  z.strictObject({ action: z.literal("visit"), visible: z.literal(true) }),
]);
export type DeviceCommand = z.infer<typeof deviceCommand>;
export const deviceResult = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("prepared"), intent: z.string().min(1).max(200), expiresAt: timestamp }),
  z.strictObject({ outcome: z.literal("registered"), item: deviceItem }),
  z.strictObject({ outcome: z.literal("renamed"), item: deviceItem }),
  z.strictObject({ outcome: z.literal("forgotten"), id }),
  z.strictObject({ outcome: z.literal("visited") }),
  z.strictObject({ outcome: z.literal("throttled") }),
  z.strictObject({ outcome: z.literal("unregistered") }),
]);
export type DeviceResult = z.infer<typeof deviceResult>;
export const DEVICE_MESSAGES = {
  invalid: "Use a name of 1 to 60 characters without credentials or control characters, and a listed category.",
  unavailable: "Device inventory is unavailable. Reporter data is separate. Retry loading the inventory.",
  uncertain: "Completion is uncertain. Refresh the inventory; retry registration with the same intent, or review the current row before another change.",
  conflict: "This inventory row changed. Refresh the inventory and review it before trying again.",
  missing: "This inventory row was removed. Refresh the inventory.",
  forgotten: "This registration was forgotten. It has not been recreated. Refresh the inventory before explicitly starting a new registration.",
  expired: "This 24-hour registration intent expired. An earlier request may have completed. Refresh the inventory before explicitly starting a new registration.",
  key_conflict: "This intent belongs to a different registration request. Retry the original name and category.",
  capacity: "The inventory has 50 browsers. Forget an unused inventory record before registering another browser.",
  recent_capacity: "The 200 recent-registration limit is reached. Wait for older 24-hour intents to expire, then retry. Forget does not bypass this limit.",
} as const;
export type DeviceErrorCode = keyof typeof DEVICE_MESSAGES;
export class DeviceError extends Error {
  constructor(readonly code: DeviceErrorCode) { super(DEVICE_MESSAGES[code]); }
}
