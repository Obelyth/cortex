import type { HandoffPreview } from "./handoff";
import { normaliseProject } from "./project";
import { consoleRoutePath } from "../app/s/[secret]/console/route-path";

const HANDOFF_TIMEOUT_MS = 15_000;
const PROJECTS_TIMEOUT_MS = 12_000;
const MAX_PROJECTS = 500;
const MAX_PROJECT_LENGTH = 80;
const HANDOFF_PIECE_KINDS = new Set(["page", "bubble", "log", "pinned", "neighbour"]);
const HANDOFF_EXCLUSIONS = new Set(["budget", "log-share"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function handoffPiece(value: unknown): boolean {
  if (!record(value)) return false;
  return typeof value.kind === "string" && HANDOFF_PIECE_KINDS.has(value.kind)
    && typeof value.label === "string"
    && typeof value.why === "string"
    && finite(value.bytes) && value.bytes >= 0
    && typeof value.included === "boolean"
    && (value.excludedBy === undefined || (typeof value.excludedBy === "string" && HANDOFF_EXCLUSIONS.has(value.excludedBy)));
}

function rankedExclusion(value: unknown): boolean {
  return record(value)
    && typeof value.path === "string"
    && typeof value.why === "string"
    && finite(value.score);
}

function handoffPreview(value: unknown): value is HandoffPreview {
  if (!record(value)) return false;
  if (typeof value.project !== "string" || typeof value.pagePath !== "string" || typeof value.sha !== "string") return false;
  if (!finite(value.budgetBytes) || value.budgetBytes < 0 || typeof value.coverage !== "string") return false;
  if (!Array.isArray(value.pieces) || !value.pieces.every(handoffPiece)) return false;
  if (!Array.isArray(value.rankExcluded) || !value.rankExcluded.every(rankedExclusion)) return false;
  if (!finite(value.rankExcludedTotal) || !Number.isInteger(value.rankExcludedTotal) || value.rankExcludedTotal < value.rankExcluded.length) return false;
  if (!Array.isArray(value.warnings) || !value.warnings.every(warning => typeof warning === "string")) return false;
  return (value.bubble === "read" || value.bubble === "absent" || value.bubble === "failed")
    && (value.graph === "on" || value.graph === "off");
}

function consoleRoot(pathname: string): string {
  const route = consoleRoutePath(pathname);
  if (!route) throw new Error("Open working context from the Cortex dashboard.");
  return route.root;
}

function boundedSignal(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function requestHandoffPreview(
  pathname: string,
  project: string,
  request: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<HandoffPreview> {
  const canonical = normaliseProject(project);
  if (!canonical) throw new Error("Select a project before previewing context.");

  let response: Response;
  try {
    response = await request(`${consoleRoot(pathname)}/heat/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: canonical }),
      signal: boundedSignal(HANDOFF_TIMEOUT_MS, signal),
    });
  } catch {
    if (signal?.aborted) throw new Error("Handoff preview was cancelled.");
    throw new Error("Handoff preview is unavailable. Retry when the server returns.");
  }

  if (!response.ok) throw new Error(`preview failed (HTTP ${response.status})`);
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("malformed handoff preview: response was not valid JSON");
  }
  if (!handoffPreview(data)) throw new Error("malformed handoff preview: response shape was invalid");
  if (data.project !== canonical) throw new Error("malformed handoff preview: project did not match request");
  return data;
}

export interface ProjectOptions {
  projects: string[];
  truncated: boolean;
}

function projectOptions(value: unknown): value is ProjectOptions {
  if (!record(value) || Object.keys(value).length !== 2) return false;
  if (!Array.isArray(value.projects) || value.projects.length > MAX_PROJECTS || typeof value.truncated !== "boolean") return false;
  let previous: string | null = null;
  const seen = new Set<string>();
  for (const project of value.projects) {
    if (typeof project !== "string" || project.length === 0 || project.length > MAX_PROJECT_LENGTH) return false;
    if (normaliseProject(project) !== project || seen.has(project) || (previous !== null && previous > project)) return false;
    seen.add(project);
    previous = project;
  }
  return true;
}

export async function readProjectOptions(pathname: string): Promise<ProjectOptions> {
  let response: Response;
  try {
    response = await fetch(`${consoleRoot(pathname)}/working-state/projects`, {
      cache: "no-store",
      signal: boundedSignal(PROJECTS_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Project options are unavailable. Retry when the server returns.");
  }
  if (!response.ok) throw new Error(`Project options are unavailable (HTTP ${response.status}).`);

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("Project options returned an invalid response.");
  }
  if (!projectOptions(data)) throw new Error("Project options returned an invalid response.");
  return data;
}
