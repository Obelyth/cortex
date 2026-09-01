import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

/**
 * The payload ceiling, advertised and enforced at the door.
 *
 * Sixty days of transcripts said brain_write "truncates large payloads somewhere between
 * client and handler". It does not. Every "could not be parsed as JSON" failure on the write
 * tools is CLIENT-side: the model emits tool-input JSON that is invalid or cut off, the
 * harness refuses it, and no request is ever sent — the same error hits Read and Bash, which
 * have no server at all. The "truncated mid-word" echo that seeded the story is the error's
 * own 200-byte preview. A dev-server probe with 1MB and 4MB bodies confirmed the transport
 * delivers payloads whole: both failed only at the fake GitHub credential, past parsing and
 * past validation.
 *
 * So the server cannot fix the parse errors. What it can do is advertise a ceiling — a
 * maxLength in the schema steers clients toward the write sizes that survive generation —
 * and refuse an oversized intact payload loudly BEFORE the opaque downstream walls (Vercel's
 * 4.5MB request cap, the 60s budget) turn it into a mystery. The zod schema is the
 * enforcement point: mcp-handler validates input against it and refuses with InvalidParams
 * before the handler runs, so nothing is saved and nothing is ever silently cut.
 *
 * The literal 500_000 is pinned deliberately, roster-style: raising or lowering the ceiling
 * should be a red build and a conscious edit to this file, not a drift. The number leaves
 * 2.3x headroom over the largest live note (~218K chars as of 2026-08-18), so a full
 * replace of any real page still fits.
 */

// Spread the real module so MAX_WRITE_CHARS — the constant under test — stays real; only the
// functions with GitHub behind them are replaced.
vi.mock("../lib/brain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/brain")>()),
  readNote: vi.fn(),
  capture: vi.fn(async () => ({ path: "log/2026-08-18.md", commitSha: "c1" })),
  getContext: vi.fn(),
  validatePath: vi.fn(),
  writeNote: vi.fn(async () => ({ path: "notes/big.md", commitSha: "c0" })),
}));

import { registerTools } from "../lib/tools";
import { writeNote } from "../lib/brain";

// The same harness tests/maintenance-read.test.ts uses, for the same reason: the real
// registrations, so the real zod schema and the real description are what get judged.
interface Captured {
  config: { description?: string; inputSchema?: Record<string, z.ZodTypeAny> };
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
}

function captureTools(guest: boolean): Map<string, Captured> {
  const out = new Map<string, Captured>();
  const fake = {
    registerTool(name: string, config: Captured["config"], handler: Captured["handler"]) {
      out.set(name, { config, handler });
    },
  };
  registerTools(fake as unknown as McpServer, { guest });
  return out;
}

const TRUSTED = captureTools(false);
const brainWrite = TRUSTED.get("brain_write")!;
const brainCapture = TRUSTED.get("brain_capture")!;
const writeSchema = z.object(brainWrite.config.inputSchema ?? {});
const captureSchema = z.object(brainCapture.config.inputSchema ?? {});

const AT = "x".repeat(500_000);
const OVER = "x".repeat(500_001);

describe("brain_write's ceiling", () => {
  it("accepts content at exactly the ceiling, and the handler saves it whole", async () => {
    expect(
      writeSchema.safeParse({ path: "notes/big.md", content: AT, mode: "create" }).success
    ).toBe(true);
    const res = await brainWrite.handler({ path: "notes/big.md", content: AT, mode: "create" });
    expect(res.isError).not.toBe(true);
    expect(res.content[0].text).toContain("Saved notes/big.md (commit c0)");
    // Whole means whole: the handler passed every character through, none shaved.
    const saved = vi.mocked(writeNote).mock.calls[0];
    expect((saved[1] as string).length).toBe(500_000);
  });

  it("refuses content one character over, and the refusal names the remedy", () => {
    const parsed = writeSchema.safeParse({ path: "notes/big.md", content: OVER, mode: "create" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issue = parsed.error.issues.find((i) => i.path[0] === "content");
    // "Too big" alone teaches a caller nothing. The message must say what to DO instead —
    // that is the whole difference between this refusal and the parse failure it replaces.
    expect(issue?.message).toMatch(/500000-character ceiling/);
    expect(issue?.message).toMatch(/split the write/);
    expect(issue?.message).toMatch(/nothing is saved/);
  });

  it("caps find at the same ceiling — the text to replace is a substring, never the note", () => {
    expect(
      writeSchema.safeParse({ path: "notes/big.md", content: "n", mode: "edit", find: AT }).success
    ).toBe(true);
    expect(
      writeSchema.safeParse({ path: "notes/big.md", content: "n", mode: "edit", find: OVER })
        .success
    ).toBe(false);
  });

  it("documents the ceiling where a caller actually reads: the tool description", () => {
    const doc = brainWrite.config.description ?? "";
    expect(doc).toMatch(/500,000 characters/);
    expect(doc).toMatch(/never truncated/i);
    expect(doc).toMatch(/split/i);
  });
});

describe("brain_capture's ceiling", () => {
  it("still accepts a normal capture", () => {
    expect(captureSchema.safeParse({ text: "a quick thought", tags: ["cortex"] }).success).toBe(
      true
    );
  });

  it("refuses text over the ceiling and points at brain_write for anything that big", () => {
    const parsed = captureSchema.safeParse({ text: OVER });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issue = parsed.error.issues.find((i) => i.path[0] === "text");
    expect(issue?.message).toMatch(/500000-character ceiling/);
    expect(issue?.message).toMatch(/brain_write/);
  });

  it("documents the ceiling in its description", () => {
    expect(brainCapture.config.description ?? "").toMatch(/500,000 characters/);
  });
});
