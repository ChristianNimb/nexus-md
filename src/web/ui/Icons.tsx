/**
 * Line icons, drawn on a 24px grid with a consistent 1.6 stroke.
 *
 * These replace the emoji that used to sit in the feature cards and command
 * headers. Emoji render differently on every OS, carry someone else's colour
 * palette into the design, and read as a placeholder nobody got round to
 * replacing — which is exactly how they looked.
 */
// React 19 dropped the global JSX namespace; it is exported from 'react' now.
import type { JSX, SVGProps } from 'react';

const base: SVGProps<SVGSVGElement> = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};

export type IconName =
  | 'brain'
  | 'wave'
  | 'download'
  | 'shield'
  | 'eye'
  | 'clock'
  | 'terminal'
  | 'media'
  | 'tools'
  | 'search'
  | 'qr';

const PATHS: Record<IconName, JSX.Element> = {
  // a node-graph, for the assistant
  brain: (
    <>
      <circle cx="6" cy="7" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="12" cy="13" r="2.4" />
      <circle cx="6.5" cy="18" r="2" />
      <circle cx="17.5" cy="18.5" r="2" />
      <path d="M7.7 8.4l2.6 3M16.6 7.7l-3 3.6M10.6 14.6l-2.6 2.2M13.9 14.7l2.3 2.4" />
    </>
  ),
  wave: (
    <>
      <path d="M3 12h1.6M7 8.5v7M10.4 5.5v13M13.8 9v6M17.2 7v10M20.6 11v2" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v11" />
      <path d="M8 10.5l4 4 4-4" />
      <path d="M4 17v2.5A1.5 1.5 0 005.5 21h13a1.5 1.5 0 001.5-1.5V17" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7 3v5.5c0 4.3-2.9 8-7 9.5-4.1-1.5-7-5.2-7-9.5V6z" />
      <path d="M9.3 12.2l1.9 1.9 3.6-3.9" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12.5" r="8" />
      <path d="M12 8.2v4.5l3 1.8" />
      <path d="M5 3.6L2.6 5.6M19 3.6L21.4 5.6" />
    </>
  ),
  terminal: (
    <>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
      <path d="M6.5 9.5l3 2.5-3 2.5M12.5 15h5" />
    </>
  ),
  media: (
    <>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2" />
      <circle cx="8.5" cy="10" r="1.6" />
      <path d="M3 17l5-4.5 4 3.5 3-2.5 6 5" />
    </>
  ),
  tools: (
    <>
      <path d="M14.5 6.2a3.8 3.8 0 005 5l-8.8 8.8a2.1 2.1 0 01-3-3z" />
      <path d="M6.4 3.5l2.4 2.4-2 2-2.4-2.4a1 1 0 010-1.4l.6-.6a1 1 0 011.4 0z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  qr: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.2" />
      <rect x="14" y="3" width="7" height="7" rx="1.2" />
      <rect x="3" y="14" width="7" height="7" rx="1.2" />
      <path d="M14 14h3v3h-3zM20 20h1M18 21h3M20 14v3" />
    </>
  ),
};

export default function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg {...base} width={size} height={size}>
      {PATHS[name]}
    </svg>
  );
}
