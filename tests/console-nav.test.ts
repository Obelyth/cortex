import { describe, it, expect } from "vitest";
import { TABS, LANDING_SEG } from "../app/s/[secret]/console/tabs";
describe("console navigation", () => {
  it("lands on ops", () => expect(LANDING_SEG).toBe("ops"));
  it("ops is the first tab and the inbox tab is gone", () => {
    expect(TABS[0]).toEqual({ seg: "ops", label: "Ops" });
    expect(TABS.some((t) => t.seg === "attention")).toBe(false);
  });
  it("the Notes tab is gone — the corpus explorer lives on Ask, and corpus/ answers with a redirect", () => {
    expect(TABS.some((t) => t.seg === "corpus")).toBe(false);
    expect(TABS.map((t) => t.seg)).toEqual(["ops", "overview", "ask", "trends", "settings"]);
  });
});
