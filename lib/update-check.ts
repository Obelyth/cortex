/**
 * Update awareness — is a newer Cortex release published upstream?
 *
 * Asks api.github.com for the latest release tag and compares it against the
 * version this deployment was built from. Deliberately narrow egress: one
 * unauthenticated GET of public release metadata — a version string comes back,
 * and nothing about this deployment, its operator, or its corpus goes out. The
 * brain PAT never rides along: that token is scoped to the brain repo and has
 * no business on any other request.
 *
 * On any failure the answer is absence, not a guess. The console shows nothing
 * rather than an "up to date" it cannot prove.
 */

import pkg from "@/package.json";

// Updates ship from upstream main whoever runs this copy (README: Updating) —
// template copies and forks still measure themselves against Obelyth/cortex.
const RELEASES_API = "https://api.github.com/repos/Obelyth/cortex/releases/latest";
export const RELEASES_URL = "https://github.com/Obelyth/cortex/releases";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2500;

export type UpdateStatus = {
  /** The version this build is running, read from package.json at build time. */
  running: string;
  /** The newest published release, when the check succeeded; null is absence. */
  latest: string | null;
  /** True only when latest is known and strictly newer than running. */
  behind: boolean;
};

/**
 * Numeric dotted-version compare: negative when a < b, zero when equal,
 * positive when a > b. Missing segments count as zero, so "1.0" equals "1.0.0".
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Only a plain release tag counts. Anything else — a prerelease, a renamed
 * tag, an API shape change — parses to null and the check reports absence;
 * a version banner built from a tag this repo's release runbook never cuts
 * would be a claim with nothing behind it.
 */
export function parseReleaseTag(tag: unknown): string | null {
  if (typeof tag !== "string") return null;
  const m = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  return m ? m[1] : null;
}

// One probe per warm instance per TTL. The releases endpoint is unauthenticated
// (60 requests/hour/IP), and the console re-renders on every click — without
// this, browsing the console could spend the whole allowance on one question
// whose answer changes a few times a year.
let cached: { at: number; latest: string | null } | null = null;

/** Test seam: module state would otherwise leak between cases. */
export function resetUpdateCache(): void {
  cached = null;
}

export async function updateStatus(): Promise<UpdateStatus> {
  const running = pkg.version;
  if (!cached || Date.now() - cached.at > CACHE_TTL_MS) {
    let latest: string | null = null;
    try {
      const res = await fetch(RELEASES_API, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) latest = parseReleaseTag(((await res.json()) as { tag_name?: unknown })?.tag_name);
    } catch {
      /* network, timeout, or a non-JSON body — absence, and try again next TTL */
    }
    cached = { at: Date.now(), latest };
  }
  const { latest } = cached;
  return { running, latest, behind: latest !== null && compareVersions(latest, running) > 0 };
}
