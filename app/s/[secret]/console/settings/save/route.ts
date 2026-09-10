import { readSettings, writeSettings } from "@/lib/settings";
import { bad, gateConsolePost, requireSecretOnly } from "../../post-gate";
import { readGuestPolicy, writeGuestPolicy, isScopeEntry,GuestPolicyConflict } from "@/lib/guest";
import { applyLearningPatch, readLearning, writeLearning } from "@/lib/learning";
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

type SaveFamily = "reader" | "learning" | "guest";

function freshJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store, max-age=0" },
  });
}

/**
 * A narrowly scoped, independently gated read used only when the browser cannot validate a
 * save response. It returns one minimal family DTO and only from an authoritative store read;
 * fallback defaults are never offered as proof that a write completed.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ secret: string }> },
): Promise<Response> {
  const gate = await requireSecretOnly(req, ctx.params);
  if ("deny" in gate) return gate.deny;
  const family = new URL(req.url).searchParams.get("family") as SaveFamily | null;

  if (family === "reader") {
    const state = await readSettings();
    if (state.source !== "store") {
      return freshJson({ error: "the current reader settings are unavailable" }, 503);
    }
    return freshJson({
      family,
      current: {
        defaultReader: state.defaultReader,
        disabledProviders: state.disabledProviders,
      },
    });
  }

  if (family === "learning") {
    const state = await readLearning();
    if (state.source !== "store") {
      return freshJson({ error: "the current learning settings are unavailable" }, 503);
    }
    return freshJson({ family, current: state.selection });
  }

  if (family === "guest") {
    const state = await readGuestPolicy();
    if (state.source !== "store") {
      return freshJson({ error: "the current guest policy is unavailable" }, 503);
    }
    return freshJson({
      family,
      current: {
        scope: state.scope,
        citations: state.citations,
        dailyAsks: state.dailyAsks,
        maxK: state.maxK,
        revision:state.revision,
      },
    });
  }

  return freshJson({ error: "family must be reader, learning, or guest" }, 400);
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ secret: string }> }
): Promise<Response> {
  const gate = await gateConsolePost(req, ctx.params);
  if ("deny" in gate) return gate.deny;
  const b = gate.body;

  const readerFields = ["defaultReader", "disabledProviders"] as const;
  const known = new Set<string>([...readerFields, "learning", "guest"]);
  const unknown = Object.keys(b).filter((key) => !known.has(key));
  if (unknown.length) return bad("unknown settings field");
  const families = [
    ...(readerFields.some((key) => key in b) ? ["reader" as const] : []),
    ...("learning" in b ? ["learning" as const] : []),
    ...("guest" in b ? ["guest" as const] : []),
  ];
  if (families.length !== 1) {
    return bad("send exactly one settings family per request: reader, learning, or guest");
  }

  // Learning knobs ride the same endpoint, as their own patch — same isolation rule as guest
  // below: a write to one settings family can never silently rewrite another. The screen sends
  // only the knob the click changed; applyLearningPatch validates it against the bounds and a
  // read-modify-write folds it into the current selection.
  if ("learning" in b) {
    const l = b.learning;
    if (l === null || typeof l !== "object" || Array.isArray(l)) return bad("learning must be an object");
    const current = await readLearning();
    // Same guard as the guest block: a RMW must never merge onto a fallback. readLearning()
    // degrades to an EMPTY selection when the store cannot answer, so writing now would erase
    // every previously-set knob under an ok:true reply.
    if (current.source !== "store") {
      return bad(
        "the current learning settings could not be read, so this change was not saved — " +
          "writing now would overwrite your settings with defaults. Try again.",
        503
      );
    }
    let next;
    try {
      next = applyLearningPatch(current.selection, l as Record<string, unknown>);
    } catch (e) {
      // A field that fails validation is a bad request, not a conflict — the bounds are stated
      // on the screen and enforced here in the same words.
      return bad(e instanceof Error ? e.message : String(e));
    }
    try {
      await writeLearning(next);
      return Response.json({ ok: true, learning: next });
    } catch {
      return bad("the learning settings store did not confirm the change. Try again.", 503);
    }
  }

  // Guest policy rides the same endpoint, as its own patch. Kept separate from the reader
  // settings above so a write to one can never silently rewrite the other — these two control
  // very different things, and only one of them decides what a stranger can see.
  if ("guest" in b) {
    const g = b.guest;
    if (g === null || typeof g !== "object" || Array.isArray(g)) return bad("guest must be an object");
    const p = g as Record<string, unknown>;
    if(Object.keys(p).some(k=>!["scope","citations","dailyAsks","maxK","expectedRevision"].includes(k)))return bad("unknown guest policy field");
    const current = await readGuestPolicy();
    // A read-modify-write must never merge onto a fallback. readGuestPolicy() fails OPEN to
    // GUEST_DEFAULTS, so without this check a 1.5s Upstash blip while the operator ticked one
    // checkbox would persist the defaults as if he had chosen them — widening a narrowed scope
    // back to projects/ and a budget of 5 back to 50, durably, under an ok:true reply.
    if (current.source !== "store") {
      return bad(
        "the current guest policy could not be read, so this change was not saved — " +
          "writing now would overwrite your settings with defaults. Try again.",
        503
      );
    }
    const next = {
      scope: current.scope,
      citations: current.citations,
      dailyAsks: current.dailyAsks,
      maxK: current.maxK,
    };
    if ("scope" in p) {
      if (!Array.isArray(p.scope)) return bad("guest.scope must be an array");
      if (p.scope.length === 0) return bad("guest.scope must include at least one allowed path");
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
    if(typeof p.expectedRevision!=="string"||!/^[a-f0-9]{40}$/.test(p.expectedRevision))return bad("current guest policy revision required",409);
    try {
      const saved=await writeGuestPolicy(next,p.expectedRevision);
      return freshJson({ ok: true, guest: saved });
    } catch(error) {
      if(error instanceof GuestPolicyConflict)return freshJson({code:"conflict",error:error.message,family:"guest",current:error.current},409);
      return bad("the guest policy store did not confirm the change. Try again.", 503);
    }
  }

  // Validate the requested reader fields before touching the store, then merge only after an
  // authoritative read. A malformed request remains a 400 even during a store incident.
  let requestedReader: ReaderModel | null | undefined;
  if ("defaultReader" in b) {
    const v = b.defaultReader;
    if (v === null || v === "") {
      requestedReader = null;
    } else if (typeof v === "string" && providerOf(v)) {
      requestedReader = v as ReaderModel;
    } else {
      return bad("not an allowed reader model");
    }
  }

  let requestedProviders: Provider[] | undefined;
  if ("disabledProviders" in b) {
    const v = b.disabledProviders;
    if (!Array.isArray(v)) return bad("disabledProviders must be an array");
    const out: Provider[] = [];
    for (const p of v) {
      if (typeof p !== "string" || !(PROVIDERS as readonly string[]).includes(p)) {
        return bad("not a known provider");
      }
      if (!out.includes(p as Provider)) out.push(p as Provider);
    }
    requestedProviders = out;
  }

  // Reader changes are read-modify-write patches. Route the family before this read so a
  // learning or guest request cannot wait on a store it does not use, and never merge a patch
  // onto the fallback defaults returned when the reader store could not be read.
  const current = await readSettings();
  if (current.source !== "store") {
    return bad(
      "the current reader settings could not be read, so this change was not saved — " +
        "writing now would overwrite your settings with defaults. Try again.",
      503
    );
  }
  // A stale tab changes only the field it sent, never its old copy of the other field.
  const defaultReader = requestedReader === undefined ? current.defaultReader : requestedReader;
  const disabledProviders = requestedProviders ?? current.disabledProviders;

  if (defaultReader) {
    const provider = providerOf(defaultReader)!;
    if (disabledProviders.includes(provider)) {
      return bad(`${defaultReader} cannot be the default while ${provider} is off — change the default first`);
    }
  }

  try {
    const next = await writeSettings({ defaultReader, disabledProviders });
    return Response.json(next);
  } catch {
    // Every local validation refusal has already been allowlisted above. A later failure is the
    // store/transport boundary; its provider body may contain commands or credentials.
    return bad("the reader settings store did not confirm the change. Try again.", 503);
  }
}
