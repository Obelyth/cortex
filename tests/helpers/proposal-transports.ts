import { createHash } from "node:crypto";

const sha = (s: string) => createHash("sha1").update(s).digest("hex");
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Git transport only: immutable trees/commits and fast-forward branch publication.
 * No proposal awareness or deduplication: those must come from production composition. */
export class GitTransport {
  trees = new Map<string, Record<string, string>>();
  commits = new Map<string, { tree: { sha: string }; parents: { sha: string }[] }>();
  blobs = new Map<string, string>();
  head: string;
  publications: string[] = [];
  beforePublish?: () => void;
  timeout: "before" | "after" | null = null;
  failReceipt = false;
  failReceiptAfterTimeout = false;
  failIndex = false;
  malformedHead = false;
  wrongHistory = false;
  urls: string[] = [];

  constructor() { this.head = this.addCommit({ "notes/idea.md": "Original" }); }
  addCommit(files: Record<string, string>, parent?: string) {
    const tree = Object.fromEntries(Object.entries(files).map(([p, content]) => {
      const id = sha(content); this.blobs.set(id, content); return [p, id];
    }));
    const treeSha = sha(JSON.stringify(tree)); this.trees.set(treeSha, tree);
    const commit = { tree: { sha: treeSha }, parents: parent ? [{ sha: parent }] : [] };
    const id = sha(JSON.stringify(commit)); this.commits.set(id, commit); return id;
  }
  files(head = this.head) {
    return Object.fromEntries(Object.entries(this.trees.get(this.commits.get(head)!.tree.sha)!).map(([p, s]) => [p, this.blobs.get(s)!]));
  }
  edit(path: string, content: string) { this.head = this.addCommit({ ...this.files(), [path]: content }, this.head); }

  fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input)); this.urls.push(url.toString());
    const path = decodeURIComponent(url.pathname.replace(/^\/repos\/test\/brain/, ""));
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (path.startsWith("/git/ref/")) return response(this.malformedHead ? {} : { ref: "refs/heads/feature/proposals", object: { type: "commit", sha: this.head } });
    if (path.startsWith("/contents/") && !init.method) {
      const p = path.slice(10);
      if (p.startsWith(".cortex/") && this.failReceipt) throw new Error("receipt lookup unavailable");
      const ref = url.searchParams.get("ref")!;
      const head = this.commits.has(ref) ? ref : this.head;
      const tree = this.trees.get(this.commits.get(head)!.tree.sha)!;
      if (!(p in tree)) return response({}, 404);
      return response({ encoding: "base64", sha: tree[p], content: Buffer.from(this.blobs.get(tree[p])!).toString("base64") });
    }
    if (path.startsWith("/contents/") && init.method === "PUT") {
      const p = path.slice(10); if (p === "INDEX.md" && this.failIndex) return response({}, 503);
      const oldSha = this.trees.get(this.commits.get(this.head)!.tree.sha)![p];
      if (oldSha !== body.sha) return response({}, 409);
      this.edit(p, Buffer.from(body.content, "base64").toString()); this.publications.push(this.head);
      return response({ commit: { sha: this.head } });
    }
    if (path === "/git/blobs") { const id = sha(body.content); this.blobs.set(id, body.content); return response({ sha: id }, 201); }
    if (path === "/git/trees") {
      const tree = { ...this.trees.get(body.base_tree) };
      for (const entry of body.tree) {
        if (entry.sha) tree[entry.path] = entry.sha;
        else { const id = sha(entry.content); this.blobs.set(id, entry.content); tree[entry.path] = id; }
      }
      const id = sha(JSON.stringify(tree)); this.trees.set(id, tree); return response({ sha: id }, 201);
    }
    if (path.startsWith("/git/trees/")) {
      if (this.failIndex) return response({}, 503);
      return response({ tree: Object.keys(this.files()).map(path => ({ type: "blob", path })) });
    }
    if (path === "/git/commits") {
      const commit = { tree: { sha: body.tree }, parents: body.parents.map((sha: string) => ({ sha })) };
      const id = sha(JSON.stringify(commit)); this.commits.set(id, commit); return response({ sha: id, ...commit }, 201);
    }
    if (path.startsWith("/git/commits/")) { const id = path.split("/").at(-1)!; return response({ sha: id, ...this.commits.get(id) }); }
    if (path.startsWith("/git/refs/") && init.method === "PATCH") {
      const hook = this.beforePublish; this.beforePublish = undefined; hook?.();
      const timeout = this.timeout; this.timeout = null;
      if (timeout === "before") { this.failReceipt = this.failReceiptAfterTimeout; throw new Error("lost before ref"); }
      const candidate = this.commits.get(body.sha)!;
      if (body.force !== false || (candidate.parents[0].sha !== this.head && body.sha !== this.head)) return response({}, 422);
      if (body.sha !== this.head) this.publications.push(body.sha);
      this.head = body.sha;
      if (timeout === "after") { this.failReceipt = this.failReceiptAfterTimeout; throw new Error("lost after ref"); }
      return response({ ref: "refs/heads/feature/proposals", object: { type: "commit", sha: this.head } });
    }
    if (path === "/commits") {
      const p = url.searchParams.get("path")!; let head = url.searchParams.get("sha")!;
      const matches: { sha: string }[] = [];
      while (head) {
        const commit = this.commits.get(head)!; const parent = commit.parents[0]?.sha;
        if (this.files(head)[p] !== (parent ? this.files(parent)[p] : undefined)) matches.push({ sha: head });
        head = parent;
      }
      return response(this.wrongHistory ? [] : matches.slice(0, 2));
    }
    throw new Error(`unhandled Git request ${init.method ?? "GET"} ${url}`);
  };
}

/** What lua-cjson does with a JSON text: JSON.parse, except that a \\uD800-\\uDFFF escape with
 * no partner is an error, not a lone surrogate in the result. JSON.parse round-trips what
 * JSON.stringify emits for an emoji cut in half; cjson refuses it, and a fake that accepted it
 * could not show the unit suite the row the real queue would sweep. */
export function cjsonDecode(text: string): any {
  const value = JSON.parse(text);
  const walk = (v: unknown): void => {
    if (typeof v === "string") { if (!v.isWellFormed()) throw new Error("cjson: invalid unicode escape code"); }
    else if (v && typeof v === "object") for (const inner of Object.values(v)) walk(inner);
  };
  walk(value);
  return value;
}

/** Contract stand-in for Redis transport. Real Lua is separately exercised by opt-in tests. */
export class QueueTransport {
  rows: Record<string, string> = {};
  fail = false;
  failFinalize = false;
  hgetall = async () => { if (this.fail) throw new Error("KV unavailable"); return { ...this.rows }; };
  hset = async (_key: string, rows: Record<string, string>) => { Object.assign(this.rows, rows); return 1; };
  hdel = async (_key: string, id: string) => { if (this.failFinalize) throw new Error("cleanup unavailable"); const had = id in this.rows; delete this.rows[id]; return Number(had); };
  createScript = (_script: string) => ({ exec: async (_keys: string[], args: (string | number)[]) => {
    if (this.fail) throw new Error("KV unavailable");
    const [action, time, ttl, max, id, raw] = args; const now = Number(time);
    if (action === "finalize" && this.failFinalize) throw new Error("cleanup unavailable");
    // The Lua's `live` predicate, one to one: admission and the sweep share it.
    const live = (key: string, value: string) => {
      try {
        const p = cjsonDecode(value);
        return p.id === key && typeof p.ts === "number" && typeof p.path === "string" && typeof p.content === "string" && ["create", "replace", "append"].includes(p.mode) && (p.state === "accepting" || p.ts + Number(ttl) > now);
      } catch { return false; }
    };
    for (const [key, value] of Object.entries(this.rows)) if (!live(key, value)) delete this.rows[key];
    const key = String(id); const p = this.rows[key] ? cjsonDecode(this.rows[key]) : null;
    if (action === "admit") {
      if (p) return ["collision"];
      if (!live(key, String(raw))) return ["invalid"];
      if (Object.keys(this.rows).length >= Number(max)) return ["full"];
      this.rows[key] = String(raw); return ["ok"];
    }
    if (action === "list") return ["ok", ...Object.values(this.rows)];
    if (action === "get") return p ? ["ok", this.rows[key]] : ["missing"];
    const decodeExpected = () => { try { return cjsonDecode(String(raw)); } catch { return null; } };
    if (action === "claim") {
      if (!p) return ["missing"];
      if (raw) {
        const expected = decodeExpected();
        if (!expected || ["id", "ts", "path", "mode", "content"].some(field => p[field] !== expected[field])) return ["conflict"];
      }
      this.rows[key] = JSON.stringify({ ...p, state: "accepting" }); return ["ok", this.rows[key]];
    }
    if (action === "reject" && p?.state === "accepting") return ["conflict"];
    if (action === "finalize" && p) {
      const expected = raw ? decodeExpected() : null;
      if (!expected || p.state !== "accepting" || ["id", "ts", "path", "mode", "content"].some(field => p[field] !== expected[field])) return ["conflict"];
    }
    if (action === "reject" || action === "finalize") { delete this.rows[key]; return [p ? "ok" : "missing"]; }
    throw new Error("unknown queue action");
  } });
}
