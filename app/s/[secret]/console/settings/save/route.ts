import { safeEqualStrings } from "@/lib/auth";
import { readSettings, writeSettings } from "@/lib/settings";
import { readGuestPolicy, writeGuestPolicy, isScopeEntry } from "@/lib/guest";
import { PROVIDERS, providerOf, type Provider, type ReaderModel } from "@/lib/reader";

/**
 * The console's one write endpoint.
 *
 * It lives under the same secret path as the screens, and the readers screen reaches it with a
 * RELATIVE fetch — so the browser supplies the secret from the address bar and it never appears
 * in markup, exactly like the tab links. That is the whole reason this is a route handler and
 * not a server action: an action's id is baked into a public /_next/static chunk, so an action
 * that mutated settings without re-proving the secret would be a control anyone who fetched the
 * bundle could reach. Here the secret is checked on every request, against the same
 * constant-time comparison the front door uses.
 *
 * A wrong secret gets the same empty 404 as every other gate here: nothing lives at this path.
 */
export const dynamic = "force-dynamic";

function bad(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ secret: string }> }
): Promise<Response> {
  const { secret } = await ctx.params;
  const expected = process.env.CONNECTOR_PATH_SECRET;
  if (!expected || !safeEqualStrings(secret, expected)) {
    return new Response(null, { status: 404 });
  }

  // Same-origin only. There is no cookie or header auth to ride here — the secret is in the
  // path — so this is not the CSRF barrier, it is the cheap check that a form on another site
  // never reaches a control that changes where the corpus is sent.
  //
  // Matched against the Host header OR the request URL, because neither is reliably both: Host
  // is absent on a synthesised Request, and req.url behind a custom domain can carry the
  // deployment host rather than the one the browser typed. Requiring both to agree would refuse
  // legitimate writes; accepting either still refuses every genuinely cross-site origin.
  const origin = req.headers.get("origin");
  if (origin) {
    let from: string;
    try {
      from = new URL(origin).host;
    } catch {
      return bad("bad origin", 403);
    }
    const mine = new Set([req.headers.get("host"), new URL(req.url).host].filter(Boolean));
    if (!mine.has(from)) return bad("cross-origin request refused", 403);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("body must be JSON");
  }
  // Arrays are objects; an array body carries neither field and would otherwise sail through as
  // a no-op write that reports success.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return bad("body must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  const current = await readSettings();

  // A partial patch, so the two controls never overwrite each other: the screen sends only the
  // field the click changed, and a stale tab cannot revert a switch it never showed.
  let defaultReader: ReaderModel | null = current.defaultReader;
  if ("defaultReader" in b) {
    const v = b.defaultReader;
    if (v === null || v === "") {
      defaultReader = null;
    } else if (typeof v === "string" && providerOf(v)) {
      defaultReader = v as ReaderModel;
    } else {
      return bad(`"${String(v)}" is not an allowed reader model`);
    }
  }

  let disabledProviders: Provider[] = current.disabledProviders;
  if ("disabledProviders" in b) {
    const v = b.disabledProviders;
    if (!Array.isArray(v)) return bad("disabledProviders must be an array");
    const out: Provider[] = [];
    for (const p of v) {
      if (typeof p !== "string" || !(PROVIDERS as readonly string[]).includes(p)) {
        return bad(`"${String(p)}" is not a known provider`);
      }
      if (!out.includes(p as Provider)) out.push(p as Provider);
    }
    disabledProviders = out;
  }

  // Guest policy rides the same endpoint, as its own patch. Kept separate from the reader
  // settings above so a write to one can never silently rewrite the other — these two control
  // very different things, and only one of them decides what a stranger can see.
  if ("guest" in b) {
    const g = b.guest;
    if (g === null || typeof g !== "object" || Array.isArray(g)) return bad("guest must be an object");
    const p = g as Record<string, unknown>;
    const current = await readGuestPolicy();
    const next = {
      scope: current.scope,
      citations: current.citations,
      dailyAsks: current.dailyAsks,
      maxK: current.maxK,
    };
    if ("scope" in p) {
      if (!Array.isArray(p.scope)) return bad("guest.scope must be an array");
      if (!p.scope.every(isScopeEntry)) return bad("guest.scope contains a path that is not allowed");
      next.scope = p.scope as string[];
    }
    if ("citations" in p) next.citations = p.citations === true;
    if ("dailyAsks" in p) {
      if (typeof p.dailyAsks !== "number" || p.dailyAsks < 1) return bad("guest.dailyAsks must be a positive number");
      next.dailyAsks = Math.min(Math.floor(p.dailyAsks), 1000);
    }
    if ("maxK" in p) {
      if (typeof p.maxK !== "number" || p.maxK < 1) return bad("guest.maxK must be a positive number");
      next.maxK = Math.min(Math.floor(p.maxK), 40);
    }
    try {
      await writeGuestPolicy(next);
      return Response.json({ ok: true, guest: next });
    } catch (e) {
      return bad(e instanceof Error ? e.message : String(e), 409);
    }
  }

  try {
    const next = await writeSettings({ defaultReader, disabledProviders });
    return Response.json(next);
  } catch (e) {
    // writeSettings refuses contradictions (a default whose provider this write turns off) and
    // an unconfigured store. Both are the operator's to resolve, and both read as sentences.
    return bad(e instanceof Error ? e.message : String(e), 409);
  }
}
