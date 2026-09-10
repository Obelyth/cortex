/** Pure setup checks and an injectable, read-only deployment probe. No CLI side effects. */
export function requireGitCommitIdentity(runGit) {
  try {
    runGit(["-c", "user.useConfigOnly=true", "var", "GIT_AUTHOR_IDENT"]);
    runGit(["-c", "user.useConfigOnly=true", "var", "GIT_COMMITTER_IDENT"]);
  } catch {
    throw new Error("Configure a Git author name and email, then rerun setup. No remote brain repository was created. Setup does not invent an identity or change Git configuration.");
  }
}

export function brainRepository(metadata, requested) {
  if (typeof metadata?.full_name !== "string" || metadata.full_name.toLowerCase() !== requested.toLowerCase()) {
    throw new Error("GitHub did not confirm the requested repository.");
  }
  if (metadata.private !== true || metadata.archived !== false) {
    throw new Error("The brain repository must be private and not archived. No deployment settings were changed.");
  }
  if (typeof metadata.default_branch !== "string" || !metadata.default_branch.trim()) {
    throw new Error("The brain repository needs an initial commit and a default branch before setup can continue.");
  }
  return { repo: metadata.full_name, branch: metadata.default_branch };
}

function hostname(value) {
  // Provider records contain bare DNS hostnames, never paths or credential-bearing URLs.
  if (typeof value !== "string" || value.length > 253 || !value.includes(".") ||
      !value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
      /^[\d.]+$/.test(value) || /\.(localhost|local)$/i.test(value)) {
    throw new Error("Vercel returned an invalid deployment hostname.");
  }
  return value.toLowerCase();
}

function deploymentHost(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Expected the HTTPS deployment URL from Vercel, without a path or credentials.");
  }
  return hostname(url.hostname);
}

function readyDeployment(metadata, projectId) {
  if (!projectId || metadata?.projectId !== projectId || !metadata.id ||
      metadata.target !== "production" || metadata.readyState !== "READY") {
    throw new Error("Vercel did not confirm a ready production deployment for the linked project.");
  }
}

export async function resolveProductionOrigin(deploymentUrl, projectId, readDeployment) {
  const deployedHost = deploymentHost(deploymentUrl);
  const deployed = await readDeployment(deployedHost);
  readyDeployment(deployed, projectId);
  if (hostname(deployed.url) !== deployedHost) {
    throw new Error("Vercel's deployment record does not match the deployed URL.");
  }
  if (!Array.isArray(deployed.alias) || !deployed.alias.length) {
    throw new Error("No production domain is assigned. Assign one in Vercel and rerun setup; no connector secret was sent.");
  }
  const aliases = deployed.alias.map(hostname);
  // Prefer Vercel's managed domain over a custom domain that might redirect elsewhere.
  const alias = aliases.find((name) => name.endsWith(".vercel.app")) ?? aliases[0];
  const resolved = await readDeployment(alias);
  readyDeployment(resolved, projectId);
  if (resolved.id !== deployed.id || hostname(resolved.url) !== deployedHost) {
    throw new Error("The production domain no longer points to this deployment. No connector secret was sent.");
  }
  return `https://${alias}`;
}

export function deploymentLookupPath(host, orgId) {
  return `/v13/deployments/${encodeURIComponent(hostname(host))}${orgId?.startsWith("team_") ? `?teamId=${encodeURIComponent(orgId)}` : ""}`;
}

export async function checkDeployment({ deploymentUrl, projectId, secret, token, readDeployment, fetcher = fetch }) {
  const origin = await resolveProductionOrigin(deploymentUrl, projectId, readDeployment);
  const hasSecret = typeof secret === "string" && Boolean(secret.trim());
  if (!hasSecret && (typeof token !== "string" || !token.trim())) throw new Error("No trusted access credential is available.");
  // No child-process arguments, no redirect to an unverified host, and no paid model call.
  const response = await fetcher(`${origin}${hasSecret ? `/api/s/${encodeURIComponent(secret)}/mcp` : "/api/mcp"}`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      ...(!hasSecret ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
  });
  if (!response.ok) throw new Error("The verified deployment did not accept the MCP check.");
  const text = await response.text();
  const messages = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split(/\r?\n\r?\n/).flatMap((event) => {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      return data ? [JSON.parse(data)] : [];
    })
    : [JSON.parse(text)];
  const result = messages.find((message) => message.id === 1 && message.result)?.result;
  if (!Array.isArray(result?.tools) || result.tools.some((tool) => typeof tool?.name !== "string")) {
    throw new Error("The verified deployment did not return a tool roster.");
  }
  return { origin, tools: result.tools.map((tool) => tool.name).sort() };
}
