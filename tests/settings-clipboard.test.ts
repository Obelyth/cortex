// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

describe("Settings clipboard feedback", () => {
  it("reports success without touching the real browser clipboard", async () => {
    const clipboard = await import("../app/s/[secret]/console/settings/clipboard").catch(() => null);
    expect(clipboard).not.toBeNull();
    if (!clipboard) return;
    const writer = { writeText: vi.fn().mockResolvedValue(undefined) };
    expect(await clipboard.copyExactText("synthetic exact command", writer)).toEqual({ ok: true });
  });

  it("returns the exact fallback when clipboard access is rejected, and shows it only after an explicit reveal", async () => {
    const clipboard = await import("../app/s/[secret]/console/settings/clipboard").catch(() => null);
    expect(clipboard).not.toBeNull();
    if (!clipboard) return;
    const writer = { writeText: vi.fn().mockRejectedValue(new Error("denied")) };
    const result = await clipboard.copyExactText("synthetic exact command", writer);
    expect(result).toEqual({ ok: false, fallback: "synthetic exact command" });

    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
    try {
      await act(async () => root.render(React.createElement(clipboard.ClipboardFailure, { text: result.ok ? "" : result.fallback })));
      // The failure is said; the secret-bearing text is not on screen until asked for.
      expect(host.textContent).toContain("copy failed");
      expect(host.textContent).not.toContain("synthetic exact command");
      expect(button("reveal").getAttribute("aria-expanded")).toBe("false");
      await act(async () => button("reveal").click());
      expect(host.querySelector("pre")?.textContent).toBe("synthetic exact command");
      // And it can be put away again before a screenshot.
      await act(async () => button("hide").click());
      expect(host.textContent).not.toContain("synthetic exact command");
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

  it("with no text, points at the value already on screen and offers no reveal", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const clipboard = await import("../app/s/[secret]/console/settings/clipboard");
    const html = renderToStaticMarkup(React.createElement(clipboard.ClipboardFailure, {}));
    expect(html).toContain("select the exact text shown above");
    expect(html).not.toContain("<button");
  });
});
