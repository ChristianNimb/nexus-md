/**
 * Entry point for both pages. One bundle, routed on pathname — the landing page
 * and the panel share a design system and the same 60 kB of React, so splitting
 * them would mean two downloads for no benefit.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Landing from './Landing';
import LinkPanel from './LinkPanel';
import './styles.css';

/**
 * Anchored at the END of the path, not the start.
 *
 * `^/link$` was right while this bot served itself directly. Behind the hosting
 * platform's proxy the same page arrives at /bots/<slug>/panel/link, the test
 * failed, and the bundle rendered the marketing landing page instead of the
 * pairing panel — with the correct title, which made it look like the wrong
 * file had been served rather than the wrong component chosen.
 *
 * Matching the trailing segment works in both places and under any prefix.
 */
const isPanel = /(^|\/)link(\.html)?\/?$/.test(window.location.pathname);
const mount = document.getElementById('root');

if (mount) {
  createRoot(mount).render(<StrictMode>{isPanel ? <LinkPanel /> : <Landing />}</StrictMode>);
}
