/**
 * The Nexus mark: a node graph inside a speech bubble, with signal arcs.
 *
 * Shared with the hosting platform's dashboard, deliberately — the two are one
 * product to anyone using them, and the site sending people to a control panel
 * wearing a different badge is the sort of seam that makes a thing feel
 * assembled rather than built. Kept as a copy rather than a package: nexus-md
 * has to build standalone with no dependency on the hosting repo, and a
 * fifty-line SVG is a cheaper duplicate than a shared build.
 *
 * SVG rather than the old letter tile. `currentColor` means it inherits from
 * CSS, so it needs no second asset for a light surface, and it stays sharp at
 * 30px in a header and 92px on the panel.
 *
 * The geometry says something: a centre hub with eight spokes reads as "many
 * connections through one point".
 */

/** Eight nodes on a ring, precomputed so the render stays declarative. */
const RADIUS = 15;
const SPOKES = Array.from({ length: 8 }, (_, i) => {
  const angle = (i * Math.PI * 2) / 8 - Math.PI / 2;
  return {
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
 * apart. The small variant keeps the silhouette and drops the ring and half the
 * nodes, so it still reads as the same mark.
 */
const DETAIL_THRESHOLD = 40;

export function LogoMark({ size = 30, className }: { size?: number; className?: string }) {
  const detailed = size >= DETAIL_THRESHOLD;
  const nodes = detailed ? SPOKES : SPOKES.filter((_, i) => i % 2 === 0);

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
      {/* Speech bubble: a ring broken at the lower left, with a tail. */}
      <path
        d="M32 8.5c12.4 0 22.5 9.6 22.5 21.5S44.4 51.5 32 51.5c-2.6 0-5.1-.4-7.4-1.2l-9.6 5.2 2.3-8.2C11.9 43.4 9.5 37.1 9.5 30 9.5 18.1 19.6 8.5 32 8.5Z"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />

      {/* Spokes from the hub, drawn first so the nodes sit on top. */}
      <g stroke="currentColor" strokeWidth={detailed ? 1.5 : 1.9} opacity="0.85">
        {nodes.map((n) => (
          <line key={`s${n.x}-${n.y}`} x1="32" y1="30" x2={n.x} y2={n.y} />
        ))}
      </g>

      {/* The ring joining adjacent nodes — detailed sizes only. */}
      {detailed && (
        <g stroke="currentColor" strokeWidth="1.2" opacity="0.55">
          {SPOKES.map((n, i) => {
            const next = SPOKES[(i + 1) % SPOKES.length]!;
            return <line key={`r${i}`} x1={n.x} y1={n.y} x2={next.x} y2={next.y} />;
          })}
        </g>
      )}

      <g fill="currentColor">
        {nodes.map((n) => (
          <circle key={`n${n.x}-${n.y}`} cx={n.x} cy={n.y} r={detailed ? n.r : 3.1} />
        ))}
        <circle cx="32" cy="30" r={detailed ? 4.4 : 5} />
      </g>

      {/* Signal arcs — the bot broadcasting. The faintest is dropped when small:
          at 32% opacity on a sub-30px mark it is invisible anyway, and it only
          costs the outer arcs contrast. */}
      <g stroke="currentColor" strokeWidth={detailed ? 2.2 : 2.6} strokeLinecap="round" fill="none">
        <path d="M59 19a17 17 0 0 1 0 22" opacity="0.9" />
        <path d="M64.5 13.5a25 25 0 0 1 0 33" opacity={detailed ? 0.6 : 0.5} />
        {detailed && <path d="M69.5 8.5a33 33 0 0 1 0 43" opacity="0.32" />}
      </g>
    </svg>
  );
}
