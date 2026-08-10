import type { loadCorpus } from "../../lib/corpus";

/**
 * The corpus fixture the health suites share — it lived as a byte-identical block in each,
 * which is how the customer repo's duplication gate caught the port. The vi.mock() line itself
 * stays inline in every suite: mock factories are hoisted above imports, so a shared factory
 * is the one piece that cannot move here.
 */
export function corpus(files: Array<[string, string]>) {
  return {
    sha: "e".repeat(40),
    bytes: files.reduce((a, [, t]) => a + t.length, 0),
    files: new Map(files),
  } as unknown as Awaited<ReturnType<typeof loadCorpus>>;
}
