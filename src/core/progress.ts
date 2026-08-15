import type { WAMessageKey } from 'baileys';
import type { Message } from './message.js';

/**
 * In-place "animation" for WhatsApp.
 *
 * WhatsApp has no animated messages, but a sent message can be edited, and each
 * edit rewrites the same bubble. Editing on a timer produces a live-updating
 * progress bar or spinner. WhatsApp rate-limits edits, so everything here is
 * throttled to roughly one update per second.
 */

/** Partial-block glyphs give the bar sub-cell smoothness (1/8 increments). */
const PARTIAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const FULL = '█';
const EMPTY = '░';

/** Render a determinate bar for a 0..1 fraction, e.g. `████████▌░░░░░`. */
export function renderBar(fraction: number, width = 14): string {
  const f = Math.max(0, Math.min(1, fraction));
  const exact = f * width;
  const full = Math.floor(exact);
  const partIdx = Math.floor((exact - full) * 8);
  const hasPartial = full < width && partIdx > 0;

  let bar = FULL.repeat(full);
  if (hasPartial) bar += PARTIAL[partIdx];
  bar += EMPTY.repeat(Math.max(0, width - full - (hasPartial ? 1 : 0)));
  return bar;
}

/** Human-readable byte size. */
export function humanBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

/** Minimum spacing between edits to stay within WhatsApp's limits. */
const MIN_EDIT_MS = 900;

async function editMessage(m: Message, key: WAMessageKey | undefined, text: string): Promise<void> {
  try {
    if (key) await m.client.sendMessage(m.chat, { text, edit: key });
    else await m.sendText(text);
  } catch {
    /* swallow rate-limit / edit-window failures — animation is best-effort */
  }
}

/**
 * A determinate progress bar. Drive it with a 0..1 fraction (e.g. bytes
 * downloaded / total). Updates are throttled and only sent when the rendered
 * frame actually changes.
 */
export class ProgressBar {
  private key: WAMessageKey | undefined;
  private lastEdit = 0;
  private lastText = '';
  private readonly startedAt = Date.now();
  private hasReal = false; // have we ever received a genuine byte-fraction?
  private note: string | undefined;
  private simFraction = 0; // eased, ever-increasing simulated progress
  private timer: ReturnType<typeof setInterval> | undefined;

  /** How quickly the simulated bar climbs (ms). Smaller = faster to ~90%. */
  private static readonly TAU = 7000;

  private constructor(
    private readonly m: Message,
    private readonly label: string,
    private readonly emoji: string,
  ) {}

  static async start(m: Message, label: string, emoji = '📥'): Promise<ProgressBar> {
    const bar = new ProgressBar(m, label, emoji);
    const first = bar.frame(0);
    const sent = await m.send({ text: first });
    bar.key = sent?.key ?? undefined;
    bar.lastText = first;
    bar.lastEdit = Date.now();
    // Drive a real-looking, ever-climbing percentage. If the source reports true
    // byte progress, that takes over (see update); otherwise this eased curve
    // carries it — a proper 0→100 download bar, never a spinner.
    bar.timer = setInterval(() => void bar.tick(), 1000);
    return bar;
  }

  /** Eased progress toward ~92% — fast at first, decelerating like a real
   *  download whose last bytes always drag. Never reaches 100% until finish(). */
  private simulate(): number {
    const t = Date.now() - this.startedAt;
    const f = 0.92 * (1 - Math.exp(-t / ProgressBar.TAU));
    // Monotonic: never let a tick render a lower % than before.
    this.simFraction = Math.max(this.simFraction, f);
    return this.simFraction;
  }

  private frame(fraction: number): string {
    const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
    const pad = String(pct).padStart(3, ' ');
    return `${this.emoji} *${this.label}*\n\`${renderBar(fraction)}\` ${pad}%${this.note ? `\n_${this.note}_` : ''}`;
  }

  private async tick(): Promise<void> {
    if (this.hasReal) return; // real byte-progress is driving the display now
    const text = this.frame(this.simulate());
    if (text === this.lastText) return;
    this.lastText = text;
    this.lastEdit = Date.now();
    await editMessage(this.m, this.key, text);
  }

  /** Report REAL progress (0..1) — bytes downloaded / total. Overrides the
   *  simulated climb the moment genuine data arrives. */
  async update(fraction: number, note?: string): Promise<void> {
    if (note !== undefined) this.note = note;
    if (fraction > 0) this.hasReal = true; // real data → stop simulating
    if (!this.hasReal) return; // no real total yet — let the eased bar carry it
    const text = this.frame(fraction);
    if (text === this.lastText) return;
    const now = Date.now();
    if (fraction < 1 && now - this.lastEdit < MIN_EDIT_MS) return;
    this.lastText = text;
    this.lastEdit = now;
    await editMessage(this.m, this.key, text);
  }

  /** Final frame — snaps to 100%. Pass custom text or let it render a full bar. */
  async finish(text?: string): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.lastText = text ?? this.frame(1);
    await editMessage(this.m, this.key, this.lastText);
  }
}

/** Braille frames — a compact, monospace-safe spinner. */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const TICK_MS = 1200;
const MAX_LIFETIME_MS = 5 * 60 * 1000;

/**
 * An indeterminate spinner for waits of unknown length (media conversion, AI
 * calls). Ticks a new frame roughly once a second until `stop()`.
 */
export class Spinner {
  private key: WAMessageKey | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private safety: ReturnType<typeof setTimeout> | undefined;
  private i = 0;
  private stopped = false;

  private constructor(
    private readonly m: Message,
    private readonly label: string,
  ) {}

  static async start(m: Message, label: string): Promise<Spinner> {
    const s = new Spinner(m, label);
    const sent = await m.send({ text: s.frame() });
    s.key = sent?.key ?? undefined;
    s.timer = setInterval(() => void s.tick(), TICK_MS);
    s.safety = setTimeout(() => void s.stop(), MAX_LIFETIME_MS);
    return s;
  }

  private frame(): string {
    return `${SPINNER_FRAMES[this.i % SPINNER_FRAMES.length]}  *${this.label}…*`;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    this.i++;
    await editMessage(this.m, this.key, this.frame());
  }

  /** Stop the animation; optionally replace the bubble with a final message. */
  async stop(finalText?: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.safety) clearTimeout(this.safety);
    if (finalText) await editMessage(this.m, this.key, finalText);
  }
}
