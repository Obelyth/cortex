/**
 * What the browser gets while the Ask screen assembles: the corpus, the heat view, the pins
 * and the archive listing are all read before the first byte. A boundary, not a cache — the
 * page still computes everything fresh; this only fills the gap between the click and the
 * answer, in the shape the answer will take. Not a spinner: it says WHICH something.
 */
export default function Loading() {
  return (
    <div className="askBody" aria-busy="true" aria-live="polite">
      <section className="askReadout" aria-label="The answer">
        <div className="askAnswerCard">
          <span className="askEyebrow">The answer lands here</span>
        </div>
      </section>
      <section className="askExplorer" aria-label="The corpus">
        <div className="askExHead">
          <div className="askExTitle">
            <span className="askLbl">The corpus</span>
            <span className="askLblMeta">reading the corpus · heat · pins…</span>
          </div>
        </div>
      </section>
    </div>
  );
}
