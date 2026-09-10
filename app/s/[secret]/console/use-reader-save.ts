"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * One save path for the reader (S1), shared by every control that offers to change it: the
 * Overview select, the models table Settings and Ask render, and the Trends reader lens.
 *
 * All three had grown their own copy of the same lifecycle — cut this screen's segment off the
 * address bar, POST {defaultReader} to the gated settings/save route, refresh — and the copies
 * had already drifted apart in exactly the way duplicated request code does: Trends read the
 * failure body and said what went wrong, while the other two tested res.ok and dropped a failed
 * save on the floor, leaving the old reader on screen with nothing said. The route is a route
 * handler under the secret path rather than a server action, and the URL is derived from the
 * address bar so the secret never enters markup.
 */

/** The console root: everything up to and including the `/console` segment. Cutting the LAST
 *  segment against the tab table looked tidier and was wrong — the console also serves
 *  attention, proposals, readers and guide, none of which are tabs, so a control rendered on one
 *  of those would have posted to `…/attention/settings/save` and 404'd. The root is a fixed point
 *  of the route, so name it directly and nothing can fall out of a list. */
const ROOT = "/console";
export function consoleRoot(pathname: string): string {
  const i = pathname.indexOf(`${ROOT}/`);
  if (i !== -1) return pathname.slice(0, i + ROOT.length);
  let p = pathname;
  while (p.endsWith("/")) p = p.slice(0, -1);
  return p.endsWith(ROOT) ? p : pathname;
}

export interface ReaderSave {
  /** The write is in flight, or the refresh it triggered is. Controls disable on it. */
  pending: boolean;
  /** Why the last save failed, in the words the route gave — null when nothing has failed. */
  error: string | null;
  /** Writes the reader; resolves true when the store took it. */
  save: (model: string) => Promise<boolean>;
}

export function useReaderSave(): ReaderSave {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(model: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${consoleRoot(window.location.pathname)}/settings/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaultReader: model }),
      });
      if (res.ok) {
        startRefresh(() => router.refresh());
        return true;
      }
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(j?.error ?? `save failed · HTTP ${res.status}`);
      return false;
    } catch {
      setError("save failed · the console could not be reached");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { pending: busy || refreshing, error, save };
}
