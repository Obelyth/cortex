// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigurationCapability, ConfigurationRecord } from "../lib/console-configuration-contract";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), usePathname: () => "/s/console/console/settings" }));

const { ConfigurationEditor } = await import("../app/s/[secret]/console/settings/configuration-panel");

const capability = "reader-openai" as const;
const fullTarget = (target: "production" | "preview") => `vercel:prj_fixture:personal:${target}`;
const keyA = "0199b3b0-0000-7000-8000-000000000001";
const keyB = "0199b3b0-0000-7000-8000-000000000002";

function receipt(overrides: Partial<ConfigurationRecord> = {}): ConfigurationRecord {
  return {
    capability,
    target: fullTarget("production"),
    revision: 0,
    status: "running",
    requestKey: keyA,
    result: null,
    acknowledged: false,
    updatedAt: "2026-09-08T23:00:00.000Z",
    ...overrides,
  };
}

function view(records: ConfigurationRecord[] = [], available = true) {
  const configured = { configured: true, missing: [] as string[] };
  const unknown = { state: "unknown" as const, detail: "not probed on this page" };
  return {
    adapter: { configured: available, projectId: "prj_fixture", teamId: null },
    store: "ready" as const,
    records,
    ingressReady: available,
    presence: {
      notes: configured, "reader-anthropic": configured, "reader-openai": configured,
      "reader-google": configured, mirror: configured, cache: configured, alerts: configured,
    },
    evidence: {
      notes: unknown, "reader-anthropic": unknown, "reader-openai": unknown,
      "reader-google": unknown, mirror: unknown, cache: unknown, alerts: unknown,
    },
  };
}

let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(records: ConfigurationRecord[] = [], available = true, selected: ConfigurationCapability = capability): Promise<void> {
  await act(async () => { root.render(createElement(ConfigurationEditor, { capability: selected, initialView: view(records, available) })); });
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  if (!found) throw new Error(`missing button ${label}`);
  return found as HTMLButtonElement;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function enter(value: string, index = 0): Promise<void> {
  const input = host.querySelectorAll("input")[index] as HTMLInputElement | undefined;
  if (!input) throw new Error("missing secret input");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (!setter) throw new Error("missing input value setter");
    setter.call(input, value);
    input.dispatchEvent(new window.InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    await Promise.resolve();
  });
}

function status(records: ConfigurationRecord[]): Response {
  return Response.json({ adapter: { configured: true, projectId: "prj_fixture", teamId: null }, records });
}

describe("mounted configuration recovery lifecycle", () => {
  it("blocks an incomplete alert group locally and points each required error to its field", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await render([], true, "alerts");
    await click("Save provider environment");
    expect(fetcher).not.toHaveBeenCalled();
    const inputs = [...host.querySelectorAll("input")];
    expect(inputs.map((input) => input.name)).toEqual(["RESEND_API_KEY", "OPS_ALERT_TO", "OPS_ALERT_FROM"]);
    for (const input of inputs) {
      expect(input.getAttribute("aria-invalid")).toBe("true");
      const error = document.getElementById(input.getAttribute("aria-errormessage")!);
      expect(error?.textContent).toContain(input.name);
      expect(error?.textContent).toMatch(/required/i);
    }
    expect(document.activeElement).toBe(inputs[0]);
    await enter("synthetic-resend-key");
    expect(inputs[0].getAttribute("aria-invalid")).not.toBe("true");
    await click("Discard draft");
    expect(inputs.every((input) => input.value === "")).toBe(true);
    expect(host.querySelector('[aria-invalid="true"]')).toBeNull();
  });

  it.each([
    ["notes", ["https://github.com/fixture/brain", "synthetic-token"], "BRAIN_REPO", /owner\/repository/],
    ["mirror", ["http://project.example", "synthetic-key"], "SUPABASE_URL", /HTTPS/],
    ["cache", ["https://user:password@cache.example", "synthetic-token"], "KV_REST_API_URL", /HTTPS/],
    ["alerts", ["synthetic-key", "Resend Contacts", "Cortex <alerts@example.com>"], "OPS_ALERT_TO", /email/],
    ["alerts", ["synthetic-key", "owner@example.com", "OPS_ALERTS_FROM"], "OPS_ALERT_FROM", /email/],
    ["reader-openai", ["\t"], "OPENAI_API_KEY", /required/i],
    ["reader-openai", ["synthetic\u007fkey"], "OPENAI_API_KEY", /single line/i],
  ] as const)("blocks malformed %s configuration before creating a save request", async (selected, values, field, message) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await render([], true, selected);
    for (const [index, value] of values.entries()) await enter(value, index);
    await click("Save provider environment");
    expect(fetcher).not.toHaveBeenCalled();
    const input = host.querySelector(`[name="${field}"]`) as HTMLInputElement;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(input.getAttribute("aria-errormessage")!)?.textContent).toMatch(message);
    expect(host.textContent).not.toContain("synthetic-key");
    expect(host.textContent).not.toContain("Retry this same save");
  });

  it("saves the exact alert field names and clears their values only after a matching finished receipt", async () => {
    const posts: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posts.push(body);
      return Response.json({ record: receipt({ capability: "alerts", requestKey: String(body.requestKey), revision: 1, status: "finished", result: { state: "saved-pending-deployment", accepted: ["RESEND_API_KEY", "OPS_ALERT_TO", "OPS_ALERT_FROM"], failed: [] } }) });
    }));
    await render([], true, "alerts");
    await enter("synthetic-resend-key", 0);
    await enter("owner@example.com", 1);
    await enter("Cortex <alerts@example.com>", 2);
    await click("Save provider environment");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ action: "save", capability: "alerts", target: "production", values: {
      RESEND_API_KEY: "synthetic-resend-key", OPS_ALERT_TO: "owner@example.com", OPS_ALERT_FROM: "Cortex <alerts@example.com>",
    } });
    expect([...host.querySelectorAll("input")].every((input) => input.value === "")).toBe(true);
    expect(host.textContent).toContain("Deployment is still pending");
    expect(host.textContent).not.toContain("synthetic-resend-key");
  });

  it("retries an unresolved immutable save despite a later blank draft without clearing that newer edit", async () => {
    const posts: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posts.push(body);
      if (posts.length === 1) throw new TypeError("lost reply");
      return Response.json({ record: receipt({ requestKey: String(body.requestKey), revision: 1, status: "finished", result: { state: "saved-pending-deployment", accepted: ["OPENAI_API_KEY"], failed: [] } }) });
    }));
    await render();
    await enter("synthetic-original-key");
    await click("Save provider environment");
    await enter("");
    await click("Retry this same save");
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect((host.querySelector("input") as HTMLInputElement).value).toBe("");
    expect(host.querySelector('[aria-invalid="true"]')).toBeNull();
  });

  it("offers explicit fresh start after exact-missing recovery without automatic resend or losing the draft",async()=>{
    const posts:any[]=[];
    vi.stubGlobal("fetch",vi.fn(async(_input:unknown,init?:RequestInit)=>{
      if(init?.method==="POST"){posts.push(JSON.parse(String(init.body)));throw new TypeError("synthetic lost response");}
      return status([]);
    }));
    await render();await enter("preserved-synthetic-value");await click("Save provider environment");await click("Refresh save receipt");
    expect(posts).toHaveLength(1);expect((host.querySelector("input") as HTMLInputElement).value).toBe("preserved-synthetic-value");
    await click("Start fresh request");expect(posts).toHaveLength(1);
    await click("Save provider environment");expect(posts).toHaveLength(2);expect(posts[1].requestKey).not.toBe(posts[0].requestKey);
    expect(posts[1].values).toEqual(posts[0].values);
  });
  it("recovers finished A behind current B, preserves a newer edit, then saves with B's revision and a fresh key", async () => {
    const posts: Array<Record<string, unknown>> = [];
    let firstKey = "";
    const oldFinished = () => receipt({ requestKey: firstKey, revision: 1, status: "finished", result: { state: "saved-pending-deployment", accepted: ["OPENAI_API_KEY"], failed: [] } });
    const currentB = receipt({ requestKey: keyB, revision: 2, status: "finished", result: { state: "saved-pending-deployment", accepted: ["OPENAI_API_KEY"], failed: [] } });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "https://console.invalid");
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        if (posts.length === 1) { firstKey = String(body.requestKey); throw new TypeError("lost reply"); }
        return Response.json({ record: receipt({ requestKey: String(body.requestKey), revision: 3, status: "finished", result: { state: "saved-pending-deployment", accepted: ["OPENAI_API_KEY"], failed: [] } }) });
      }
      return url.searchParams.has("requestKey") ? status([oldFinished()]) : status([currentB]);
    }));
    await render();
    await enter("first-value");
    await click("Save provider environment");
    await enter("newer-value");
    await click("Refresh save receipt");
    expect((host.querySelector("input") as HTMLInputElement).value).toBe("newer-value");
    expect(host.textContent).toContain("exact request is recorded as finished");
    await click("Save provider environment");
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ expectedRevision: 2, values: { OPENAI_API_KEY: "newer-value" } });
    expect(posts[1].requestKey).not.toBe(firstKey);
  });

  it("settles an exact acknowledgment after discard and authority loss without claiming success", async () => {
    let firstKey = "";
    const currentB = receipt({ requestKey: keyB, revision: 2, status: "finished", result: { state: "saved-pending-deployment", accepted: ["OPENAI_API_KEY"], failed: [] } });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "https://console.invalid");
      if (init?.method === "POST") { firstKey = String((JSON.parse(String(init.body)) as Record<string, unknown>).requestKey); throw new TypeError("lost reply"); }
      return url.searchParams.has("requestKey")
        ? status([receipt({ requestKey: firstKey, revision: 1, status: "uncertain", acknowledged: true })])
        : status([currentB]);
    }));
    await render();
    await enter("discard-me");
    await click("Save provider environment");
    await click("Discard draft");
    await render([currentB], false);
    await click("Refresh save receipt");
    expect(host.textContent).toContain("acknowledged as unresolved");
    expect(host.textContent).toContain("not success or cancellation");
    expect(host.textContent).toContain("Refresh save receipt");
    expect(host.querySelector("input")).toBeNull();
  });

  it("refreshes current revision after stale refusal while preserving draft until explicit fresh request", async () => {
    const posts: Array<Record<string, unknown>> = [];
    const currentB = receipt({ requestKey: keyB, revision: 2, status: "finished", result: { state: "saved-pending-deployment", accepted: ["OPENAI_API_KEY"], failed: [] } });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "https://console.invalid");
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        if (posts.length === 1) return Response.json({ code: "stale", error: "safe" }, { status: 409 });
        return Response.json({ record: receipt({ requestKey: String(body.requestKey), revision: 3, status: "finished", result: { state: "saved-pending-deployment", accepted: ["OPENAI_API_KEY"], failed: [] } }) });
      }
      return url.searchParams.has("requestKey") ? status([]) : status([currentB]);
    }));
    await render();
    await enter("preserved-value");
    await click("Save provider environment");
    await click("Refresh save receipt");
    expect((host.querySelector("input") as HTMLInputElement).value).toBe("preserved-value");
    expect(host.textContent).toContain("current revision was refreshed");
    await click("Start fresh request");
    await click("Save provider environment");
    expect(posts[1]).toMatchObject({ expectedRevision: 2, values: { OPENAI_API_KEY: "preserved-value" } });
    expect(posts[1].requestKey).not.toBe(posts[0].requestKey);
  });

  it("selects and acknowledges a preview-only unresolved receipt with authority unavailable", async () => {
    const preview = receipt({ target: fullTarget("preview"), status: "uncertain" });
    let body: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ acknowledged: true, warning: "may still finish", record: { ...preview, revision: 1, acknowledged: true } });
    }));
    await render([preview], false);
    expect((host.querySelector("select") as HTMLSelectElement).value).toBe("preview");
    await click("Acknowledge unresolved");
    expect(body).toMatchObject({ action: "acknowledge-unresolved", target: "preview", requestKey: preview.requestKey });
    expect(host.textContent).toContain("acknowledgment is not cancellation or success");
  });
});
