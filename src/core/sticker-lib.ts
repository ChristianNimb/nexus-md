import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import axios from 'axios';
import { loadImage, createCanvas } from '@napi-rs/canvas';
import { config } from '../config.js';
import { addSticker, hasSticker, listStickers } from '../db/index.js';
import { logger } from '../logger.js';

/**
 * Nexus's real sticker collection: stickers people send in chats where Nexus is
 * active are de-duplicated, stored on disk, and (optionally) captioned by a
 * vision model so Nexus can later pick the one that fits the mood.
 */

function stickerDir(): string {
  const d = dirname(config.dbPath);
  const base = d && d !== '.' ? d : '.';
  return join(base, 'stickers');
}
function stickerPath(id: string): string {
  return join(stickerDir(), `${id}.webp`);
}

export function stickerHash(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex').slice(0, 16);
}

export function stickerExists(id: string): boolean {
  return hasSticker(id) && existsSync(stickerPath(id));
}

export function saveSticker(buf: Buffer, meta: { desc?: string; tags?: string[] }): string {
  const id = stickerHash(buf);
  const dir = stickerDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(stickerPath(id), buf);
  addSticker(id, { desc: meta.desc ?? '', tags: meta.tags ?? [], at: Date.now() });
  return id;
}

export function loadSticker(id: string): Buffer | undefined {
  const p = stickerPath(id);
  return existsSync(p) ? readFileSync(p) : undefined;
}

export function stickerCatalog(): { id: string; desc: string; tags: string[] }[] {
  return listStickers();
}

export function randomStickerId(): string | undefined {
  const all = listStickers();
  return all.length ? all[Math.floor(Math.random() * all.length)].id : undefined;
}

/** WebP sticker -> PNG data URL, for vision models that prefer PNG/JPEG. */
async function webpToPngDataUrl(webp: Buffer): Promise<string> {
  const img = await loadImage(webp);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, img.width, img.height);
  return `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`;
}

export interface StickerCaption {
  desc: string;
  tags: string[];
  good: boolean;
}

/**
 * "Look at" a sticker with a vision model and return a caption + mood tags and
 * whether it's a good expressive reaction sticker. Returns undefined when no
 * vision model is configured or the call fails (collection still proceeds).
 */
export async function captionSticker(webp: Buffer): Promise<StickerCaption | undefined> {
  // Use the DEDICATED vision endpoint (e.g. Groq), NOT the primary chat endpoint
  // — the primary is usually the local model, which can't see images, so
  // captioning (and therefore auto-saving) would silently fail there.
  const url = config.nexus.visionUrl;
  const key = config.nexus.visionKey;
  const model = config.nexus.visionModel;
  if (!model || !key || !url) return undefined;
  if (/anthropic\.com/i.test(url)) return undefined; // OpenAI-format only

  try {
    const dataUrl = await webpToPngDataUrl(webp);
    const res = await axios.post<{ choices?: { message?: { content?: string } }[] }>(
      url,
      {
        model,
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'Describe this WhatsApp sticker in 3-6 words and give 3-5 lowercase mood/emotion tags. ' +
                  'Is it a good expressive reaction sticker? Reply ONLY compact JSON: {"desc":"...","tags":["..."],"good":true}',
              },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      },
      { headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, timeout: 45_000 },
    );

    const text = res.data.choices?.[0]?.message?.content ?? '';
    const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as { desc?: string; tags?: unknown; good?: boolean };
    return {
      desc: String(json.desc ?? ''),
      tags: Array.isArray(json.tags) ? json.tags.map(String) : [],
      good: json.good !== false,
    };
  } catch (err) {
    logger.warn({ err }, 'sticker caption failed');
    return undefined;
  }
}
