import { beforeEach, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
const acceptance = vi.hoisted(() => vi.fn());
const calls = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("../lib/kv", () => ({ kv: () => null, kvEnv: () => "synthetic" }));
vi.mock("../lib/proposals", async original => ({ ...await original<object>(), acceptProposal: acceptance }));
vi.mock("../lib/calls", async original => ({ ...await original<object>(), record: calls.record }));
import { registerTools } from "../lib/tools";
beforeEach(() => calls.record.mockClear());

type Reply = { content: { text: string }[]; isError?: boolean };
function acceptHandler() {
  let handler!: (args: { id: string }) => Promise<Reply>;
  registerTools({ registerTool: (name: string, _config: unknown, fn: typeof handler) => { if (name === "brain_accept") handler = fn; } } as unknown as McpServer);
  return handler;
}
it("reports terminal cancellation without claiming acceptance, preserving cleanup warnings", async () => {
  acceptance.mockResolvedValue({ outcome: "canceled", path: "notes/a.md", commitSha: "cancel123", cleanupWarning: "queue unavailable" });
  const reply = await acceptHandler()({ id: "p1" });
  expect(reply.isError).not.toBe(true);
  expect(reply.content[0].text).toContain("was canceled");
  expect(reply.content[0].text).toContain("cancel123");
  expect(reply.content[0].text).toContain("queue unavailable");
  expect(reply.content[0].text).not.toContain("Accepted p1");
  // The call log is the console's record of what happened; a cancellation must not be logged
  // as the commit it did not make.
  // One call through the mocked export: the started row goes through calls.ts's own internal
  // record (tests/tools-deadline.test.ts pins that ordering); what arrives here is the FINAL row,
  // which carries the id that ties it to its started row.
  expect(calls.record).toHaveBeenCalledTimes(1);
  expect(calls.record.mock.calls[0][0]).toMatchObject({ tool: "brain_accept", stamp: "CANCELED" });
  expect(typeof calls.record.mock.calls[0][0].id).toBe("string");
  expect(calls.record.mock.calls[0][0].state).toBeUndefined();
});
it("keeps both warning channels on an accepted replay", async () => {
  acceptance.mockResolvedValue({ outcome: "committed", path: "notes/a.md", commitSha: "accept123", indexWarning: "index unavailable", cleanupWarning: "queue unavailable" });
  const reply = await acceptHandler()({ id: "p1" });
  expect(reply.content[0].text).toContain("Accepted p1");
  expect(reply.content[0].text).toContain("accept123");
  expect(reply.content[0].text).toContain("index unavailable");
  expect(reply.content[0].text).toContain("queue unavailable");
  expect(calls.record.mock.calls[0][0]).toMatchObject({ tool: "brain_accept", stamp: "COMMITTED" });
});
