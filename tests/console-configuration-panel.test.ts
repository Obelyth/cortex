import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigurationResult } from "../lib/console-configuration-contract";
import { DoorFold } from "../app/s/[secret]/console/settings/door-fold";

const lens = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), lens: null }));
vi.mock("../app/s/[secret]/console/lens", () => ({ useLens: () => lens }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), usePathname: () => "/s/console/console/settings" }));

const module = await import("../app/s/[secret]/console/settings/configuration-panel");

const view = {
  adapter: { configured: true, projectId: "prj_fixture", teamId: null },
  store: "ready" as const,
  records: [],
  ingressReady: true,
  presence: {
    notes: { configured: false, missing: ["GITHUB_TOKEN"] },
    "reader-anthropic": { configured: true, missing: [] },
    "reader-openai": { configured: false, missing: ["OPENAI_API_KEY"] },
    "reader-google": { configured: false, missing: ["GEMINI_API_KEY"] },
    mirror: { configured: true, missing: [] },
    cache: { configured: true, missing: [] },
    alerts: { configured: false, missing: ["RESEND_API_KEY"] },
  },
  evidence: {
    notes: { state: "unknown" as const, detail: "not probed on this page" },
    "reader-anthropic": { state: "observed" as const, detail: "selected by current reader resolution; provider not contacted" },
    "reader-openai": { state: "unknown" as const, detail: "missing process configuration" },
    "reader-google": { state: "unknown" as const, detail: "missing process configuration" },
    mirror: { state: "unavailable" as const, detail: "working-state probe unavailable" },
    cache: { state: "observed" as const, detail: "answer-cache read completed" },
    alerts: { state: "unknown" as const, detail: "mail not sent by this page" },
  },
};

beforeEach(() => lens.open.mockReset());

describe("write-only capability configuration panel", () => {
  it.each([
    ["SUPABASE_URL", "mirror"],
    ["KV_REST_API_URL", "cache"],
    ["RESEND_API_KEY", "alerts"],
  ])("connects the %s reference to its existing dashboard setup control", (label, capability) => {
    const fold = renderToStaticMarkup(createElement(DoorFold, { label, sub: "synthetic", set: false, configurationAvailable: true }));
    const panel = renderToStaticMarkup(createElement(module.ConfigurationPanel, { view }));
    expect(fold).toContain(`href="#setConfiguration-${capability}"`);
    expect(panel).toMatch(new RegExp(`<button[^>]*id="setConfiguration-${capability}"`));
  });

  it.each(["MCP_TOKEN", "CONNECTOR_PATH_SECRET", "GUEST_PATH_SECRET", "CONSOLE_PASSCODE", "SENTRY_DSN"])("does not offer a capability editor for externally managed %s", (label) => {
    const fold = renderToStaticMarkup(createElement(DoorFold, { label, sub: "synthetic", set: false, configurationAvailable: true }));
    expect(fold).not.toContain('href="#setConfiguration-');
  });

  it("does not link to a capability panel absent from an older screen", () => {
    const fold = renderToStaticMarkup(createElement(DoorFold, { label: "SUPABASE_URL", sub: "synthetic", set: false }));
    expect(fold).not.toContain('href="#setConfiguration-');
  });

  it("shows process presence and operational evidence separately from saved deployment state", () => {
    const html = renderToStaticMarkup(createElement(module.ConfigurationPanel, { view }));
    expect(html).toContain("prj_fixture");
    expect(html).toMatch(/Notes[\s\S]*running app configuration · missing GITHUB_TOKEN/);
    expect(html).toMatch(/Reader · Anthropic[\s\S]*running app configuration · present/);
    expect(html).toContain("selected by current reader resolution; provider not contacted");
    expect(html).toMatch(/Mirror &amp; working state[\s\S]*working-state probe unavailable/);
    expect(html).toContain("no dashboard save recorded");
    expect(html).not.toContain("synthetic-management-token");
  });

  it("opens the existing shared lens with blank write-only fields and explicit deployment navigation", () => {
    const tree = module.ConfigurationPanel({ view });
    const children = (tree.props.children as Array<unknown>).flat() as Array<{ key?: string; props: { onClick?: () => void } }>;
    const first = children.find((child) => child?.props?.onClick);
    expect(first).toBeTruthy();
    first!.props.onClick!();
    const content = lens.open.mock.calls[0][0];
    const html = renderToStaticMarkup(content.body);
    expect(content.kind).toBe("capability setup");
    expect(html).toContain("BRAIN_REPO");
    expect(html).toContain("GITHUB_TOKEN");
    expect(html).toContain("Review deployment actions in Ops");
    expect(html).toContain('href="ops#ops-commands"');
    expect(new URL("ops#ops-commands", "https://console.invalid/s/console/console/settings").href).toBe("https://console.invalid/s/console/console/ops#ops-commands");
    expect(html).toContain("Changing the Notes repository does not move existing notes");
    expect(html.match(/<input[^>]+value=""/g)).toHaveLength(2);
    expect(html).not.toContain("fixture/brain");
  });

  it("clears only verified fields while preserving uncertain and failed drafts", () => {
    const draft = { BRAIN_REPO: "fixture/brain", GITHUB_TOKEN: "secret" };
    const saved: ConfigurationResult = { state: "saved-pending-deployment", accepted: ["BRAIN_REPO", "GITHUB_TOKEN"], failed: [] };
    const partial: ConfigurationResult = { state: "partial", accepted: ["BRAIN_REPO"], failed: [{ name: "GITHUB_TOKEN", code: "provider_rejected" }] };
    const uncertain: ConfigurationResult = { state: "uncertain", accepted: [], failed: [{ name: "BRAIN_REPO", code: "completion_unconfirmed" }, { name: "GITHUB_TOKEN", code: "completion_unconfirmed" }] };
    expect(module.draftAfterConfiguration(draft, saved)).toEqual({ BRAIN_REPO: "", GITHUB_TOKEN: "" });
    expect(module.draftAfterConfiguration(draft, partial)).toEqual({ BRAIN_REPO: "", GITHUB_TOKEN: "secret" });
    expect(module.draftAfterConfiguration(draft, uncertain)).toEqual(draft);
    const unresolved = module.configurationSettlement(draft, {
      capability: "notes", target: "vercel:prj_fixture:personal:production", revision: 0,
      status: "running", requestKey: "0199b3b0-0000-7000-8000-000000000000", result: null,
      acknowledged: false, updatedAt: "2026-09-08T23:00:00.000Z",
    });
    expect(unresolved).toMatchObject({ draft, releaseRequestKey: false, message: expect.stringContaining("no provider write is confirmed") });
    expect(module.draftAfterRecoveredAttempt(draft, draft, saved)).toEqual({ BRAIN_REPO: "", GITHUB_TOKEN: "" });
    expect(module.draftAfterRecoveredAttempt({ ...draft, GITHUB_TOKEN: "newer" }, draft, saved)).toEqual({ ...draft, GITHUB_TOKEN: "newer" });
  });

  it("settles an exact lost-reply receipt before a later edit can use a fresh revision identity", () => {
    const firstDraft = { OPENAI_API_KEY: "first-secret" };
    const first = module.configurationAttempt(null, firstDraft, 0, () => "0199b3b0-0000-7000-8000-000000000001");
    expect(module.configurationAttempt(first, { OPENAI_API_KEY: "newer-draft" }, 1, () => "must-not-run")).toEqual(first);
    const finished = {
      capability: "reader-openai" as const,
      target: "vercel:prj_fixture:personal:production",
      revision: 1,
      status: "finished" as const,
      requestKey: first.requestKey,
      result: { state: "saved-pending-deployment" as const, accepted: ["OPENAI_API_KEY"], failed: [] },
      acknowledged: false,
      updatedAt: "2026-09-08T23:00:00.000Z",
    };
    const recovered = module.matchingFinishedRecovery({ OPENAI_API_KEY: "newer-draft" }, first, finished);
    expect(recovered).toEqual({ draft: { OPENAI_API_KEY: "newer-draft" }, pending: null });
    const second = module.configurationAttempt(recovered!.pending, recovered!.draft, finished.revision, () => "0199b3b0-0000-7000-8000-000000000002");
    expect(second).toEqual({ requestKey: "0199b3b0-0000-7000-8000-000000000002", expectedRevision: 1, values: { OPENAI_API_KEY: "newer-draft" } });
  });

  it("keeps value-free status and acknowledgment available when secret entry is unavailable", () => {
    const unavailable = {
      ...view,
      adapter: { ...view.adapter, configured: false },
      ingressReady: false,
      records: [{ capability: "reader-openai" as const, target: "vercel:prj_fixture:personal:production", revision: 0, status: "uncertain" as const, requestKey: "0199b3b0-0000-7000-8000-000000000000", result: null, acknowledged: false, updatedAt: "2026-09-08T23:00:00.000Z" }],
    };
    const html = renderToStaticMarkup(createElement(module.ConfigurationEditor, { capability: "reader-openai", initialView: unavailable }));
    expect(html).toContain("Refresh save receipt");
    expect(html).toContain("Acknowledge unresolved");
    expect(html).not.toContain("<input");
  });

  it("keeps preview-only value-free recovery selectable when secret entry is unavailable", () => {
    const unavailable = {
      ...view,
      adapter: { ...view.adapter, configured: false },
      ingressReady: false,
      records: [{ capability: "reader-openai" as const, target: "vercel:prj_fixture:personal:preview", revision: 0, status: "uncertain" as const, requestKey: "0199b3b0-0000-7000-8000-000000000000", result: null, acknowledged: false, updatedAt: "2026-09-08T23:00:00.000Z" }],
    };
    const html = renderToStaticMarkup(createElement(module.ConfigurationEditor, { capability: "reader-openai", initialView: unavailable }));
    expect(html).toContain("Deployment target");
    expect(html).toContain('<option value="preview" selected="">preview</option>');
    expect(html).toContain("Refresh save receipt");
    expect(html).not.toContain("<input");
  });

  it("explains the supported managed-ingress prerequisite without enabling secret fields", () => {
    const html = renderToStaticMarkup(createElement(module.ConfigurationEditor, { capability: "reader-openai", initialView: { ...view, ingressReady: false } }));
    expect(html).toContain("supported Vercel-managed HTTPS ingress");
    expect(html).toContain("do not set platform indicators manually");
    expect(html).toContain("Refresh save receipt");
    expect(html).not.toContain("<input");
  });

  it("offers one blank secret input when every secret-entry prerequisite is satisfied", () => {
    const html = renderToStaticMarkup(createElement(module.ConfigurationEditor, { capability: "reader-openai", initialView: view }));
    expect(html.match(/<input\b/g)).toHaveLength(1);
    expect(html).toMatch(/<input[^>]*type="password"[^>]*value=""/);
  });

  it("warns that changing the working-state database does not migrate durable history", () => {
    const tree = module.ConfigurationPanel({ view });
    const buttons = (tree.props.children as Array<unknown>).flat() as Array<{ key?: string; props: { onClick?: () => void } }>;
    const mirror = buttons.find((child) => child?.key === "mirror");
    expect(mirror).toBeTruthy();
    mirror!.props.onClick!();
    expect(renderToStaticMarkup(lens.open.mock.calls[0][0].body)).toContain("does not migrate the old database, handoffs, Devices, Ops, or configuration receipts");
  });
});
