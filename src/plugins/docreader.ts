import { spawn } from 'node:child_process';
import { writeFile, readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { command } from '../core/registry.js';
import { config, nexusEnabled } from '../config.js';
import { unwrapContent } from '../core/message.js';
import { logger } from '../logger.js';
import type { Message } from '../core/message.js';

/**
 * Document reader — ".read" a PDF / TXT / DOCX (sent or replied-to) and Nexus
 * extracts the text and summarises it (or answers a question about it).
 *
 * Extraction: pdftotext (poppler) for PDFs, plain read for text, unzip for DOCX.
 * All installed in the Docker image.
 */

interface Doc {
  buffer: Buffer;
  name: string;
  mime: string;
}

/** Find a document OR image on this message / the one it replies to, download it. */
async function getDocument(m: Message): Promise<Doc | undefined> {
  type Node = { fileName?: string; mimetype?: string };
  const own = unwrapContent(m.raw.message) as { documentMessage?: Node; imageMessage?: Node } | undefined;
  const quoted = m.quoted?.raw as { documentMessage?: Node; imageMessage?: Node } | undefined;

  const ownDoc = own?.documentMessage ?? own?.imageMessage;
  const node = ownDoc ?? quoted?.documentMessage ?? quoted?.imageMessage;
  if (!node) return undefined;

  const buffer = await m.downloadMedia(!ownDoc); // fromQuoted when it's not our own
  if (!buffer) return undefined;
  const isImage = node === own?.imageMessage || node === quoted?.imageMessage;
  return { buffer, name: node.fileName ?? (isImage ? 'image.jpg' : 'document'), mime: node.mimetype ?? (isImage ? 'image/jpeg' : '') };
}

/** Run a command, feeding optional stdin, returning stdout as UTF-8. */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => err.push(d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(Buffer.concat(err).toString().slice(-200))),
    );
  });
}

async function pdfToText(buf: Buffer): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-doc-'));
  const inFile = join(dir, 'in.pdf');
  try {
    await writeFile(inFile, buf);
    const text = await run('pdftotext', ['-q', '-enc', 'UTF-8', inFile, '-']);
    return text.trim() || undefined;
  } catch (err) {
    logger.warn({ err }, 'pdftotext failed');
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function docxToText(buf: Buffer): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-doc-'));
  const inFile = join(dir, 'in.docx');
  try {
    await writeFile(inFile, buf);
    // DOCX is a zip; the body text lives in word/document.xml.
    const xml = await run('unzip', ['-p', inFile, 'word/document.xml']);
    const text = xml
      .replace(/<\/w:p>/gi, '\n') // paragraphs → newlines
      .replace(/<w:tab\/>/gi, '\t')
      .replace(/<[^>]+>/g, '') // strip tags
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text || undefined;
  } catch (err) {
    logger.warn({ err }, 'docx extract failed');
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** OCR a single image (screenshot/photo) with Tesseract — English + Chinese. */
async function ocrImage(buf: Buffer): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-ocr-'));
  const inFile = join(dir, 'in.png');
  try {
    await writeFile(inFile, buf);
    const text = await run('tesseract', [inFile, 'stdout', '-l', 'eng+chi_sim']);
    return text.trim() || undefined;
  } catch (err) {
    logger.warn({ err }, 'image OCR failed');
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** OCR a SCANNED / image-only PDF: rasterise pages (pdftoppm) then Tesseract each.
 *  Capped at 15 pages so a huge scan can't hang the bot. */
async function ocrPdf(buf: Buffer): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-ocr-'));
  const inFile = join(dir, 'in.pdf');
  try {
    await writeFile(inFile, buf);
    await run('pdftoppm', ['-png', '-r', '200', '-l', '15', inFile, join(dir, 'page')]);
    const pages = (await readdir(dir)).filter((f) => f.endsWith('.png')).sort();
    let text = '';
    for (const p of pages) {
      try {
        text += (await run('tesseract', [join(dir, p), 'stdout', '-l', 'eng+chi_sim'])) + '\n';
      } catch {
        /* skip a bad page */
      }
    }
    return text.trim() || undefined;
  } catch (err) {
    logger.warn({ err }, 'pdf OCR failed');
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function extractText(doc: Doc): Promise<string | undefined> {
  const ext = (doc.name.split('.').pop() ?? '').toLowerCase();
  const isPdf = doc.mime.includes('pdf') || ext === 'pdf';
  const isDocx = ext === 'docx' || doc.mime.includes('wordprocessingml');
  const isImage = doc.mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tiff'].includes(ext);
  const isText = doc.mime.startsWith('text/') || ['txt', 'md', 'csv', 'log', 'json', 'xml', 'html'].includes(ext);

  if (isText) return doc.buffer.toString('utf8').slice(0, 100_000) || undefined;
  if (isImage) return ocrImage(doc.buffer); // photo / screenshot → OCR
  if (isDocx) return docxToText(doc.buffer);
  if (isPdf) {
    const layer = await pdfToText(doc.buffer);
    // If the PDF has a real text layer, use it. If it's basically empty, it's a
    // SCANNED / image PDF → fall back to OCR.
    if (layer && layer.replace(/\s+/g, '').length >= 40) return layer;
    return (await ocrPdf(doc.buffer)) ?? layer;
  }
  return undefined;
}

/** Strip Qwen3 <think> blocks. */
function strip(text: string): string {
  const end = text.lastIndexOf('</think>');
  return (end !== -1 ? text.slice(end + 8) : text).replace(/<\/?think>/gi, '').trim();
}

/** Ask the Nexus model to summarise / answer, with primary→fallback. */
async function ask(sys: string, user: string): Promise<string> {
  const providers = [
    { url: config.nexus.url, key: config.nexus.key, model: config.nexus.model },
    { url: config.nexus.fallbackUrl, key: config.nexus.fallbackKey, model: config.nexus.fallbackModel },
  ];
  let lastErr: unknown;
  for (const p of providers) {
    if (!p.key || !p.model) continue;
    try {
      const anthropic = /anthropic\.com/i.test(p.url);
      const sysMsg = /qwen/i.test(p.model) ? `${sys}\n\n/no_think` : sys;
      if (anthropic) {
        const r = await axios.post<{ content?: { text?: string }[] }>(
          p.url,
          { model: p.model, max_tokens: 1200, system: sysMsg, messages: [{ role: 'user', content: user }] },
          { headers: { 'x-api-key': p.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 90_000 },
        );
        return strip((r.data.content ?? []).map((x) => x.text ?? '').join(''));
      }
      const r = await axios.post<{ choices?: { message?: { content?: string } }[] }>(
        p.url,
        { model: p.model, max_tokens: 1200, messages: [{ role: 'system', content: sysMsg }, { role: 'user', content: user }] },
        { headers: { Authorization: `Bearer ${p.key}`, 'content-type': 'application/json' }, timeout: 90_000 },
      );
      return strip(r.data.choices?.[0]?.message?.content ?? '');
    } catch (err) {
      lastErr = err;
      // try the fallback provider on any error
    }
  }
  throw lastErr ?? new Error('No AI provider configured.');
}

command(
  { pattern: 'read ?(.*)', desc: 'Read/summarise a PDF or document (reply to it, or send with caption)', usage: '[question]', category: 'tools' },
  async (m, match) => {
    const doc = await getDocument(m);
    if (!doc) {
      return m.reply(
        '📄 Send (or reply to) a PDF, Word doc, or a photo/screenshot with *.read*.\n• *.read* — summary\n• *.read full* — the entire text, no summary\n• *.read what are the key dates?* — ask a question\nSupported: PDF (incl. *scanned*), DOCX, TXT, and images (I’ll OCR the text).',
      );
    }

    await m.react('📖');
    const text = await extractText(doc);
    if (!text) {
      return m.reply(`😕 I couldn't pull any readable text out of *${doc.name}*. (If it's a photo/scan, make sure the text is clear and not too small.)`);
    }

    const question = (match?.[1] ?? '').trim();

    // "full" / "raw" / "text" / "all" / "no summary" → dump the ENTIRE extracted
    // text, no AI summarising. Long docs are split into WhatsApp-safe chunks.
    if (/^(full|raw|text|all|everything|no ?summary|dont summar|don'?t summar|verbatim)\b/i.test(question)) {
      const CHUNK = 3500;
      const clean = text.trim();
      if (clean.length <= CHUNK) {
        return m.reply(`📄 *${doc.name}* — full text\n\n${clean}`);
      }
      // Send header + numbered chunks so the whole document comes through.
      const parts: string[] = [];
      for (let i = 0; i < clean.length; i += CHUNK) parts.push(clean.slice(i, i + CHUNK));
      await m.reply(`📄 *${doc.name}* — full text (${parts.length} parts)`);
      for (let i = 0; i < parts.length; i++) {
        await m.reply(`*[${i + 1}/${parts.length}]*\n\n${parts[i]}`);
      }
      return undefined;
    }

    // No AI configured → just hand back the first chunk of the extracted text.
    if (!nexusEnabled()) {
      const head = text.slice(0, 1500);
      return m.reply(`📄 *${doc.name}*\n\n${head}${text.length > 1500 ? '\n\n…(truncated)' : ''}`);
    }

    const sys = question
      ? `You are Nexus. Answer the user's QUESTION using ONLY the document text provided. If the answer isn't in it, say so. Be concise and clear.`
      : `You are Nexus. Summarise the document clearly: what it is, its purpose, and the key points/figures/dates. Keep it tight and easy to read.`;
    const userMsg = (question ? `QUESTION: ${question}\n\n` : '') + `DOCUMENT (${doc.name}):\n${text.slice(0, 14_000)}`;

    try {
      const answer = await ask(sys, userMsg);
      await m.reply(`📄 *${doc.name}*\n\n${answer || '(no response)'}`);
    } catch (err) {
      logger.error({ err }, 'doc summarise failed');
      await m.reply("📄 I read the file, but couldn't summarise it right now (AI unavailable). Try again shortly.");
    }
  },
);
