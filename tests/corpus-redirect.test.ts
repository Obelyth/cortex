import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/s/[secret]/console/corpus/route";

/**
 * The Notes screen folded into Ask (v2, 2026-09-05). `corpus?note=` keeps working for every
 * bookmark, old notice and the screens that still link it: a 308 to `ask?note=`, relative, so
 * the secret rides along from the request and never enters anything the handler writes.
 */
const SECRET = "a".repeat(64);

function get(path: string, secret = SECRET) {
  const req = new Request(`https://cortex.test/s/${secret}/console/${path}`);
  return GET(req, { params: Promise.resolve({ secret }) });
}

afterEach(() => vi.unstubAllEnvs());

describe("GET console/corpus", () => {
  it("sends a proven secret to ask?note= with the note kept, relative and 308", async () => {
    vi.stubEnv("CONNECTOR_PATH_SECRET", SECRET);
    const res = await get("corpus?note=notes%2Fexample-1.md");
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("ask?note=notes%2Fexample-1.md");
    expect(await res.text()).toBe("");
  });

  it("drops the query when there is no note, and climbs one step from a trailing slash", async () => {
    vi.stubEnv("CONNECTOR_PATH_SECRET", SECRET);
    expect((await get("corpus")).headers.get("location")).toBe("ask");
    expect((await get("corpus/?note=profile.md")).headers.get("location")).toBe("../ask?note=profile.md");
  });

  it("answers a wrong or missing secret with the same empty 404 as every other gate", async () => {
    vi.stubEnv("CONNECTOR_PATH_SECRET", SECRET);
    const wrong = await get("corpus?note=profile.md", "b".repeat(64));
    expect(wrong.status).toBe(404);
    expect(wrong.headers.get("location")).toBeNull();
    vi.stubEnv("CONNECTOR_PATH_SECRET", "");
    expect((await get("corpus")).status).toBe(404);
  });

  it("never puts the secret in the Location", async () => {
    vi.stubEnv("CONNECTOR_PATH_SECRET", SECRET);
    const res = await get("corpus?note=profile.md");
    expect(res.headers.get("location")).not.toContain(SECRET);
  });
});
