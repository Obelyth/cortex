import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => ({
  pathname: "/s/the-right-secret/console/ops",
  health: vi.fn(),
  git: vi.fn(),
  repo: "example/brain",
  mirrorEnabled: true,
  mirrorHead: vi.fn(),
  cookies: new Map<string, string>(),
}));

vi.mock("../app/s/[secret]/console/loaders", () => ({ consoleHealth: shell.health }));
vi.mock("@/lib/mirror", () => ({
  mirrorStore: () => shell.mirrorEnabled ? { head: shell.mirrorHead } : null,
}));
vi.mock("@/lib/github", () => ({
  gh: shell.git,
  repo: () => shell.repo,
  branch: () => "main",
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => shell.cookies.has(name)
      ? { name, value: shell.cookies.get(name)! }
      : undefined,
  }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  redirect: (url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); },
  usePathname: () => shell.pathname,
}));
vi.mock("next/link", async () => {
  const ReactModule = await import("react");
  return {
    default: ({ prefetch, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) =>
      ReactModule.createElement("a", { ...props, "data-prefetch": String(prefetch) }),
  };
});

import ConsoleLayout from "../app/s/[secret]/console/layout";
import { Tabs } from "../app/s/[secret]/console/tabs";
import { STAMP_COOKIE, stampValue } from "../lib/stamp";

const params = Promise.resolve({ secret: "the-right-secret" });

beforeEach(() => {
  vi.stubEnv("CONNECTOR_PATH_SECRET", "the-right-secret");
  vi.stubEnv("CONSOLE_PASSCODE", "console-passcode");
  shell.cookies.clear();
  shell.cookies.set(STAMP_COOKIE, stampValue()!);
  shell.health.mockReset();
  shell.health.mockImplementation(() => new Promise(() => undefined));
  shell.git.mockReset();
  shell.git.mockResolvedValue(Response.json({ sha: "a".repeat(40) }));
  shell.repo = "example/brain";
  shell.mirrorEnabled = true;
  shell.mirrorHead.mockReset();
  shell.mirrorHead.mockResolvedValue("a".repeat(40));
  shell.pathname = "/s/the-right-secret/console/ops";
});

afterEach(() => vi.unstubAllEnvs());

describe("authenticated console shell", () => {
  it("resolves with its children while the legacy external health read remains unresolved", async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutFailure = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("console layout waited for health")), 75);
    });
    try {
      const result = await Promise.race([
        ConsoleLayout({ params, children: "settings-ready" }),
        timeoutFailure,
      ]);
      expect(result).toBeTruthy();
      const html = renderToStaticMarkup(result);
      expect(html).toContain("settings-ready");
      expect(html).not.toContain("IMPECCABLE DIRECTION CONTRACT");
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
});

describe("console tab navigation", () => {
  it("uses non-prefetching Next links with a nested-relative console destination", () => {
    shell.pathname = "/s/the-right-secret/console/attention/readers";
    const html = renderToStaticMarkup(React.createElement(Tabs));
    expect(html).toContain('href="../settings"');
    expect(html).toContain('data-prefetch="false"');
    expect(html).toContain('aria-current="page"');
  });

  it.each([
    ["top-level", "/s/console/console/ops", 'href="settings"'],
    ["nested", "/s/console/console/attention/readers", 'href="../settings"'],
  ])("anchors %s destinations to the console route when the secret is console", (_level, pathname, href) => {
    shell.pathname = pathname;
    const html = renderToStaticMarkup(React.createElement(Tabs));
    expect(html).toContain(href);
  });
});

type StatusRoute = typeof import("../app/s/[secret]/console/status/route");
type StatusContract = typeof import("../app/s/[secret]/console/status-contract");

async function statusRoute(): Promise<StatusRoute | null> {
  const path = "../app/s/[secret]/console/status/route";
  return import(path).catch(() => null);
}

async function statusContract(): Promise<StatusContract | null> {
  const path = "../app/s/[secret]/console/status-contract";
  return import(path).catch(() => null);
}

function statusRequest(cookie = `${STAMP_COOKIE}=${stampValue()!}`): Request {
  return new Request("https://cortex.test/s/the-right-secret/console/status", {
    headers: cookie ? { cookie } : {},
  });
}

describe("independent shell status endpoint", () => {
  it.each([
    ["wrong secret", Promise.resolve({ secret: "wrong" }), `${STAMP_COOKIE}=${stampValue()!}`],
    ["missing stamp", params, ""],
  ])("gates %s before either operational head read", async (_label, routeParams, cookie) => {
    const route = await statusRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    const response = await route.GET(statusRequest(cookie), { params: routeParams });
    expect(response.status).toBe(404);
    expect(shell.git).not.toHaveBeenCalled();
    expect(shell.mirrorHead).not.toHaveBeenCalled();
  });

  it("returns a fixed unavailable DTO when Git health fails, without forwarding its body", async () => {
    shell.git.mockResolvedValue(new Response(
      JSON.stringify({ error: "upstream failed", token: "sk-abcdefghijklmnopZZ" }),
      { status: 503, headers: { "content-type": "application/json" } },
    ));
    const route = await statusRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    const response = await route.GET(statusRequest(), { params });
    const body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ state: "unavailable", sha: null, commitUrl: null });
    expect(Number.isNaN(Date.parse(String(body.checkedAt)))).toBe(false);
    expect(JSON.stringify(body)).not.toContain("upstream failed");
    expect(JSON.stringify(body)).not.toContain("sk-");
  });

  it("publishes only the validated minimal live shape", async () => {
    shell.git.mockResolvedValue(Response.json({ sha: "a".repeat(40), token: "do-not-forward" }));
    shell.mirrorHead.mockResolvedValue("a".repeat(40));
    const route = await statusRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    const response = await route.GET(statusRequest(), { params });
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["checkedAt", "commitUrl", "sha", "state"]);
    expect(body).toMatchObject({
      state: "live",
      sha: "aaaaaaaa",
      commitUrl: `https://github.com/example/brain/commit/${"a".repeat(40)}`,
    });
    expect(JSON.stringify(body)).not.toContain("do-not-forward");
  });

  it("treats a successful but malformed Git payload as unavailable", async () => {
    shell.git.mockResolvedValue(Response.json({ sha: "not-a-commit", token: "do-not-forward" }));
    const route = await statusRoute();
    expect(route).not.toBeNull();
    if (!route) return;
    const response = await route.GET(statusRequest(), { params });
    expect(await response.json()).toMatchObject({ state: "unavailable", sha: null, commitUrl: null });
  });
});

describe("retained status freshness", () => {
  it("stops presenting an old live result as current and retains its last-check time", async () => {
    const contract = await statusContract();
    expect(contract).not.toBeNull();
    if (!contract) return;
    const checkedAt = "2026-09-08T12:00:00.000Z";
    const view = contract.statusView({
      state: "live",
      sha: "aaaaaaaa",
      commitUrl: `https://github.com/example/brain/commit/${"a".repeat(40)}`,
      checkedAt,
    }, Date.parse(checkedAt) + 46_000);
    expect(view).toEqual({
      mode: { text: "status unavailable", tone: "warn" },
      sha: "",
      commitUrl: null,
      title: `status unavailable · last checked ${checkedAt}`,
    });
  });
});
