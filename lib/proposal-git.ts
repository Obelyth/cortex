import { createHash } from "node:crypto";
import { branch, gh, repo, type BrainFile } from "./github";

export type ProposalPayload = { path: string; mode: "create" | "replace" | "append"; content: string };
export type ProposalOperation = { id: string; receiptPath: string; digest: string; path: string; mode: ProposalPayload["mode"] };
type Receipt = Omit<ProposalOperation, "receiptPath"> & { parentSha: string } & (
  { version: 1; targetBlobSha: string } |
  { version: 2; outcome: "canceled"; targetBlobSha: string | null }
);
export type OperationResult = { outcome: "committed" | "canceled"; path: string; commitSha: string };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const receiptPath = (id: string) => `.cortex/accepted-proposals/${hash(id)}.json`;
const SHA = /^[a-f0-9]{40}$/;
const MAX_ATTEMPTS = 3;

export class ProposalOutcomeUncertain extends Error {
  readonly outcome = "uncertain";
  constructor(detail: string) {
    super(`Proposal outcome uncertain: ${detail}. Retry the same proposal id to resolve its durable outcome; it may already be committed or canceled.`);
  }
}

export function proposalOperation(environment: string, id: string, p: ProposalPayload): ProposalOperation {
  const operationId = `proposal/${environment}/${id}`;
  return { id: operationId, receiptPath: receiptPath(operationId), path: p.path, mode: p.mode,
    digest: hash(JSON.stringify({ path: p.path, mode: p.mode, content: p.content })) };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed Git object");
  return value as Record<string, unknown>;
}
function sha(value: unknown): string {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error("malformed Git SHA");
  return value;
}
const base = () => `/repos/${repo()}`;
const refPath = () => `heads/${encodeURIComponent(branch())}`;

async function json(path: string, init?: RequestInit): Promise<unknown> {
  const res = await gh(base() + path, { cache: "no-store", ...init });
  if (!res.ok) throw new Error(`GitHub proposal operation: HTTP ${res.status}`);
  return res.json();
}
async function head(): Promise<string> {
  const data = object(await json(`/git/ref/${refPath()}`));
  if (data.ref !== `refs/heads/${branch()}` || object(data.object).type !== "commit") throw new Error("malformed Git branch ref");
  return sha(object(data.object).sha);
}
async function commit(id: string) {
  const data = object(await json(`/git/commits/${id}`));
  if (sha(data.sha) !== id || !Array.isArray(data.parents)) throw new Error("malformed Git commit");
  return { tree: sha(object(data.tree).sha), parents: data.parents.map(p => sha(object(p).sha)) };
}
async function file(path: string, at: string): Promise<BrainFile | null> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await gh(`${base()}/contents/${encoded}?ref=${at}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub proposal file: HTTP ${res.status}`);
  const data = object(await res.json());
  if (data.encoding !== "base64" || typeof data.content !== "string") throw new Error("malformed Git file");
  const encodedBody = data.content.replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedBody)) throw new Error("malformed Git base64");
  return { path, sha: sha(data.sha), content: Buffer.from(encodedBody, "base64").toString("utf8") };
}
function receipt(raw: string, id: string, expected?: ProposalOperation): Receipt {
  const r = object(JSON.parse(raw));
  const canceled = r.version === 2 && r.outcome === "canceled";
  if ((r.version !== 1 && !canceled) || r.id !== id || typeof r.path !== "string" || typeof r.digest !== "string" || !/^[a-f0-9]{64}$/.test(r.digest) ||
    !["create", "replace", "append"].includes(String(r.mode))) throw new Error("malformed proposal receipt");
  sha(r.parentSha);
  if (!canceled || r.targetBlobSha !== null) sha(r.targetBlobSha);
  if (expected && (r.path !== expected.path || r.mode !== expected.mode || r.digest !== expected.digest)) throw new Error("proposal receipt payload mismatch");
  return r as Receipt;
}

/** A path-filtered history query is bounded to two results. This is an immutable receipt:
 * exactly one change must exist. Verify that candidate's parent lacked the receipt and that
 * its tree contains both the receipt and the expected note blob. Never trust a history row alone.
 * Deleting receipts or rewriting history invalidates the normal retry guarantee. */
async function resolve(at: string, id: string, expected?: ProposalOperation): Promise<OperationResult | null> {
  const path = receiptPath(id);
  const f = await file(path, at);
  if (!f) return null;
  const r = receipt(f.content, id, expected);
  const rows = await json(`/commits?sha=${at}&path=${encodeURIComponent(path)}&per_page=2`);
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error("proposal receipt history is ambiguous");
  const original = sha(object(rows[0]).sha);
  const c = await commit(original);
  if (c.parents.length !== 1 || c.parents[0] !== r.parentSha) throw new Error("proposal receipt parent mismatch");
  const [introduced, previous, target] = await Promise.all([file(path, original), file(path, r.parentSha), file(r.path, original)]);
  if (introduced?.sha !== f.sha || introduced.content !== f.content || previous || (target?.sha ?? null) !== r.targetBlobSha) throw new Error("proposal receipt effect mismatch");
  if (r.version === 2 && (await file(r.path, r.parentSha))?.sha !== target?.sha) throw new Error("cancellation receipt changed the target");
  return { outcome: r.version === 1 ? "committed" : "canceled", path: r.path, commitSha: original };
}

export async function findProposalOperation(environment: string, id: string): Promise<OperationResult | null> {
  try { return await resolve(await head(), `proposal/${environment}/${id}`); }
  catch (e) { throw new ProposalOutcomeUncertain(e instanceof Error ? e.message : String(e)); }
}

/** Target and identity enter one tree and one single-parent commit. force:false rejects a
 * candidate built on an obsolete sibling head. Object creation never publishes the effect;
 * only the ref update does. Every retry starts with a fresh, authoritative receipt lookup. */
export async function commitProposalOperation(
  operation: ProposalOperation,
  derive: (fresh: BrainFile | null) => string,
  beforeWrite?: () => Promise<void>,
): Promise<OperationResult> {
  return publishProposalOperation(operation, derive, beforeWrite);
}

/** Cancellation publishes only a terminal receipt, at the same operation path as acceptance.
 * It shares the complete retry/publication path, so a delayed accept resolves its winner. */
export async function cancelProposalOperation(operation: ProposalOperation, beforeWrite: () => Promise<void>): Promise<OperationResult> {
  return publishProposalOperation(operation, undefined, beforeWrite);
}

async function publishProposalOperation(
  operation: ProposalOperation,
  derive: ((fresh: BrainFile | null) => string) | undefined,
  beforeWrite?: () => Promise<void>,
): Promise<OperationResult> {
  if (operation.receiptPath !== receiptPath(operation.id)) throw new Error("invalid proposal receipt path");
  let lastError: unknown;
  let claimed = false;
  const claim = async () => { if (!claimed) { await beforeWrite?.(); claimed = true; } };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let parent: string;
    try {
      parent = await head();
      const found = await resolve(parent, operation.id, operation);
      if (found) return found;
    } catch (e) { throw new ProposalOutcomeUncertain(e instanceof Error ? e.message : String(e)); }
    // Validation/derivation failures precede any mutation and must not be retried.
    const c = await commit(parent);
    let content: string | undefined;
    let previousTarget: BrainFile | null;
    try { previousTarget = await file(operation.path, parent); content = derive?.(previousTarget); }
    catch (e) {
      try { const found = await resolve(await head(), operation.id, operation); if (found) return found; }
      catch (lookupError) { throw new ProposalOutcomeUncertain(lookupError instanceof Error ? lookupError.message : String(lookupError)); }
      if (claimed) throw new ProposalOutcomeUncertain(`acceptance already started; ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
    // No Git objects have been created yet. Invalid create/replace payloads stay pending and
    // rejectable; a reject winning this conditional claim prevents every Git mutation.
    try { await claim(); }
    catch (claimError) {
      // Another accepter may have finalized after our pinned read. Losing a queue claim is
      // never evidence of a missing Git outcome: resolve the expected receipt first.
      try { const found = await resolve(await head(), operation.id, operation); if (found) return found; }
      catch (e) { throw new ProposalOutcomeUncertain(e instanceof Error ? e.message : String(e)); }
      throw claimError;
    }
    const post = (path: string, body: unknown) => json(path, { method: "POST", body: JSON.stringify(body) });
    try {
      const targetBlobSha = derive
        ? sha(object(await post("/git/blobs", { content, encoding: "utf-8" })).sha)
        : previousTarget?.sha ?? null;
      const fields = { id: operation.id, path: operation.path, mode: operation.mode, digest: operation.digest, parentSha: parent };
      const r: Receipt = derive
        ? { ...fields, version: 1, targetBlobSha: targetBlobSha! }
        : { ...fields, version: 2, outcome: "canceled", targetBlobSha: previousTarget?.sha ?? null };
      const receiptBlob = sha(object(await post("/git/blobs", { content: JSON.stringify(r), encoding: "utf-8" })).sha);
      const tree = sha(object(await post("/git/trees", { base_tree: c.tree, tree: [
        ...(derive ? [{ path: operation.path, mode: "100644", type: "blob", sha: targetBlobSha }] : []),
        { path: operation.receiptPath, mode: "100644", type: "blob", sha: receiptBlob },
      ] })).sha);
      const candidate = object(await post("/git/commits", { message: derive ? `brain: ${operation.mode} ${operation.path}` : `brain: cancel proposal ${operation.id}`, tree, parents: [parent] }));
      const candidateSha = sha(candidate.sha);
      if (sha(object(candidate.tree).sha) !== tree || !Array.isArray(candidate.parents) || candidate.parents.length !== 1 || sha(object(candidate.parents[0]).sha) !== parent) throw new Error("malformed candidate commit");
      const updated = object(await json(`/git/refs/${refPath()}`, { method: "PATCH", body: JSON.stringify({ sha: candidateSha, force: false }) }));
      if (updated.ref !== `refs/heads/${branch()}` || object(updated.object).type !== "commit" || sha(object(updated.object).sha) !== candidateSha) throw new Error("malformed updated ref");
      return { outcome: derive ? "committed" : "canceled", path: operation.path, commitSha: candidateSha };
    } catch (e) { lastError = e; }
  }
  // Even the final failed/ambiguous update may have landed: resolve once more before stopping.
  try { const found = await resolve(await head(), operation.id, operation); if (found) return found; }
  catch (e) { throw new ProposalOutcomeUncertain(e instanceof Error ? e.message : String(e)); }
  throw new ProposalOutcomeUncertain(lastError instanceof Error ? lastError.message : "Git retry limit reached");
}
