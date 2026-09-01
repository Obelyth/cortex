/**
 * The settings screen's write endpoints, derived from the address bar — the browser supplies
 * the secret from the URL it is already on, and it never appears in markup. One definition,
 * because settings-client and learning-client both post and two derivations is how they drift.
 */
export function settingsEndpoint(leaf: "save" | "actions"): string {
  let p = window.location.pathname;
  while (p.endsWith("/")) p = p.slice(0, -1);
  if (p.endsWith("/settings")) p = p.slice(0, -"/settings".length);
  return `${p}/settings/${leaf}`;
}
