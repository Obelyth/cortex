import { AskBand, AskProvider, AskReadout, AskTree } from "./ask-explorer";
import type { AskAnswer, AskModel } from "./ask-model";

/**
 * The Ask screen's markup (v2), with its data handed in. page.tsx builds the model from the live
 * loaders and renders this; scripts/dev/render-ask.tsx builds one from fixtures and renders the
 * same thing on both grounds, so the layout can be looked at without a database, a GitHub token
 * or a deploy.
 *
 * Top to bottom: 01 · the ask band on the inverted ground, spanning both columns because the
 * input governs both — its text filters the tree on the left and, on Enter, fills the readout on
 * the right; then the body as READOUT followed by the full-width EXPLORER. These wrappers are the server's
 * (the kinetic contract: entrances ride server-rendered nodes only); everything inside them is the
 * client's, one provider so the input, the tree and the readout share one state.
 */
export function AskScreen({ model, fixtureAnswer = null }: Readonly<{ model: AskModel; fixtureAnswer?: AskAnswer | null }>) {
  return (
    <AskProvider model={model} fixtureAnswer={fixtureAnswer}>
      <section className="askBand" aria-labelledby="askBandTitle" data-cx="rise">
        <div className="askBandIn">
          <AskBand />
        </div>
      </section>
      <div className="askBody">
        <section className="askReadout" aria-label="The answer" data-cx="rise">
          <AskReadout />
        </section>
        <section className="askExplorer" aria-label="The corpus" data-cx="rise">
          <AskTree />
        </section>
      </div>
    </AskProvider>
  );
}
