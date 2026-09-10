export type OpsActionResponse =
  | { outcome: "confirmed"; receipt: number | null; opened: string | null }
  | { outcome: "failed"; message: string }
  | { outcome: "uncertain"; message: string };

const receipt = (value: unknown) => value === null || (Number.isSafeInteger(value) && Number(value) > 0);
const safeLink = (value: unknown) => {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" ? value : undefined; } catch { return undefined; }
};

/** Validate both successful and failed action responses before publishing their claims. */
export function parseOpsActionResponse(status: number, value: unknown): OpsActionResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return status >= 500 || status < 400
    ? { outcome: "uncertain", message: "Outcome uncertain · recheck receipts before retrying" }
    : { outcome: "failed", message: `Request refused (${status})` };
  const row = value as Record<string, unknown>;
  if (status >= 200 && status < 300) {
    const opened = safeLink(row.opened);
    if (row.ok === true && receipt(row.receipt) && opened !== undefined) return { outcome: "confirmed", receipt: row.receipt as number | null, opened };
    return { outcome: "uncertain", message: "Outcome uncertain · recheck receipts before retrying" };
  }
  const keptReceipt = receipt(row.receipt) && row.receipt !== null ? ` · receipt ${row.receipt}` : "";
  if (status >= 500 || keptReceipt) return { outcome: "uncertain", message: `Outcome uncertain${keptReceipt} · recheck receipts before retrying` };
  const message = typeof row.error === "string" && row.error.length <= 300 ? row.error : `Request refused (${status})`;
  return { outcome: "failed", message };
}
