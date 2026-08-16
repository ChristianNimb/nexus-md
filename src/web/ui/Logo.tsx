/**
 * The Nexus mark: a node graph inside a speech bubble, with signal arcs.
 *
 * Shared with the hosting platform's dashboard, deliberately. The two are one
 * product to anyone using them, and the site sending people to a control panel
 * wearing a different badge is the sort of seam that makes a thing feel
 * assembled rather than built. Kept as a copy rather than a package: nexus-md
 * has to build standalone with no dependency on the hosting repo, and a
 * hundred lines of geometry is a cheaper duplicate than a shared build.
 *
 * SVG rather than a raster: `currentColor` means it inherits from CSS, so it
 * needs no second asset for a light surface and stays sharp at any size.
 *
 * The geometry is deliberate: a centre hub with eight spokes reads as "many
 * connections through one point".
 */
import { useEffect, useRef } from 'react';

/** Eight nodes on a ring, precomputed so the render stays declarative. */
const RADIUS = 15;
const SPOKES = Array.from({ length: 8 }, (_, i) => {
  const angle = (i * Math.PI * 2) / 8 - Math.PI / 2;
  return {
    angle,
    x: Number((32 + RADIUS * Math.cos(angle)).toFixed(2)),
    y: Number((30 + RADIUS * Math.sin(angle)).toFixed(2)),
    // Alternating sizes stop the ring reading as a rigid cog.
    r: i % 2 === 0 ? 2.6 : 2.1,
  };
});

/**
 * Below this, detail stops helping and starts smudging.
 *
 * Eight nodes, eight spokes and a connecting ring resolve beautifully at 92px
 * and turn into a grey blob at 26px, where the ring segments are under a pixel
 * apart. The small variant keeps the silhouette — bubble, hub, spokes, arcs —
 * and drops the ring and half the nodes, so it still reads as the same mark.
 */
const DETAIL_THRESHOLD = 40;

/** Where the signal leaves the bubble. The arcs expand away from this point. */
const WAVE_ORIGIN = { x: 54, y: 30 };

/**
 * How each node drifts.
 *
 * Every node breathes along its own radius at its own rate, with a little
 * angular sway on top. That is what makes the CONNECTIONS move: a line is
 * drawn between two nodes, so when the nodes drift the line stretches and
 * shifts. Nothing animates a line directly.
 *
 * The rates are deliberately not multiples of one another. Harmonically
 * related speeds resynchronise every few seconds, and the eye catches the
 * repeat immediately — the thing stops looking alive and starts looking like
 * a loop.
 */
const DRIFT = SPOKES.map((_, i) => ({
  reach: 0.47 + (i % 3) * 0.19,
  reachPhase: i * 0.79,
  sway: 0.29 + (i % 4) * 0.13,
  swayPhase: i * 1.31,
}));

/** How far a node travels, in viewBox units. */
const REACH_AMPLITUDE = 2.9;
const SWAY_AMPLITUDE = 0.11;

const prefersReduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function LogoMark({
  size = 30,
  className,
  animated = false,
}: {
  size?: number;
  className?: string;
  /**
   * Bring the connections to life.
   *
   * Honoured at any size. The threshold below is about whether the ring is
   * LEGIBLE, which is a different question from whether motion reads: a small
   * mark still has spokes to stretch and arcs to pulse, and it moves at a
   * reduced amplitude so a logo in a header breathes rather than fidgets.
   */
  animated?: boolean;
}) {
  const detailed = size >= DETAIL_THRESHOLD;
  const nodes = detailed ? SPOKES : SPOKES.filter((_, i) => i % 2 === 0);
  const live = animated;

  const spokeRefs = useRef<(SVGLineElement | null)[]>([]);
  const ringRefs = useRef<(SVGLineElement | null)[]>([]);
  const dotRefs = useRef<(SVGCircleElement | null)[]>([]);
  const waveRefs = useRef<(SVGPathElement | null)[]>([]);

  /*
   * Driven by hand rather than by an animation library.
   *
   * The brief is that the lines between the nodes stretch, and a line's
   * endpoints are `x1/y1/x2/y2` — SVG attributes, not CSS properties, so no
   * keyframe can touch them. That leaves a library that animates attributes or
   * forty lines that do. The forty lines win here: this ships inside a bundle
   * that inlines everything, and a motion library would be the single largest
   * dependency in it, for one logo.
   *
   * Attributes are written straight to the DOM instead of through state. Eight
   * nodes at 60fps is 1400 React renders a minute for something with no
   * bearing on anything else on the page.
   */
  useEffect(() => {
    if (!live || prefersReduced()) return;

    let frame = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const t = (now - start) / 1000;

      // Damped when the mark is small. The same travel that reads as breathing
      // at 92px reads as a jitter at 26px, where it is a couple of pixels.
      const reachAmp = REACH_AMPLITUDE * (detailed ? 1 : 0.55);
      const swayAmp = SWAY_AMPLITUDE * (detailed ? 1 : 0.55);

      const pts = DRIFT.map((d, i) => {
        const base = SPOKES[i]!;
        const r = RADIUS + reachAmp * Math.sin(t * d.reach + d.reachPhase);
        const a = base.angle + swayAmp * Math.sin(t * d.sway + d.swayPhase);
        return { x: 32 + r * Math.cos(a), y: 30 + r * Math.sin(a) };
      });

      /*
       * Spokes and dots follow whichever nodes are actually RENDERED.
       *
       * The small variant draws every other node, so its spoke at index 1 is
       * the full set's node 2. Indexing both by the same counter would send
       * half the dots to the wrong places, which is invisible in the code and
       * very visible on screen.
       */
      const drawnIdx = detailed ? [0, 1, 2, 3, 4, 5, 6, 7] : [0, 2, 4, 6];
      for (let k = 0; k < drawnIdx.length; k++) {
        const p = pts[drawnIdx[k]!]!;
        const spoke = spokeRefs.current[k];
        if (spoke) {
          spoke.setAttribute('x2', p.x.toFixed(2));
          spoke.setAttribute('y2', p.y.toFixed(2));
        }
        const dot = dotRefs.current[k];
        if (dot) {
          dot.setAttribute('cx', p.x.toFixed(2));
          dot.setAttribute('cy', p.y.toFixed(2));
        }
      }

      // The ring always joins all eight, and only exists when detailed.
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i]!;
        // Node to its neighbour, so it stretches from both ends at once.
        const next = pts[(i + 1) % pts.length]!;
        const ring = ringRefs.current[i];
        if (ring) {
          ring.setAttribute('x1', p.x.toFixed(2));
          ring.setAttribute('y1', p.y.toFixed(2));
          ring.setAttribute('x2', next.x.toFixed(2));
          ring.setAttribute('y2', next.y.toFixed(2));
        }
      }

      /*
       * The signal arcs, expanding and retracting on a stagger.
       *
       * Each arc runs the same 0..1 cycle a third of a beat behind the one
       * inside it, which is what makes the motion read as travelling outward
       * rather than three arcs pulsing together. `sin(pi * phase)` gives a
       * smooth out-and-back with no seam at the loop point.
       */
      for (let i = 0; i < waveRefs.current.length; i++) {
        const wave = waveRefs.current[i];
        if (!wave) continue;
        const phase = ((t * 0.5 - i * 0.22) % 1 + 1) % 1;
        const pulse = Math.sin(Math.PI * phase);
        const scale = 0.9 + 0.16 * pulse;
        const peak = [0.9, 0.6, 0.32][i] ?? 0.4;
        wave.setAttribute('opacity', (peak * (0.35 + 0.65 * pulse)).toFixed(3));
        wave.setAttribute(
          'transform',
          `translate(${WAVE_ORIGIN.x} ${WAVE_ORIGIN.y}) scale(${scale.toFixed(3)}) translate(${-WAVE_ORIGIN.x} ${-WAVE_ORIGIN.y})`,
        );
      }

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [live, detailed]);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 72 72"
      fill="none"
      className={className}
      role="img"
      aria-label="Nexus"
    >
      {/* Speech bubble: a ring broken at the lower left, with a tail. Fixed —
          the container does not move, only what is happening inside it. */}
      <path
        d="M32 8.5c12.4 0 22.5 9.6 22.5 21.5S44.4 51.5 32 51.5c-2.6 0-5.1-.4-7.4-1.2l-9.6 5.2 2.3-8.2C11.9 43.4 9.5 37.1 9.5 30 9.5 18.1 19.6 8.5 32 8.5Z"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />

      {/* Spokes from the hub, drawn first so the nodes sit on top. */}
      <g stroke="currentColor" strokeWidth={detailed ? 1.5 : 1.9} opacity="0.85">
        {nodes.map((n, i) => (
          <line
            key={`s${n.x}-${n.y}`}
            ref={(el) => {
              spokeRefs.current[i] = el;
            }}
            x1="32"
            y1="30"
            x2={n.x}
            y2={n.y}
          />
        ))}
      </g>

      {/* The ring joining adjacent nodes — detailed sizes only. */}
      {detailed && (
        <g stroke="currentColor" strokeWidth="1.2" opacity="0.55">
          {SPOKES.map((n, i) => {
            const next = SPOKES[(i + 1) % SPOKES.length]!;
            return (
              <line
                key={`r${i}`}
                ref={(el) => {
                  ringRefs.current[i] = el;
                }}
                x1={n.x}
                y1={n.y}
                x2={next.x}
                y2={next.y}
              />
            );
          })}
        </g>
      )}

      <g fill="currentColor">
        {nodes.map((n, i) => (
          <circle
            key={`n${n.x}-${n.y}`}
            ref={(el) => {
              dotRefs.current[i] = el;
            }}
            cx={n.x}
            cy={n.y}
            r={detailed ? n.r : 3.1}
          />
        ))}
        <circle cx="32" cy="30" r={detailed ? 4.4 : 5} />
      </g>

      {/* Signal arcs — the bot broadcasting. The faintest one is dropped when
          small: at 32% opacity on a sub-30px mark it is invisible anyway, and
          it only costs the outer arcs contrast. */}
      <g stroke="currentColor" strokeWidth={detailed ? 2.2 : 2.6} strokeLinecap="round" fill="none">
        <path
          ref={(el) => {
            waveRefs.current[0] = el;
          }}
          d="M59 19a17 17 0 0 1 0 22"
          opacity="0.9"
        />
        <path
          ref={(el) => {
            waveRefs.current[1] = el;
          }}
          d="M64.5 13.5a25 25 0 0 1 0 33"
          opacity={detailed ? 0.6 : 0.5}
        />
        {detailed && (
          <path
            ref={(el) => {
              waveRefs.current[2] = el;
            }}
            d="M69.5 8.5a33 33 0 0 1 0 43"
            opacity="0.32"
          />
        )}
      </g>
    </svg>
  );
}
