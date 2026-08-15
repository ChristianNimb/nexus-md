import { createCanvas } from '@napi-rs/canvas';

/**
 * Render a glowing neon-style text LOGO to a PNG — the "wow" text effects (neon,
 * cyberpunk, gold, fire, …). Pure @napi-rs/canvas, fully offline, so it keeps
 * working behind any firewall.
 */

const FONT = 'sans-serif'; // fontconfig → DejaVu (installed in the image)

interface LogoStyle {
  bg: [string, string]; // background gradient (top → bottom)
  grad: [string, string]; // letter gradient
  glow: string; // halo colour
  core: string; // bright highlight
}

const STYLES: Record<string, LogoStyle> = {
  neon: { bg: ['#1a0033', '#050008'], grad: ['#ff5cf0', '#b14bff'], glow: '#ff2bd6', core: '#ffe3fb' },
  ice: { bg: ['#001430', '#00060f'], grad: ['#66ecff', '#2b7bff'], glow: '#00d0ff', core: '#eafcff' },
  cyberpunk: { bg: ['#0a0022', '#05010f'], grad: ['#ff2bd6', '#00e5ff'], glow: '#ff2bd6', core: '#ffffff' },
  gold: { bg: ['#1c1500', '#0a0800'], grad: ['#ffe07a', '#ff8f1f'], glow: '#ffb300', core: '#fff6cc' },
  fire: { bg: ['#210600', '#0d0200'], grad: ['#ffc23d', '#ff2400'], glow: '#ff5a00', core: '#ffe4b3' },
  matrix: { bg: ['#001a08', '#000803'], grad: ['#7dff9f', '#00cc44'], glow: '#00ff66', core: '#d6ffe1' },
  royal: { bg: ['#14002e', '#070014'], grad: ['#c07bff', '#ffd54a'], glow: '#a259ff', core: '#f3e6ff' },
  sunset: { bg: ['#2a0a00', '#100300'], grad: ['#ffb14a', '#ff2e77'], glow: '#ff5a2e', core: '#fff0e0' },
  ocean: { bg: ['#00121f', '#00060d'], grad: ['#57ffd0', '#0088ff'], glow: '#00d9c0', core: '#e6fffb' },
  blood: { bg: ['#1a0000', '#0a0000'], grad: ['#ff5555', '#a80000'], glow: '#ff1a1a', core: '#ffd6d6' },
};

export const LOGO_STYLES = Object.keys(STYLES);

export function renderLogo(text: string, styleName = 'neon'): Buffer {
  const s = STYLES[styleName] ?? STYLES.neon;
  const W = 1080;
  const H = 460;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background gradient.
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, s.bg[0]);
  bg.addColorStop(1, s.bg[1]);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Fit the text.
  const t = text.trim().slice(0, 22).toUpperCase();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let size = 230;
  ctx.font = `800 ${size}px ${FONT}`;
  while (size > 44 && ctx.measureText(t).width > W - 150) {
    size -= 4;
    ctx.font = `800 ${size}px ${FONT}`;
  }

  const cx = W / 2;
  const cy = H / 2;
  const grad = ctx.createLinearGradient(0, cy - size / 2, 0, cy + size / 2);
  grad.addColorStop(0, s.grad[0]);
  grad.addColorStop(1, s.grad[1]);

  // Outer halo — several blurred passes build the neon glow.
  ctx.fillStyle = grad;
  ctx.shadowColor = s.glow;
  for (const blur of [60, 42, 26]) {
    ctx.shadowBlur = blur;
    ctx.fillText(t, cx, cy);
  }
  // Solid letter body.
  ctx.shadowBlur = 0;
  ctx.fillStyle = grad;
  ctx.fillText(t, cx, cy);
  // Bright inner highlight (the "tube" shine).
  ctx.shadowColor = s.core;
  ctx.shadowBlur = 8;
  ctx.lineWidth = Math.max(2, size / 42);
  ctx.strokeStyle = s.core;
  ctx.strokeText(t, cx, cy);

  return canvas.toBuffer('image/png');
}
