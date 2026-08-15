/**
 * The ambient page backdrop, shared by the landing page and the pairing panel.
 *
 * Three slow-drifting aurora fields over a dark wash, plus a faint grid that is
 * masked out before it reaches the edges.
 *
 * It replaced a 3.2 MB looping video. The clip was stock green smoke: invisible
 * on a wide desktop and, on a phone where it filled proportionally more of the
 * viewport, it read as a smudge on the screen rather than as a design. This
 * costs nothing to download and nothing to decode.
 *
 * The fields are RADIAL GRADIENTS, not `filter: blur()` on a solid shape. A
 * gradient falls off softly for free; a blur filter has to be re-rasterised, and
 * blurring three large elements was the same mistake the video made in a
 * cheaper-looking costume. Only `transform` animates, so each field stays on the
 * compositor and the scroll never touches it.
 *
 * `video` adds the node-graph clip, and is passed ONLY by the pairing panel.
 * The source is 464x688 — portrait, and small. That rules it out as a landing
 * page backdrop, where it would need a 3x upscale and a two-thirds crop, but it
 * suits a page that is one centred card on a tall viewport, and a mesh of nodes
 * connecting is what that page is for. It renders as a portrait band roughly the
 * width of the panel, so it is never blown up far past its own resolution.
 */
import { useEffect, useRef, useState } from 'react';

const POSTER = '/media/nexus-link-poster.jpg';

function BackdropVideo() {
  const [motion, setMotion] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    setMotion(!matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    // Autoplay can be refused even when muted. The poster stays up in that case,
    // which is a perfectly good backdrop, so the failure is silent by design.
    void video.play().catch(() => undefined);

    // Nobody is watching this while the tab is in the background, and a QR that
    // the user is waiting on may leave this page open for a long time.
    const onVisibility = () => {
      if (document.hidden) video.pause();
      else void video.play().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [motion]);

  return (
    <span className="bg-video" style={{ backgroundImage: `url(${POSTER})` }}>
      {motion && (
        <video ref={ref} autoPlay muted loop playsInline preload="auto" poster={POSTER}>
          <source src="/media/nexus-link.webm" type="video/webm" />
          <source src="/media/nexus-link.mp4" type="video/mp4" />
        </video>
      )}
    </span>
  );
}

export default function Backdrop({ video = false }: { video?: boolean }) {
  return (
    <div className={`bg${video ? ' has-video' : ''}`} aria-hidden="true">
      <span className="aurora a1" />
      <span className="aurora a2" />
      <span className="aurora a3" />
      {video ? <BackdropVideo /> : <span className="bg-grid" />}
      <span className="bg-grain" />
    </div>
  );
}
