import {
  parseSettingsReceipt,
  parseSettingsSnapshot,
  type SettingsFamily as SaveFamily,
} from "./response-contract";

type JsonObject = Record<string, unknown>;

export type SettingsWriteOutcome =
  | { status: "confirmed"; json: JsonObject }
  | { status: "reconciled"; json: JsonObject; error: string }
  | { status: "conflict"; json:JsonObject; error:string }
  | { status: "refused" | "unconfirmed"; error: string };

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const UNCONFIRMED_MATCH =
  "write completion unconfirmed — current settings match the requested change after a fresh read";
const UNCONFIRMED_MISMATCH =
  "write completion unconfirmed — current settings do not confirm the requested change";

function record(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, i) => value === right[i]);
  }
  return left === right;
}

function familyOf(body: JsonObject): SaveFamily | null {
  const families: SaveFamily[] = [];
  if ("defaultReader" in body || "disabledProviders" in body) families.push("reader");
  if ("learning" in body) families.push("learning");
  if ("guest" in body) families.push("guest");
  return families.length === 1 ? families[0] : null;
}

function patchMatches(family: SaveFamily, body: JsonObject, current: JsonObject): boolean {
  if (family === "reader") {
    for (const field of ["defaultReader", "disabledProviders"] as const) {
      if (field in body && !sameValue(body[field], current[field])) return false;
    }
    return true;
  }

  const patch = body[family];
  if (!record(patch)) return false;
  for (const [field, wanted] of Object.entries(patch)) {
    if(family==="guest"&&field==="expectedRevision")continue;
    // A null learning patch removes the override from the stored selection.
    if (family === "learning" && wanted === null) {
      if (field in current) return false;
    } else if (!sameValue(wanted, current[field])) {
      return false;
    }
  }
  return true;
}

function validReceipt(family: SaveFamily, body: JsonObject, value: unknown): boolean {
  const current = parseSettingsReceipt(family, value);
  return current !== null && patchMatches(family, body, current);
}

async function jsonObject(response: Response): Promise<JsonObject | null> {
  const value = await response.json().catch(() => null);
  return record(value) ? value : null;
}

async function reconcile(
  url: string,
  family: SaveFamily,
  body: JsonObject,
  fetcher: FetchLike,
): Promise<SettingsWriteOutcome> {
  try {
    const response = await fetcher(`${url}?family=${family}`, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    const json = await jsonObject(response);
    const current = json === null ? null : parseSettingsSnapshot(family, json);
    if (response.ok && json !== null && current !== null && patchMatches(family, body, current)) {
      return { status: "reconciled", json, error: UNCONFIRMED_MATCH };
    }
  } catch {
    // A failed read supplies no new fact. Keep the completion state explicitly uncertain.
  }
  return { status: "unconfirmed", error: UNCONFIRMED_MISMATCH };
}

/**
 * Send one Settings-family write and publish success only for a matching family receipt.
 * When the response is lost or malformed, a separately gated no-store read reports current
 * state. A match is useful, but cannot prove which request committed it, so it remains an
 * explicit unconfirmed-completion result rather than a saved receipt.
 */
export async function performSettingsWrite(
  url: string,
  body: JsonObject,
  fetcher: FetchLike = fetch,
): Promise<SettingsWriteOutcome> {
  const family = familyOf(body);
  if (!family) {
    return { status: "refused", error: "the settings write family could not be validated" };
  }

  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return reconcile(url, family, body, fetcher);
  }

  const json = await jsonObject(response);
  if(family==="guest"&&response.status===409&&json?.code==="conflict"){
    const current=parseSettingsSnapshot("guest",{family:"guest",current:json.current});
    if(current)return{status:"conflict",json:{current},error:"Guest policy changed in another tab. Current policy loaded; review it before another edit."};
  }
  if (response.ok && json !== null && validReceipt(family, body, json)) {
    return { status: "confirmed", json };
  }

  // A validation refusal happens before the write. A dependency/server failure, successful
  // response with the wrong family, or malformed response cannot prove completion.
  if (!response.ok && response.status < 500) {
    const error = typeof json?.error === "string"
      ? json.error
      : `the write was refused (${response.status})`;
    return { status: "refused", error };
  }
  return reconcile(url, family, body, fetcher);
}
