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

const isPanel = /^\/link(\.html)?\/?$/.test(window.location.pathname);
const mount = document.getElementById('root');

if (mount) {
  createRoot(mount).render(<StrictMode>{isPanel ? <LinkPanel /> : <Landing />}</StrictMode>);
}
