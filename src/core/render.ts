import { createCanvas, loadImage, type SKRSContext2D } from '@napi-rs/canvas';

/**
 * Image rendering with @napi-rs/canvas (prebuilt binary — no compiler needed).
 * Produces PNG buffers for the command menu and welcome/goodbye cards.
 */

const FONT = 'sans-serif'; // resolved via fontconfig (DejaVu installed in the image)

/**
 * Render an emoji or short word onto a 512x512 transparent PNG, sized to fit —
 * the raw image for a Nexus reaction sticker. Emoji render in colour when a
 * colour-emoji font (Noto Color Emoji) is installed.
 */
export function renderStickerImage(text: string): Buffer {
  const S = 512;
  const canvas = createCanvas(S, S);
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const t = text.trim().slice(0, 40);
  const hasLetters = /[a-z0-9]/i.test(t);
  let size = t.length <= 2 ? 360 : t.length <= 6 ? 210 : t.length <= 12 ? 130 : 90;
  ctx.font = `800 ${size}px ${FONT}`;
  while (size > 20 && ctx.measureText(t).width > S - 48) {
    size -= 8;
    ctx.font = `800 ${size}px ${FONT}`;
  }

  // Outline text (not emoji) so it reads on any chat background.
  if (hasLetters) {
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = Math.max(4, size / 9);
    ctx.lineJoin = 'round';
    ctx.strokeText(t, S / 2, S / 2);
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillText(t, S / 2, S / 2);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  return canvas.toBuffer('image/png');
}

function verticalGradient(ctx: SKRSContext2D, w: number, h: number, stops: [number, string][]): void {
  const g = ctx.createLinearGradient(0, 0, w, h);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export interface MenuCategory {
  name: string;
  commands: string[];
}

export interface MenuCardInput {
  botName: string;
  userName: string;
  prefix: string;
  mode: string;
  totalCommands: number;
  categories: MenuCategory[];
}

/** Word-wrap a list of command chips into lines that fit `maxWidth`. */
function wrap(ctx: SKRSContext2D, items: string[], maxWidth: number, gap: number): string[][] {
  const lines: string[][] = [];
  let line: string[] = [];
  let width = 0;
  for (const it of items) {
    const w = ctx.measureText(it).width + gap;
    if (width + w > maxWidth && line.length) {
      lines.push(line);
      line = [];
      width = 0;
    }
    line.push(it);
    width += w;
  }
  if (line.length) lines.push(line);
  return lines;
}

export async function renderMenuCard(input: MenuCardInput): Promise<Buffer> {
  const W = 760;
  const pad = 44;
  const contentW = W - pad * 2;

  // --- measure pass to compute height ---
  const measure = createCanvas(10, 10).getContext('2d');
  measure.font = `500 22px ${FONT}`;
  const layout = input.categories.map((cat) => {
    const chips = cat.commands.map((c) => `${input.prefix}${c}`);
    const lines = wrap(measure, chips, contentW - 24, 26);
    return { name: cat.name, lines };
  });

  const headerH = 190;
  let bodyH = 0;
  for (const c of layout) bodyH += 46 + c.lines.length * 34 + 18; // header + rows + gap
  const H = headerH + bodyH + pad;

  // --- render ---
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  verticalGradient(ctx, W, H, [
    [0, '#0f2027'],
    [0.5, '#203a43'],
    [1, '#2c5364'],
  ]);

  // header
  ctx.fillStyle = '#7cf0c8';
  ctx.font = `800 52px ${FONT}`;
  ctx.fillText(input.botName, pad, 84);

  ctx.fillStyle = '#cfe9e0';
  ctx.font = `500 22px ${FONT}`;
  ctx.fillText(`Hello, ${input.userName}`, pad, 122);
  ctx.fillStyle = '#9fb8b2';
  ctx.font = `400 20px ${FONT}`;
  ctx.fillText(`prefix ${input.prefix}   •   ${input.totalCommands} commands   •   ${input.mode} mode`, pad, 152);

  // divider
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pad, headerH - 12);
  ctx.lineTo(W - pad, headerH - 12);
  ctx.stroke();

  // categories
  let y = headerH + 20;
  for (const cat of layout) {
    ctx.fillStyle = '#7cf0c8';
    ctx.beginPath();
    ctx.arc(pad + 6, y - 8, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 24px ${FONT}`;
    ctx.fillText(cat.name.toUpperCase(), pad + 22, y);
    y += 34;

    ctx.font = `500 22px ${FONT}`;
    for (const line of cat.lines) {
      let x = pad + 8;
      for (const chip of line) {
        const w = ctx.measureText(chip).width;
        roundRect(ctx, x - 8, y - 22, w + 16, 30, 8);
        ctx.fillStyle = 'rgba(124,240,200,0.12)';
        ctx.fill();
        ctx.fillStyle = '#e8f6f1';
        ctx.fillText(chip, x, y);
        x += w + 26;
      }
      y += 34;
    }
    y += 18;
  }

  return canvas.toBuffer('image/png');
}

export interface WelcomeCardInput {
  title: string; // "WELCOME" | "GOODBYE"
  name: string;
  groupName: string;
  memberCount: number;
  avatar?: Buffer;
  accent?: string;
}

export async function renderWelcomeCard(input: WelcomeCardInput): Promise<Buffer> {
  const W = 760;
  const H = 300;
  const accent = input.accent ?? '#7cf0c8';
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  verticalGradient(ctx, W, H, [
    [0, '#141e30'],
    [1, '#243b55'],
  ]);

  // avatar (circle) on the left
  const cx = 150;
  const cy = H / 2;
  const r = 96;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  let drew = false;
  if (input.avatar) {
    try {
      const img = await loadImage(input.avatar);
      ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
      drew = true;
    } catch {
      drew = false;
    }
  }
  if (!drew) {
    ctx.fillStyle = accent;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = '#12202b';
    ctx.font = `800 96px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((input.name[0] ?? '?').toUpperCase(), cx, cy + 4);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();

  // ring
  ctx.strokeStyle = accent;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // text block on the right
  const tx = 280;
  ctx.fillStyle = accent;
  ctx.font = `800 46px ${FONT}`;
  ctx.fillText(input.title, tx, 110);

  ctx.fillStyle = '#ffffff';
  ctx.font = `600 30px ${FONT}`;
  ctx.fillText(truncate(ctx, input.name, W - tx - 30), tx, 160);

  ctx.fillStyle = '#b9c8d6';
  ctx.font = `400 22px ${FONT}`;
  ctx.fillText(truncate(ctx, input.groupName, W - tx - 30), tx, 200);
  ctx.fillText(`Member #${input.memberCount}`, tx, 234);

  return canvas.toBuffer('image/png');
}

/**
 * The default menu banner: the bot name over a background. If `bg` is provided
 * (an image shipped in assets/), it's used and darkened for legibility;
 * otherwise a gradient. Text is drawn with canvas so it's always crisp.
 */
export async function renderNameBanner(botName: string, subtitle: string, bg?: Buffer): Promise<Buffer> {
  const W = 800;
  const H = 450;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  let usedBg = false;
  if (bg) {
    try {
      const img = await loadImage(bg);
      const scale = Math.max(W / img.width, H / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.fillStyle = 'rgba(8,14,20,0.55)';
      ctx.fillRect(0, 0, W, H);
      usedBg = true;
    } catch {
      usedBg = false;
    }
  }
  if (!usedBg) {
    verticalGradient(ctx, W, H, [
      [0, '#0f2027'],
      [0.5, '#203a43'],
      [1, '#2c5364'],
    ]);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#7cf0c8';
  ctx.font = `800 104px ${FONT}`;
  ctx.fillText(botName.toUpperCase(), W / 2, H / 2 - 6);
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.font = `500 30px ${FONT}`;
  ctx.fillText(subtitle, W / 2, H / 2 + 70);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  return canvas.toBuffer('image/jpeg');
}

function truncate(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}
