import ConsoleDemo from "./console-demo";
import styles from "./console-demo.module.css";

/**
 * The landing IS the console. No hero, no sections — the first thing a visitor sees is the
 * instrument itself, full-viewport, running on synthetic data (the badge in its top bar says
 * so). The prose surfaces survive at /tools and /guide, and the console's own guide screen
 * carries the wiring story; nothing here links a gated route.
 */
export default function Landing() {
  return (
    <div className={styles.page}>
      <ConsoleDemo />
    </div>
  );
}
