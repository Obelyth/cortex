"use client";
import { agoIso, type Save } from "@/lib/overview";
import { useLens } from "../lens";
import { commitLens } from "./lens-bodies";

/** Recent saves (W14): every write is a commit. A row opens the commit in the lens (L8). */
export function Saves({ saves, commitBase, now, sha }: Readonly<{ saves: Save[]; commitBase: string | null; now: number; sha: string }>) {
  const lens = useLens();
  if (saves.length === 0) return <div className="ovEmpty">save history unreachable this render</div>;
  return (
    <>
      {saves.map((c) => (
        <button key={c.sha} type="button" className="ovSave" onClick={() => lens.open(commitLens(c, commitBase, sha, lens.open))}>
          <span className="ovSaveSha">{c.sha}</span>
          <span className="ovSaveMsg">{c.message}</span>
          <span className="ovSaveAgo">{agoIso(c.date, now)}</span>
        </button>
      ))}
    </>
  );
}
