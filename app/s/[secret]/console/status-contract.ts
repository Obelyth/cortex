import type { MastheadMode } from "./masthead";

export type ShellStatusState = "live" | "behind" | "mirror-off" | "mirror-unreachable" | "unavailable";

/** The complete status payload: operational identifiers only, never note bodies or upstream text. */
export interface ShellStatusDto {
  state: ShellStatusState;
  sha: string | null;
  commitUrl: string | null;
  checkedAt: string;
}

export interface ShellStatusView {
  mode: MastheadMode;
  sha: string;
  commitUrl: string | null;
  title: string;
}

export const STATUS_REFRESH_MS = 30_000;
const STATUS_STALE_MS = 45_000;
const STATES = new Set<ShellStatusState>(["live", "behind", "mirror-off", "mirror-unreachable", "unavailable"]);

export function unavailableStatus(checkedAt = new Date().toISOString()): ShellStatusDto {
  return { state: "unavailable", sha: null, commitUrl: null, checkedAt };
}

/** Validate the asynchronous HTTP result before a client is allowed to publish it as healthy. */
export function parseShellStatus(value: unknown): ShellStatusDto | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!STATES.has(row.state as ShellStatusState)) return null;
  if (typeof row.checkedAt !== "string" || !Number.isFinite(Date.parse(row.checkedAt))) return null;
  if (row.sha !== null && (typeof row.sha !== "string" || !/^[0-9a-f]{8}$/.test(row.sha))) return null;
  if (row.commitUrl !== null && (
    typeof row.commitUrl !== "string" ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/commit\/[0-9a-f]{40}$/.test(row.commitUrl)
  )) return null;
  if (row.state === "unavailable" ? row.sha !== null || row.commitUrl !== null : row.sha === null) return null;
  return {
    state: row.state as ShellStatusState,
    sha: row.sha as string | null,
    commitUrl: row.commitUrl as string | null,
    checkedAt: row.checkedAt,
  };
}

export function statusView(status: ShellStatusDto | null, now = Date.now()): ShellStatusView {
  if (!status) {
    return {
      mode: { text: "status checking", tone: "off" },
      sha: "",
      commitUrl: null,
      title: "status not checked yet",
    };
  }
  const checked = Date.parse(status.checkedAt);
  const title = `last checked ${status.checkedAt}`;
  if (!Number.isFinite(checked) || checked > now + 5_000 || now - checked > STATUS_STALE_MS || status.state === "unavailable") {
    return {
      mode: { text: "status unavailable", tone: "warn" },
      sha: "",
      commitUrl: null,
      title: `status unavailable · ${title}`,
    };
  }
  const mode: MastheadMode = status.state === "live"
    ? { text: "live · mirror in sync", tone: "live" }
    : status.state === "behind"
      ? { text: "healing · mirror behind", tone: "warn" }
      : status.state === "mirror-unreachable"
        ? { text: "mirror unreachable", tone: "warn" }
        : { text: "mirror off", tone: "off" };
  return { mode, sha: status.sha ?? "", commitUrl: status.commitUrl, title };
}
