import styles from "./console.module.css";

/**
 * What the browser gets while a console page assembles.
 *
 * Every page here is `force-dynamic` and gathers its own data — health() walks the whole corpus,
 * getContext() prices a real boot, the pulses each hit Postgres. Measured warm that is ~500-900 ms
 * before the first byte, and ~2 s on a cold instance. Without a loading boundary Next has nothing
 * to send in the meantime, so a click left the PREVIOUS page on screen, motionless, and the
 * console read as slow — the tab looked broken rather than busy.
 *
 * This is a boundary, not a cache. No data goes stale to get it: the page still computes
 * everything fresh, and this only fills the gap between the click and the answer. A dashboard
 * whose whole claim is that its numbers are true is the last place to start serving old ones for
 * the sake of feeling quick.
 *
 * Deliberately NOT a spinner. A spinner says "something is happening"; this says WHICH something,
 * in the shape the answer will take, so the eye is already in the right place when the real
 * numbers land and nothing jumps.
 */
export default function Loading() {
  return (
    <div className="conBody" aria-busy="true" aria-live="polite">
      <div className="ovRead">
        <div className={styles.label} style={{ marginBottom: 18 }}>
          reading the brain…
        </div>

        {/* The hero: one big number and its supporting lines, held open at the size it will be so
            the layout does not shift when the count arrives. */}
        <div className="skelHero">
          <div className="skelNum" />
          <div className="skelLines">
            <div className="skelLine" style={{ width: "34%" }} />
            <div className="skelLine" style={{ width: "52%" }} />
            <div className="skelLine" style={{ width: "44%" }} />
          </div>
        </div>

        {/* The two columns, at the real gutter, so the shape is honest about what is coming. */}
        <div className="ovGrid" style={{ marginTop: 40 }}>
          <div className="ovCol">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skelCard">
                <div className="skelLine" style={{ width: "22%", height: 11 }} />
                <div className="skelLine" style={{ width: "88%" }} />
                <div className="skelLine" style={{ width: "76%" }} />
                <div className="skelLine" style={{ width: "61%" }} />
              </div>
            ))}
          </div>
          <div className="ovCol">
            {[0, 1].map((i) => (
              <div key={i} className="skelCard">
                <div className="skelLine" style={{ width: "40%", height: 11 }} />
                <div className="skelLine" style={{ width: "92%" }} />
                <div className="skelLine" style={{ width: "70%" }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
