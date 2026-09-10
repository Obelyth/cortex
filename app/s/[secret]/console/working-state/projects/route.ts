import { loadCorpus } from "@/lib/corpus";
import { normaliseProject } from "@/lib/project";
import { redact } from "@/lib/redact";
import { requireSecretOnly } from "../../post-gate";

export const dynamic = "force-dynamic";
const MAX_PROJECTS = 500;
const MAX_PROJECT_LENGTH = 80;
type Context = { params: Promise<{ secret: string }> };

function reply(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function privateResponse(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: Request, context: Context): Promise<Response> {
  const auth = await requireSecretOnly(request, context.params);
  if ("deny" in auth) return privateResponse(auth.deny);

  try {
    const corpus = await loadCorpus();
    const projects = new Set<string>();
    for (const path of corpus.files.keys()) {
      if (!/^projects\/[^/]+\.md$/i.test(path)) continue;
      // Vendor credentials can have case-sensitive prefixes that normalization would erase.
      if (redact(path) !== path) continue;
      const project = normaliseProject(path);
      if (!project || project.length > MAX_PROJECT_LENGTH || redact(project) !== project) continue;
      projects.add(project);
    }
    const sorted = [...projects].sort();
    return reply({ projects: sorted.slice(0, MAX_PROJECTS), truncated: sorted.length > MAX_PROJECTS });
  } catch {
    return reply({ error: "project options unavailable" }, 503);
  }
}
