import { describe, expect, it } from "vitest";
import { GROUND_COOKIE, groundCookie, groundFrom } from "../app/s/[secret]/console/ground";

describe("ground — ink by default, paper by choice", () => {
  it.each([[undefined, "ink"], [null, "ink"], ["", "ink"], ["ink", "ink"], ["paper", "paper"], ["PAPER", "ink"], ["dark", "ink"]] as const)("%s → %s", (v, g) => {
    expect(groundFrom(v as string | undefined)).toBe(g);
  });
  it("writes a year-long cookie scoped to this console's path", () => {
    const c = groundCookie("paper", "s3cr3t", true);
    expect(c).toBe(`${GROUND_COOKIE}=paper; Path=/s/s3cr3t/console; Max-Age=31536000; SameSite=Lax; Secure`);
  });
  it("drops Secure off https, so a local dev console can still flip it", () => {
    expect(groundCookie("ink", "x", false)).not.toContain("Secure");
  });
});
