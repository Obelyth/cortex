"use client";

/**
 * The Welcome landing — the Cortex Welcome design implemented over window scrolling.
 * Hero → principles → how → connect → the console arrival (a 260vh pinned section where
 * the working demo sheet settles in as you scroll) → footer. The animation layer is
 * written straight to the DOM rather than through React state: it is an animation, and
 * re-reconciling a landing with a live console inside it on every scroll frame is the
 * wrong trade. Reveal-on-enter is fail-safe: nothing is hidden until the observer's
 * first callback proves it delivers, so a silent observer leaves a readable page.
 */

import { useEffect, useRef, useState } from "react";
import ConsoleDemo from "./console-demo";
import styles from "./welcome.module.css";

const HERO_STATS = [
  { n: "68", label: "notes in your brain" },
  { n: "9", label: "things your brain can do" },
  { n: "4", label: "places you can ask" },
  { n: "0", label: "things to keep in sync" },
];

const PRINCIPLES = [
  { n: "01", title: "One place", body: "Every note lives in one place, and Claude reads all of it each time. Nothing can drift out of date, because there is no copy to keep in sync." },
  { n: "02", title: "Every surface", body: "Terminal, web, phone, desktop. Whichever one you open, you are talking to the same notes at the same moment in time." },
  { n: "03", title: "Proven quotes", body: "Every answer names its source, and that quote is checked against the file automatically. Anything that cannot be proven is flagged, not quietly dropped." },
];

const STEPS = [
  { n: "01", name: "You ask", rule: "var(--accent-cyan)", body: "A question in plain language, from wherever you happen to be working." },
  { n: "02", name: "Claude reads", rule: "var(--ob-steel-300)", body: "All of your notes, as they are right now — not a summary and not an old copy." },
  { n: "03", name: "It cites", rule: "var(--ob-steel-300)", body: "The answer comes back naming the note and the exact passage it came from." },
  { n: "04", name: "It is checked", rule: "var(--ob-warn)", body: "That quote is matched against the file automatically, and the verdict travels with the answer." },
];

const STAMPS = [
  { tag: "VERIFIED", cls: "p_pass", line: "The quote really is in that note, word for word. It proves the source, not that the reasoning is right." },
  { tag: "SUPERSEDED", cls: "p_warn", line: "The quote is real, but you have since corrected that passage. Old notes read exactly like current ones." },
  { tag: "CORRECTED", cls: "p_processing", line: "The quote is real and current — it sits beside the wording it replaced. Read the new claim, not the old one." },
  { tag: "PARTIAL", cls: "p_warn", line: "The same wording appears in more than one note, so we cannot say which one it came from." },
  { tag: "NOT IN BRAIN", cls: "p_processing", line: "Nothing in your notes covers it, and Claude said so instead of guessing." },
  { tag: "UNVERIFIED", cls: "p_fail", line: "The quote could not be found where it was said to be. Shown anyway and flagged, rather than hidden." },
];

const RITUALS = [
  { tag: "Starting up", text: "Start a session and Claude picks up who you are, what you are working on, and the last week of notes." },
  { tag: "Jotting down", text: "Say “remember this” on any device and it lands in today's log, timestamped. You get a receipt when it is saved." },
  { tag: "Wrapping up", text: "When you finish, what happened goes to the project page and the daily log — same habit on desktop or phone." },
];

const CMD = 'claude mcp add --transport http cortex https://<host>/api/mcp --header "Authorization: Bearer <MCP_TOKEN>"';
const URL_ALIAS = "https://<host>/api/s/<secret>/mcp";
const REPO = "https://github.com/Obelyth/cortex";

function GitHubIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onCopy = () => {
    const done = () => {
      setCopied(true);
      clearTimeout(t.current);
      t.current = setTimeout(() => setCopied(false), 1800);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, done);
    else done();
  };
  return (
    <button type="button" className={`${styles.copyBtn} ${copied ? styles.copied : ""}`} onClick={onCopy} aria-label={label}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
      </svg>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Emblem mark from the design: hexagon core, one cyan node. */
function Logo() {
  return (
    <span className={styles.logo}>
      <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">
        <g stroke="var(--ob-snow-bright)" strokeWidth="1.5" strokeLinecap="round">
          <line x1="12" y1="8" x2="12" y2="5.2" /><line x1="8.57" y1="14.06" x2="6.17" y2="15.51" /><line x1="15.43" y1="14.06" x2="17.83" y2="15.51" />
        </g>
        <path d="M12 8 L15.46 10 L15.46 14 L12 16 L8.54 14 L8.54 10 Z" fill="var(--ob-snow-bright)" />
        <circle cx="12" cy="2.9" r="2.3" fill="var(--ob-cyan-500)" />
        <circle cx="4.2" cy="16.7" r="2.3" fill="var(--ob-snow-bright)" />
        <circle cx="19.8" cy="16.7" r="2.3" fill="var(--ob-snow-bright)" />
      </svg>
    </span>
  );
}

/** Scroll to the point in the pinned section where the sheet has settled. */
function toConsole(e: React.MouseEvent) {
  const sec = document.getElementById("console");
  if (!sec) return;
  e.preventDefault();
  const target = sec.offsetTop + (sec.offsetHeight - window.innerHeight) * 0.72;
  window.scrollTo({ top: target, behavior: "smooth" });
}

export default function Welcome() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = root.current;
    if (!box) return;
    const q = (sel: string) => box.querySelector<HTMLElement>(sel);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cleanups: Array<() => void> = [];

    /* ------------------------------------------------ scroll-driven layer --- */
    let lastP = -1;
    let lastTop = -1;
    let flowEls: HTMLElement[] = [];
    const onScroll = () => {
      const view = window.innerHeight;
      const top = window.scrollY;
      const rail = q("[data-rail]");
      const max = Math.max(1, document.documentElement.scrollHeight - view);
      if (rail) rail.style.width = ((Math.min(1, top / max)) * 100).toFixed(2) + "%";
      const nav = q("[data-nav]");
      if (nav) nav.classList.toggle(styles.navScrolled, top > 24);

      const el = document.getElementById("console");
      if (el) {
        const r = el.getBoundingClientRect();
        const travel = Math.max(1, r.height - view);
        const p = Math.min(1, Math.max(0, -r.top / travel));
        if (Math.abs(p - lastP) > 0.0015 || top !== lastTop) {
          lastP = p;
          lastTop = top;
          const ease = 1 - Math.pow(1 - Math.min(1, p / 0.62), 3);
          // the lead is out of flow and the pin reserves a bottom band for the hint,
          // so the only thing the fit has to clear is the pin's own padding
          const rest = Math.min(1, (window.innerWidth - 96) / 1280, (view - 86) / 864);
          const scale = rest * (0.68 + 0.32 * ease);
          const lift = 96 * (1 - ease);
          const lead = Math.max(0, 1 - p / 0.34);
          const sheet = q("[data-sheet]");
          if (sheet) {
            sheet.style.transform = `translateY(${lift.toFixed(1)}px) scale(${scale.toFixed(3)})`;
            sheet.style.opacity = (0.15 + 0.85 * Math.min(1, p / 0.4)).toFixed(3);
          }
          const leadEl = q("[data-lead]");
          if (leadEl) {
            leadEl.style.opacity = lead.toFixed(3);
            leadEl.style.transform = `translateY(${(-18 * (1 - lead)).toFixed(1)}px)`;
          }
          const hint = q("[data-hint]");
          if (hint) hint.style.opacity = p > 0.72 ? "1" : "0";
        }
      }

      // content drifts a few px against the field as it crosses the viewport
      if (!reduce) {
        if (!flowEls.length) flowEls = [...box.querySelectorAll<HTMLElement>("[data-flow]")];
        const mid = view / 2;
        for (const fe of flowEls) {
          const b = fe.getBoundingClientRect();
          if (b.bottom < -200 || b.top > view + 200) continue;
          const d = (b.top + b.height / 2 - mid) / view;
          fe.style.transform = `translate3d(0,${(Math.max(-1.6, Math.min(1.6, d)) * -11).toFixed(2)}px,0)`;
        }
      }
    };
    // Sampled on a timer as well as bound to scroll: which node actually emits scroll
    // events varies by host (embedded webviews scroll the viewport without firing them
    // on window), and the arrival has to be correct the moment it is looked at. The
    // guards inside keep an idle tick to a couple of rect reads.
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    const tick = setInterval(() => {
      try {
        onScroll();
      } catch {
        /* geometry not ready */
      }
    }, 40);
    cleanups.push(() => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      clearInterval(tick);
    });
    onScroll();

    /* --------------------------------------------------- reveal-on-enter --- */
    const nodes = [...box.querySelectorAll<HTMLElement>("[data-reveal]")];
    const show = (n: HTMLElement) => {
      n.style.opacity = "1";
      n.style.transform = "none";
    };
    if (!reduce && window.IntersectionObserver && nodes.length) {
      let armed = false;
      const io = new IntersectionObserver(
        (entries) => {
          if (!armed) {
            armed = true;
            clearTimeout(failsafe);
            for (const e of entries) {
              const t = e.target as HTMLElement;
              if (e.isIntersecting) {
                show(t);
                io.unobserve(t);
                continue;
              }
              t.style.transition = "opacity .55s cubic-bezier(.22,1,.36,1), transform .55s cubic-bezier(.22,1,.36,1)";
              t.style.opacity = "0";
              t.style.transform = "translateY(16px)";
            }
            return;
          }
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            show(e.target as HTMLElement);
            io.unobserve(e.target);
          }
        },
        { rootMargin: "0px 0px -12% 0px", threshold: 0.15 },
      );
      nodes.forEach((n) => io.observe(n));
      const failsafe = setTimeout(() => {
        if (!armed) nodes.forEach(show);
      }, 1200);
      const unhide = () => {
        setTimeout(() => nodes.forEach(show), 900);
      };
      window.addEventListener("scroll", unhide, { passive: true, once: true });
      cleanups.push(() => {
        io.disconnect();
        clearTimeout(failsafe);
        window.removeEventListener("scroll", unhide);
      });
    }

    /* -------------------------------------------------------- the field --- */
    // Soft filaments the whole page sits on, with signals travelling them; scrolling
    // pushes the signals along. Skipped under prefers-reduced-motion.
    const cv = box.querySelector<HTMLCanvasElement>("[data-neuro]");
    if (cv && !reduce) {
      const ctx = cv.getContext("2d");
      if (ctx) {
        const S = { w: 0, h: 0, dpr: 1, t: 0, flow: 0, last: null as number | null, dim: 1 };
        const rnd = (n: number) => {
          const x = Math.sin(n * 127.1) * 43758.5453;
          return x - Math.floor(x);
        };
        type Pt = { x: number; y: number };
        let paths: Array<{ pts: Pt[]; speed: number; off: number }> = [];
        let nodesN: Array<{ at: number; c: string }> = [];

        const build = () => {
          const W = S.w, H = S.h;
          paths = [];
          nodesN = [];
          for (let i = 0; i < 8; i++) {
            const base = H * (0.06 + 0.125 * i);
            const cps: Pt[] = [];
            for (let s = 0; s <= 5; s++) {
              cps.push({
                x: -120 + (W + 240) * (s / 5),
                y: base + Math.sin(i * 1.7 + s * 1.15) * H * 0.085 + (rnd(i * 9 + s) - 0.5) * H * 0.09,
              });
            }
            const pts: Pt[] = [];
            for (let s = 0; s < 5; s++) {
              const p0 = cps[Math.max(0, s - 1)], p1 = cps[s], p2 = cps[s + 1], p3 = cps[Math.min(5, s + 2)];
              for (let k = 0; k < 26; k++) {
                const u = k / 26, u2 = u * u, u3 = u2 * u;
                pts.push({
                  x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * u + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * u2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * u3),
                  y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * u + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * u2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * u3),
                });
              }
            }
            paths.push({ pts, speed: 0.07 + rnd(i) * 0.09, off: rnd(i * 5) });
            const at = Math.floor(pts.length * (0.18 + 0.62 * rnd(i * 3)));
            nodesN.push({ at, c: i % 5 === 0 ? "224,173,72" : i % 3 === 0 ? "139,111,214" : "31,189,214" });
          }
        };
        const size = () => {
          S.dpr = Math.min(2, window.devicePixelRatio || 1);
          S.w = cv.clientWidth;
          S.h = cv.clientHeight;
          cv.width = Math.max(1, Math.round(S.w * S.dpr));
          cv.height = Math.max(1, Math.round(S.h * S.dpr));
          ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
          build();
        };
        size();
        window.addEventListener("resize", size);

        const draw = () => {
          const top = window.scrollY;
          if (S.last === null) S.last = top;
          S.flow += (top - S.last) * 0.00085;
          S.last = top;
          const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
          S.dim = 0.62 + 0.38 * Math.min(1, (top / max) * 1.6);
          S.t += 0.00016;
          const ph = S.t + S.flow;
          ctx.clearRect(0, 0, S.w, S.h);

          for (let i = 0; i < paths.length; i++) {
            const P = paths[i], pts = P.pts, n = pts.length;
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let k = 1; k < n; k++) ctx.lineTo(pts[k].x, pts[k].y);
            ctx.strokeStyle = "rgba(174,184,196,0.028)";
            ctx.lineWidth = 1.1;
            ctx.lineCap = "round";
            ctx.stroke();

            // bokeh, not tracer fire: wide out-of-focus blooms reading as depth of field
            for (let s = 0; s < 2; s++) {
              const u = (((ph * P.speed + P.off + s * 0.5) % 1) + 1) % 1;
              const h = pts[Math.floor(u * (n - 1))];
              const R = 74 + 26 * Math.sin(i * 2.1 + ph * 3);
              const a = 0.085 * S.dim;
              const g = ctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, R);
              g.addColorStop(0, `rgba(96,214,236,${a.toFixed(4)})`);
              g.addColorStop(0.45, `rgba(31,189,214,${(a * 0.42).toFixed(4)})`);
              g.addColorStop(1, "rgba(31,189,214,0)");
              ctx.fillStyle = g;
              ctx.beginPath();
              ctx.arc(h.x, h.y, R, 0, Math.PI * 2);
              ctx.fill();
              const g2 = ctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, R * 0.28);
              g2.addColorStop(0, `rgba(148,236,247,${(a * 1.5).toFixed(4)})`);
              g2.addColorStop(1, "rgba(148,236,247,0)");
              ctx.fillStyle = g2;
              ctx.beginPath();
              ctx.arc(h.x, h.y, R * 0.28, 0, Math.PI * 2);
              ctx.fill();
            }

            const nd = nodesN[i], np = pts[nd.at];
            let flare = 0;
            for (let s = 0; s < 2; s++) {
              const u = (((ph * P.speed + P.off + s * 0.5) % 1) + 1) % 1;
              const d = Math.abs(u * (n - 1) - nd.at);
              if (d < 46) flare = Math.max(flare, 1 - d / 46);
            }
            const R = 34 + flare * 26;
            const ng = ctx.createRadialGradient(np.x, np.y, 0, np.x, np.y, R);
            ng.addColorStop(0, `rgba(${nd.c},${(0.055 + 0.1 * flare).toFixed(4)})`);
            ng.addColorStop(0.5, `rgba(${nd.c},${(0.022 + 0.05 * flare).toFixed(4)})`);
            ng.addColorStop(1, `rgba(${nd.c},0)`);
            ctx.fillStyle = ng;
            ctx.beginPath();
            ctx.arc(np.x, np.y, R, 0, Math.PI * 2);
            ctx.fill();
          }
        };
        let raf = 0;
        const loop = () => {
          draw();
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        cleanups.push(() => {
          cancelAnimationFrame(raf);
          window.removeEventListener("resize", size);
        });
      }
    }

    return () => cleanups.forEach((fn) => fn());
  }, []);

  return (
    <div ref={root} className={styles.page}>
      <canvas data-neuro="" className={styles.neuro} aria-hidden="true" />
      <div data-rail="" className={styles.rail} aria-hidden="true" />

      <header data-nav="" className={styles.nav}>
        <Logo />
        <span className={styles.wordmark}>
          <b>Cortex</b>
          <span>by Obelyth</span>
        </span>
        <div className={styles.sp} />
        <nav aria-label="Site" style={{ display: "contents" }}>
          <a href="#how" className={styles.navLink}>How it works</a>
          <a href="#connect" className={styles.navLink}>Connect</a>
          <a href={REPO} target="_blank" rel="noreferrer" className={styles.navLink}>GitHub</a>
          <a href="#console" onClick={toConsole} className={styles.navBtn}>Open the console</a>
        </nav>
      </header>

      <main>
        {/* ─────────────── HERO ─────────────── */}
        <section className={styles.hero}>
          <div className={styles.heroGlow} aria-hidden="true" />
          <div data-flow="" className={styles.inner}>
            <div data-reveal="" className={styles.badge}>
              <span className={styles.blip} />
              <span className={styles.badgeText}>Your own private memory · try the live demo below</span>
            </div>
            <h1 data-reveal="" className={styles.h1}>One memory,<br />every surface.</h1>
            <p data-reveal="" className={styles.lede}>
              Your notes, in one place, available to every assistant you trust — Claude first among
              them, by measurement rather than allegiance. Ask a question
              and you get the answer plus the exact line it came from — or an honest
              &ldquo;that isn&rsquo;t in here.&rdquo;
            </p>
            <div data-reveal="" className={styles.ctas}>
              <a href="#console" onClick={toConsole} className={styles.ctaPrimary}>
                Enter the console<i>↓</i>
              </a>
              <a href={REPO} target="_blank" rel="noreferrer" className={styles.ctaGhost}>
                <GitHubIcon />
                Read the source
              </a>
            </div>
            <div data-reveal="" className={styles.stats}>
              {HERO_STATS.map((s) => (
                <span key={s.label} className={styles.stat}>
                  <span className={styles.statN}>{s.n}</span>
                  <span className={styles.statL}>{s.label}</span>
                </span>
              ))}
            </div>
          </div>
          <div className={styles.cueWrap} aria-hidden="true">
            <span>Scroll</span>
            <span className={styles.cueLine} />
          </div>
        </section>

        {/* ─────────────── PRINCIPLES ─────────────── */}
        <section className={styles.section} aria-labelledby="principles-title">
          <div data-flow="" className={styles.inner}>
            <div data-reveal="" className={styles.kicker}>What it is</div>
            <h2 data-reveal="" id="principles-title" className={styles.h2} style={{ marginBottom: 64 }}>
              You can check its work
            </h2>
            <div className={styles.threeUp}>
              {PRINCIPLES.map((p) => (
                <div data-reveal="" key={p.n} className={styles.col}>
                  <div className={styles.colN}>{p.n}</div>
                  <div className={styles.colTitle}>{p.title}</div>
                  <p className={styles.colBody}>{p.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ─────────────── HOW ─────────────── */}
        <section id="how" className={`${styles.section} ${styles.sectionTint}`} aria-labelledby="how-title">
          <div data-flow="" className={styles.inner}>
            <div data-reveal="" className={styles.kicker}>The short version</div>
            <h2 data-reveal="" id="how-title" className={styles.h2}>How a question gets answered</h2>
            <p data-reveal="" className={styles.sectionLede}>
              Nothing is pre-sorted or guessed at. Claude reads your actual notes each time, then
              the quote it gives back is checked against the file it came from.
            </p>

            <div className={styles.steps}>
              {STEPS.map((s) => (
                <div data-reveal="" key={s.n} className={styles.step} style={{ borderTop: `2px solid ${s.rule}` }}>
                  <div className={styles.stepN}>Step {s.n}</div>
                  <div className={styles.stepName}>{s.name}</div>
                  <p className={styles.stepBody}>{s.body}</p>
                </div>
              ))}
            </div>

            <div data-reveal="" className={styles.stampsGrid}>
              <div>
                <div className={styles.stampsLead}>Every answer<br />shows its work</div>
                <p className={styles.stampsNote}>
                  This check is mechanical, not another AI judging the first one. It only answers
                  one question: is that quote really in that note?
                </p>
              </div>
              <div>
                {STAMPS.map((s) => (
                  <div key={s.tag} className={styles.stampRow}>
                    <span className={`${styles.pill} ${styles[s.cls]}`}>{s.tag}</span>
                    <span className={styles.stampLine}>{s.line}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ─────────────── CONNECT ─────────────── */}
        <section id="connect" className={styles.section} aria-labelledby="connect-title">
          <div data-flow="" className={styles.inner}>
            <div data-reveal="" className={styles.kicker}>Getting started</div>
            <h2 data-reveal="" id="connect-title" className={styles.h2}>Set up in one command</h2>
            <p data-reveal="" className={styles.sectionLede}>
              Two ways to connect, depending on what your client can send — Claude, Cursor, the CLIs,
              or anything that speaks MCP. Both are locked down: get
              the credentials wrong and the page simply does not exist. There is also a third
              door for people who are not you — a guest link that can only ask (scoped to what
              you share) and propose a note for your review. It stays closed until you open it.
            </p>

            <div className={styles.paths}>
              <div data-reveal="" className={styles.pathCard}>
                <div className={styles.pathTag}><b>Path 01</b><span>a token</span></div>
                <div className={styles.pathTitle}>Claude Code</div>
                <p className={styles.pathBody}>One line in your terminal. Your token stays out of the address bar.</p>
                <div className={styles.preHead}>
                  <span>terminal</span>
                  <CopyButton text={CMD} label="Copy the terminal command" />
                </div>
                <pre className={styles.pre}>{`claude mcp add --transport http cortex \\
  https://<host>/api/mcp \\
  --header "Authorization: Bearer <MCP_TOKEN>"`}</pre>
              </div>
              <div data-reveal="" className={styles.pathCard}>
                <div className={styles.pathTag}><b>Path 02</b><span>secret url</span></div>
                <div className={styles.pathTitle}>claude.ai</div>
                <p className={styles.pathBody}>
                  The Claude apps connect with a private link instead of a token. Add it once on
                  the web and your phone and desktop pick it up automatically.
                </p>
                <div className={styles.preHead}>
                  <span>connector url</span>
                  <CopyButton text={URL_ALIAS} label="Copy the connector URL" />
                </div>
                <pre className={styles.pre}>{`https://<host>/api/s/<secret>/mcp

# Settings → Connectors → Add custom`}</pre>
              </div>
            </div>

            <div data-reveal="" className={`${styles.threeUp} ${styles.rituals}`}>
              {RITUALS.map((r) => (
                <div key={r.tag} className={styles.col}>
                  <div className={styles.kicker} style={{ marginBottom: 12 }}>{r.tag}</div>
                  <p className={styles.colBody}>{r.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ─────────────── ARRIVAL ─────────────── */}
        <section id="console" className={styles.arrive} aria-labelledby="console-title">
          <div className={styles.pin}>
            <div data-lead="" className={styles.lead}>
              <div className={styles.kicker}>The console</div>
              <h2 id="console-title" className={styles.leadTitle}>See it running</h2>
              <p className={styles.leadLede}>
                A working demo with stand-in notes. Every screen and control behaves exactly like
                the real thing.
              </p>
            </div>
            <div data-sheet="" className={styles.sheet}>
              <ConsoleDemo />
            </div>
            <div data-hint="" className={styles.hint}>Try it — click the tabs, drag the map</div>
          </div>
        </section>

        {/* ─────────────── FOOT ─────────────── */}
        <footer className={styles.foot}>
          <div data-flow="" className={styles.inner}>
            <div data-reveal="" className={styles.footTop}>
              <div>
                <h2 className={styles.footTitle}>Make it yours</h2>
                <p className={styles.footLede}>
                  Cortex is a small app plus a folder of markdown files. Copy it, point it at your
                  own notes, and connect only the devices you trust.
                </p>
              </div>
              <a href={REPO} target="_blank" rel="noreferrer" className={styles.ctaPrimary}>
                <GitHubIcon />
                Obelyth/cortex
              </a>
            </div>
            <div className={styles.footRow}>
              <span className={styles.footBrand}>Cortex by Obelyth</span>
              <span className={styles.footDiv} aria-hidden="true" />
              <span className={styles.footTag}>Data. Infrastructure. Assured.</span>
              <div className={styles.sp} />
              <a href="/tools" className={styles.footLink}>Tools</a>
              <a href="/guide" className={styles.footLink}>Guide</a>
              <a href="/map" className={styles.footLink}>Demo map</a>
              <a href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer" className={styles.footLink}>License</a>
              <span className={styles.footTag}>© 2026 Obelyth</span>
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}
