import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitTransport, QueueTransport } from "./helpers/proposal-transports";

const now = 1_760_000_000_000;
const payload = { id: "abc", ts: now, path: "notes/idea.md", mode: "append", content: "Accepted thought" };
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
let git: GitTransport;
let queue: QueueTransport;
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.resetModules(); git = new GitTransport(); queue = new QueueTransport();
  queue.rows.abc = JSON.stringify(payload);
  vi.doMock("../lib/kv", () => ({ kv: () => queue, kvEnv: () => "test" }));
  vi.stubEnv("GITHUB_TOKEN", "synthetic"); vi.stubEnv("BRAIN_REPO", "test/brain"); vi.stubEnv("BRAIN_BRANCH", "feature/proposals");
  vi.stubGlobal("fetch", git.fetch);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.doUnmock("../lib/kv"); vi.resetModules(); });

describe("durable acceptance through the real write composition", () => {
  it.each(["receipt", "claim"] as const)("replays the winner after queue cleanup while a second accepter waits before %s", async point => {
    const entered = barrier(), resume = barrier(); let first = true;
    if (point === "receipt") {
      vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
        if (first && input.includes("/git/ref/")) { first = false; entered.release(); await resume.promise; }
        return git.fetch(input, init);
      });
    } else {
      const original = queue.createScript;
      queue.createScript = script => ({ exec: async (keys, args) => {
        if (first && args[0] === "claim") { first = false; entered.release(); await resume.promise; }
        return original(script).exec(keys, args);
      } });
    }
    const { acceptProposal } = await import("../lib/proposals");
    const second = acceptProposal("abc", now);
    await entered.promise;
    const winner = await acceptProposal("abc", now);
    expect(queue.rows.abc).toBeUndefined();
    resume.release();
    await expect(second).resolves.toMatchObject({ outcome: "committed", commitSha: winner.commitSha });
    expect(git.files()[payload.path]).toBe("Original\n\nAccepted thought");
  });
  it("cancels retained work without changing the competing note and replays the terminal result", async () => {
    queue.rows.abc = JSON.stringify({ ...payload, mode: "create", state: "accepting" });
    git.failIndex = true;
    const { cancelProposal, acceptProposal } = await import("../lib/proposals");
    const canceled = await cancelProposal("abc", now);
    expect(canceled).toMatchObject({ outcome: "canceled", path: payload.path });
    expect(canceled.indexWarning).toBeUndefined();
    expect(git.files()[payload.path]).toBe("Original");
    expect(queue.rows.abc).toBeUndefined();
    await expect(acceptProposal("abc", now)).resolves.toMatchObject(canceled);
    await expect(cancelProposal("abc", now)).resolves.toMatchObject(canceled);
    expect(git.urls.some(url => url.includes("?recursive=1"))).toBe(false);
  });
  it.each(["before", "after"] as const)("resolves a lost cancellation response %s ref publication", async timeout => {
    queue.rows.abc = JSON.stringify({ ...payload, state: "accepting" }); git.timeout = timeout;
    const { cancelProposal } = await import("../lib/proposals");
    const result = await cancelProposal("abc", now);
    expect(result.outcome).toBe("canceled");
    expect(git.files()[payload.path]).toBe("Original");
    expect((await cancelProposal("abc", now)).commitSha).toBe(result.commitSha);
  });
  it.each(["accept", "cancel"] as const)("resolves the terminal winner while the %s publisher is delayed", async delayed => {
    queue.rows.abc = JSON.stringify({ ...payload, state: "accepting" });
    const entered = barrier(), resume = barrier(); let first = true;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (first && init?.method === "PATCH") { first = false; entered.release(); await resume.promise; }
      return git.fetch(input, init);
    });
    const { cancelProposal, acceptProposal } = await import("../lib/proposals");
    const slow = delayed === "accept" ? acceptProposal("abc", now) : cancelProposal("abc", now);
    await entered.promise;
    const winner = delayed === "accept" ? await cancelProposal("abc", now) : await acceptProposal("abc", now);
    resume.release();
    await expect(slow).resolves.toMatchObject({ outcome: winner.outcome, commitSha: winner.commitSha });
    expect(git.files()[payload.path]).toBe(delayed === "accept" ? "Original" : "Original\n\nAccepted thought");
  });
  it("a claim that outruns the queue timeout is uncertain, because the row may already be accepting", async () => {
    // The script flips the row before the reply travels. A slow reply used to surface as a plain
    // error, and the operator's next move — reject it — was refused as a conflict on a proposal
    // they had just been told was untouched.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const original = queue.createScript;
    queue.createScript = script => ({ exec: async (keys, args) => {
      const r = await original(script).exec(keys, args);
      if (args[0] === "claim") await new Promise(resolve => setTimeout(resolve, 5_000));
      return r;
    } });
    const { acceptProposal, dropProposal } = await import("../lib/proposals");
    const pending = acceptProposal("abc", now).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_600);
    const err = await pending as Error & { outcome?: string };
    expect(err).toMatchObject({ outcome: "uncertain" });
    expect(err.message).toMatch(/claim did not answer.*timeout/);
    expect(JSON.parse(queue.rows.abc).state).toBe("accepting");
    expect(git.publications).toHaveLength(0);
    // Consistent with what the caller was told: the acceptance may have started, so a reject
    // is refused and a retry of the same id is the way out.
    await expect(dropProposal("abc")).rejects.toThrow(/acceptance has started/);
  });

  it("cancellation of pending work is refused without any Git mutation", async () => {
    const { cancelProposal } = await import("../lib/proposals");
    await expect(cancelProposal("abc", now)).rejects.toThrow(/pending|reject/);
    expect(git.publications).toHaveLength(0);
  });
  it("resolves cancellation when a paused accepter subsequently fails validation at its older head", async () => {
    queue.rows.abc = JSON.stringify({ ...payload, mode: "create", state: "accepting" });
    const entered = barrier(), resume = barrier(); let first = true;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (first && input.includes("/contents/notes/idea.md")) { first = false; entered.release(); await resume.promise; }
      return git.fetch(input, init);
    });
    const { acceptProposal, cancelProposal } = await import("../lib/proposals");
    const accepting = acceptProposal("abc", now); await entered.promise;
    const canceled = await cancelProposal("abc", now); resume.release();
    await expect(accepting).resolves.toMatchObject({ outcome: "canceled", commitSha: canceled.commitSha });
    expect(git.files()[payload.path]).toBe("Original");
  });
  it("retains cancellation cleanup warnings and resolves a lost cancellation with unavailable receipt reads", async () => {
    queue.rows.abc = JSON.stringify({ ...payload, state: "accepting" });
    git.timeout = "after"; git.failReceiptAfterTimeout = true;
    const { cancelProposal, acceptProposal } = await import("../lib/proposals");
    await expect(cancelProposal("abc", now)).rejects.toMatchObject({ outcome: "uncertain" });
    expect(git.publications).toHaveLength(1);
    git.failReceipt = false; queue.failFinalize = true;
    const canceled = await cancelProposal("abc", now);
    expect(canceled).toMatchObject({ outcome: "canceled", cleanupWarning: expect.stringMatching(/queue/) });
    expect((await acceptProposal("abc", now)).commitSha).toBe(canceled.commitSha);
    expect(git.files()[payload.path]).toBe("Original");
  });
  it("cancels a replacement after its target disappears, preserving absence", async () => {
    queue.rows.abc = JSON.stringify({ ...payload, path: "notes/missing.md", mode: "replace", state: "accepting" });
    const { cancelProposal, acceptProposal } = await import("../lib/proposals");
    const canceled = await cancelProposal("abc", now);
    expect(canceled.outcome).toBe("canceled");
    expect(git.files()["notes/missing.md"]).toBeUndefined();
    expect((await acceptProposal("abc", now)).commitSha).toBe(canceled.commitSha);
  });
  it("keeps a cancellation uncertain if its accepting-state recheck becomes unavailable", async () => {
    queue.rows.abc = JSON.stringify({ ...payload, state: "accepting" });
    const original = queue.createScript; let reads = 0;
    queue.createScript = script => ({ exec: async (keys, args) => {
      if (args[0] === "get" && ++reads === 2) throw new Error("KV unavailable");
      return original(script).exec(keys, args);
    } });
    const { cancelProposal } = await import("../lib/proposals");
    await expect(cancelProposal("abc", now)).rejects.toMatchObject({ outcome: "uncertain" });
    expect(git.publications).toHaveLength(0);
    expect(queue.rows.abc).toBeDefined();
  });
  it("concurrent append accepts publish one effect and replay the same original commit", async () => {
    const { acceptProposal } = await import("../lib/proposals");
    const [a, b] = await Promise.all([acceptProposal("abc", now), acceptProposal("abc", now)]);
    expect(git.files()[payload.path]).toBe("Original\n\nAccepted thought");
    expect(a.commitSha).toBe(b.commitSha);
    expect(Object.keys(git.files()).filter(p => p.startsWith(".cortex/") && p.endsWith(".json"))).toHaveLength(1);
    const receipt = JSON.parse(Object.entries(git.files()).find(([p]) => p.startsWith(".cortex/"))![1]);
    expect(receipt).not.toHaveProperty("content");
    expect(git.files(a.commitSha)[payload.path]).toBe("Original\n\nAccepted thought");
    expect(git.urls.some(url => url.includes("/git/ref/heads/feature%2Fproposals"))).toBe(true);
  });
  it.each(["before", "after"] as const)("resolves a lost response %s ref publication", async (timeout) => {
    git.timeout = timeout;
    const { acceptProposal } = await import("../lib/proposals");
    const accepted = await acceptProposal("abc", now);
    expect(accepted.commitSha).toMatch(/^[a-f0-9]{40}$/);
    expect(git.files()[payload.path]).toBe("Original\n\nAccepted thought");
    expect((await acceptProposal("abc", now)).commitSha).toBe(accepted.commitSha);
  });
  it("fails uncertain when resolution is unavailable and never blindly re-appends", async () => {
    git.timeout = "after"; git.failReceiptAfterTimeout = true;
    const { acceptProposal } = await import("../lib/proposals");
    await expect(acceptProposal("abc", now)).rejects.toMatchObject({ outcome: "uncertain" });
    expect(git.files()[payload.path]).toBe("Original\n\nAccepted thought");
    expect(git.publications).toHaveLength(1);
    git.failReceipt = false;
    await acceptProposal("abc", now);
    expect(git.files()[payload.path]).toBe("Original\n\nAccepted thought");
  });
  it("replays after cleanup failure, row deletion and subsequent normal edits", async () => {
    queue.failFinalize = true; git.failIndex = true;
    const { acceptProposal } = await import("../lib/proposals");
    const first = await acceptProposal("abc", now);
    expect(first.indexWarning).toMatch(/503/);
    expect(first).toMatchObject({ outcome: "committed", cleanupWarning: expect.stringMatching(/cleanup|queue/) });
    expect((await acceptProposal("abc", now)).commitSha).toBe(first.commitSha);
    queue.failFinalize = false;
    await acceptProposal("abc", now);
    expect(queue.rows.abc).toBeUndefined();
    git.edit(payload.path, "Later ordinary edit");
    const replay = await acceptProposal("abc", now);
    expect(replay.commitSha).toBe(first.commitSha);
    expect(replay.indexWarning).toMatch(/503/);
    expect(git.files()[payload.path]).toBe("Later ordinary edit");
  });
  it("recomputes an append against an unrelated same-path winning writer", async () => {
    git.beforePublish = () => git.edit(payload.path, "Concurrent writer");
    const { acceptProposal } = await import("../lib/proposals");
    await acceptProposal("abc", now);
    expect(git.files()[payload.path]).toBe("Concurrent writer\n\nAccepted thought");
  });
  it("refuses an altered payload for a receipt that already exists", async () => {
    const { acceptProposal } = await import("../lib/proposals");
    await acceptProposal("abc", now);
    queue.rows.abc = JSON.stringify({ ...payload, content: "Changed" });
    await expect(acceptProposal("abc", now)).rejects.toThrow(/receipt|mismatch/);
    expect(git.files()[payload.path]).toBe("Original\n\nAccepted thought");
  });
  it("reject winning causes no Git write; reject loses after a claim and recovery remains possible", async () => {
    const { acceptProposal, dropProposal } = await import("../lib/proposals");
    await dropProposal("abc");
    await expect(acceptProposal("abc", now)).rejects.toThrow(/no pending/);
    expect(git.publications).toHaveLength(0);
    queue.rows.abc = JSON.stringify({ ...payload, state: "accepting" });
    await expect(dropProposal("abc")).rejects.toThrow(/acceptance|accepting/);
    await acceptProposal("abc", now + 60 * 86_400_000);
    expect(git.files()[payload.path]).toBe("Original\n\nAccepted thought");
  });
  it("does not call a failed store read a missing proposal", async () => {
    queue.fail = true;
    const { getProposal } = await import("../lib/proposals");
    await expect(getProposal("abc", now)).rejects.toThrow(/KV unavailable/);
  });
  it("claim versus rejection has a single winner through the acceptance API", async () => {
    const { acceptProposal, dropProposal } = await import("../lib/proposals");
    const [accepted, rejected] = await Promise.allSettled([acceptProposal("abc", now), dropProposal("abc")]);
    if (accepted.status === "fulfilled") {
      expect(rejected.status).toBe("rejected");
      expect(git.files()[payload.path]).toBe("Original\n\nAccepted thought");
    } else {
      expect(rejected).toMatchObject({ status: "fulfilled", value: true });
      expect(git.publications).toHaveLength(0);
      expect(git.files()[payload.path]).toBe("Original");
    }
  });
  it("a known invalid create stays pending and rejectable without consuming an accepting slot", async () => {
    const { acceptProposal, getProposal, dropProposal } = await import("../lib/proposals");
    queue.rows.abc = JSON.stringify({ ...payload, mode: "create" });
    await expect(acceptProposal("abc", now)).rejects.toThrow(/already exists/);
    expect((await getProposal("abc", now))?.state).not.toBe("accepting");
    expect(await dropProposal("abc")).toBe(true);
    expect(git.publications).toHaveLength(0);
  });
  it("cancels an uncertain create after a competing writer changes its precondition without editing the competing note", async () => {
    const { acceptProposal, cancelProposal, dropProposal } = await import("../lib/proposals");
    const path = "notes/new.md";
    queue.rows.abc = JSON.stringify({ ...payload, mode: "create", path });
    git.beforePublish = () => git.edit(path, "Competing create");
    await expect(acceptProposal("abc", now)).rejects.toMatchObject({ outcome: "uncertain" });
    expect(JSON.parse(queue.rows.abc).state).toBe("accepting");
    await expect(dropProposal("abc")).rejects.toThrow(/acceptance/);
    expect(git.files()[path]).toBe("Competing create");
    const recovered = await cancelProposal("abc", now);
    expect(recovered.outcome).toBe("canceled");
    expect(git.files()[path]).toBe("Competing create");
    expect(queue.rows.abc).toBeUndefined();
    expect((await acceptProposal("abc", now)).commitSha).toBe(recovered.commitSha);
  });
  it("rejects a modified receipt instead of treating it as a new operation", async () => {
    const { acceptProposal } = await import("../lib/proposals");
    await acceptProposal("abc", now);
    const receiptPath = Object.keys(git.files()).find(p => p.startsWith(".cortex/"))!;
    git.edit(receiptPath, JSON.stringify({ ...JSON.parse(git.files()[receiptPath]), path: "notes/other.md" }));
    await expect(acceptProposal("abc", now)).rejects.toThrow(/receipt/);
    expect(git.files()[payload.path]).toBe("Original\n\nAccepted thought");
  });
  it("bounds repeated unrelated ref conflicts and retains the recovery payload", async () => {
    const conflict = () => { git.edit(payload.path, `Writer ${git.commits.size}`); git.beforePublish = conflict; };
    git.beforePublish = conflict;
    const { acceptProposal } = await import("../lib/proposals");
    await expect(acceptProposal("abc", now)).rejects.toMatchObject({ outcome: "uncertain" });
    expect(git.urls.filter(url => url.includes("/git/refs/"))).toHaveLength(3);
    expect(git.files()[payload.path]).not.toContain("Accepted thought");
    expect(JSON.parse(queue.rows.abc).state).toBe("accepting");
  });
  it("preserves create/replace policy and stored-text transforms in the operation path", async () => {
    const { acceptProposal } = await import("../lib/proposals");
    queue.rows.abc = JSON.stringify({ ...payload, mode: "create" });
    await expect(acceptProposal("abc", now)).rejects.toThrow(/already exists/);
    queue.rows.abc = JSON.stringify({ ...payload, mode: "replace", path: "notes/missing.md" });
    await expect(acceptProposal("abc", now)).rejects.toThrow(/does not exist/);
    queue.rows.abc = JSON.stringify({ ...payload, content: "\u0000Clean" });
    await acceptProposal("abc", now);
    expect(git.files()[payload.path]).toBe("Original\n\nClean");
  });
  it("fails closed for malformed upstream head and an unverified receipt history lookup", async () => {
    const { acceptProposal } = await import("../lib/proposals");
    git.malformedHead = true;
    await expect(acceptProposal("abc", now)).rejects.toThrow();
    expect(git.publications).toHaveLength(0);
    git.malformedHead = false;
    await acceptProposal("abc", now);
    git.wrongHistory = true;
    await expect(acceptProposal("abc", now)).rejects.toThrow(/receipt|history/);
  });
});
