import { branch, gh, repo } from "@/lib/github";
import { mirrorStore } from "@/lib/mirror";
import { unavailableStatus, type ShellStatusDto, type ShellStatusState } from "./status-contract";

const FULL_SHA = /^[0-9a-f]{40}$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

async function gitHead(): Promise<{ sha: string; repository: string }> {
  const repository = repo();
  if (!REPOSITORY.test(repository)) throw new Error("status repository is unavailable");
  const res = await gh(`/repos/${repository}/commits/${branch()}`);
  if (!res.ok) throw new Error("status head is unavailable");
  const value = await res.json() as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("status head is unavailable");
  const sha = (value as Record<string, unknown>).sha;
  if (typeof sha !== "string" || !FULL_SHA.test(sha)) throw new Error("status head is unavailable");
  return { sha: sha.toLowerCase(), repository };
}

async function mirrorHead(): Promise<{ kind: "off" | "unreachable" | "head"; sha?: string }> {
  const store = mirrorStore();
  if (!store) return { kind: "off" };
  try {
    const sha = await store.head();
    if (sha === null || sha === "") return { kind: "head", sha: "" };
    if (!FULL_SHA.test(sha)) return { kind: "unreachable" };
    return { kind: "head", sha: sha.toLowerCase() };
  } catch {
    return { kind: "unreachable" };
  }
}

/** Operational heads only. This result is never provenance for a separately loaded note body. */
export async function readShellStatus(): Promise<ShellStatusDto> {
  const mirror = mirrorHead();
  let git: Awaited<ReturnType<typeof gitHead>>;
  try {
    git = await gitHead();
  } catch {
    return unavailableStatus();
  }
  const stored = await mirror;
  const state: ShellStatusState = stored.kind === "off"
    ? "mirror-off"
    : stored.kind === "unreachable"
      ? "mirror-unreachable"
      : stored.sha === git.sha
        ? "live"
        : "behind";
  return {
    state,
    sha: git.sha.slice(0, 8),
    commitUrl: `https://github.com/${git.repository}/commit/${git.sha}`,
    checkedAt: new Date().toISOString(),
  };
}
