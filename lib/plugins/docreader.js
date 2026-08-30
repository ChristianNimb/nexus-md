import { spawn } from 'node:child_process';
import { writeFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { command } from '../core/registry.js';
import { config, nexusEnabled } from '../config.js';
import { unwrapContent } from '../core/message.js';
import { logger } from '../logger.js';
async function getDocument(m) {
    const own = unwrapContent(m.raw.message);
    const quoted = m.quoted?.raw;
    const ownDoc = own?.documentMessage ?? own?.imageMessage;
    const node = ownDoc ?? quoted?.documentMessage ?? quoted?.imageMessage;
    if (!node)
        return undefined;
    const buffer = await m.downloadMedia(!ownDoc);
    if (!buffer)
        return undefined;
    const isImage = node === own?.imageMessage || node === quoted?.imageMessage;
    return { buffer, name: node.fileName ?? (isImage ? 'image.jpg' : 'document'), mime: node.mimetype ?? (isImage ? 'image/jpeg' : '') };
}
function run(cmd, args) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const out = [];
        const err = [];
        p.stdout.on('data', (d) => out.push(d));
        p.stderr.on('data', (d) => err.push(d));
        p.on('error', reject);
        p.on('close', (code) => code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(Buffer.concat(err).toString().slice(-200))));
    });
}
async function pdfToText(buf) {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-doc-'));
    const inFile = join(dir, 'in.pdf');
    try {
        await writeFile(inFile, buf);
        const text = await run('pdftotext', ['-q', '-enc', 'UTF-8', inFile, '-']);
        return text.trim() || undefined;
    }
    catch (err) {
        logger.warn({ err }, 'pdftotext failed');
        return undefined;
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}
async function docxToText(buf) {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-doc-'));
    const inFile = join(dir, 'in.docx');
    try {
        await writeFile(inFile, buf);
        const xml = await run('unzip', ['-p', inFile, 'word/document.xml']);
        const text = xml
            .replace(/<\/w:p>/gi, '\n')
            .replace(/<w:tab\/>/gi, '\t')
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;|&apos;/g, "'")
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        return text || undefined;
    }
    catch (err) {
        logger.warn({ err }, 'docx extract failed');
        return undefined;
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}
async function ocrImage(buf) {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-ocr-'));
    const inFile = join(dir, 'in.png');
    try {
        await writeFile(inFile, buf);
        const text = await run('tesseract', [inFile, 'stdout', '-l', 'eng+chi_sim']);
        return text.trim() || undefined;
    }
    catch (err) {
        logger.warn({ err }, 'image OCR failed');
        return undefined;
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}
async function ocrPdf(buf) {
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
            }
            catch {
            }
        }
        return text.trim() || undefined;
    }
    catch (err) {
        logger.warn({ err }, 'pdf OCR failed');
        return undefined;
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}
async function extractText(doc) {
    const ext = (doc.name.split('.').pop() ?? '').toLowerCase();
    const isPdf = doc.mime.includes('pdf') || ext === 'pdf';
    const isDocx = ext === 'docx' || doc.mime.includes('wordprocessingml');
    const isImage = doc.mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tiff'].includes(ext);
    const isText = doc.mime.startsWith('text/') || ['txt', 'md', 'csv', 'log', 'json', 'xml', 'html'].includes(ext);
    if (isText)
        return doc.buffer.toString('utf8').slice(0, 100_000) || undefined;
    if (isImage)
        return ocrImage(doc.buffer);
    if (isDocx)
        return docxToText(doc.buffer);
    if (isPdf) {
        const layer = await pdfToText(doc.buffer);
        if (layer && layer.replace(/\s+/g, '').length >= 40)
            return layer;
        return (await ocrPdf(doc.buffer)) ?? layer;
    }
    return undefined;
}
function strip(text) {
    const end = text.lastIndexOf('</think>');
    return (end !== -1 ? text.slice(end + 8) : text).replace(/<\/?think>/gi, '').trim();
}
async function ask(sys, user) {
    const providers = [
        { url: config.nexus.url, key: config.nexus.key, model: config.nexus.model },
        { url: config.nexus.fallbackUrl, key: config.nexus.fallbackKey, model: config.nexus.fallbackModel },
    ];
    let lastErr;
    for (const p of providers) {
        if (!p.key || !p.model)
            continue;
        try {
            const anthropic = /anthropic\.com/i.test(p.url);
            const sysMsg = /qwen/i.test(p.model) ? `${sys}\n\n/no_think` : sys;
            if (anthropic) {
                const r = await axios.post(p.url, { model: p.model, max_tokens: 1200, system: sysMsg, messages: [{ role: 'user', content: user }] }, { headers: { 'x-api-key': p.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 90_000 });
                return strip((r.data.content ?? []).map((x) => x.text ?? '').join(''));
            }
            const r = await axios.post(p.url, { model: p.model, max_tokens: 1200, messages: [{ role: 'system', content: sysMsg }, { role: 'user', content: user }] }, { headers: { Authorization: `Bearer ${p.key}`, 'content-type': 'application/json' }, timeout: 90_000 });
            return strip(r.data.choices?.[0]?.message?.content ?? '');
        }
        catch (err) {
            lastErr = err;
        }
    }
    throw lastErr ?? new Error('No AI provider configured.');
}
command({ pattern: 'read(?: (.*))?', desc: 'Read/summarise a PDF or document (reply to it, or send with caption)', usage: '[question]', category: 'tools' }, async (m, match) => {
    const doc = await getDocument(m);
    if (!doc) {
        return m.reply('📄 Send (or reply to) a PDF, Word doc, or a photo/screenshot with .read.\n• .read. Summary\n• .read full. The entire text, no summary\n• .read what are the key dates?. Ask a question\nSupported: PDF (incl. scanned), DOCX, TXT, and images (I’ll OCR the text).');
    }
    await m.react('📖');
    const text = await extractText(doc);
    if (!text) {
        return m.reply(`😕 I couldn't pull any readable text out of ${doc.name}. (If it's a photo/scan, make sure the text is clear and not too small.)`);
    }
    const question = (match?.[1] ?? '').trim();
    if (/^(full|raw|text|all|everything|no ?summary|dont summar|don'?t summar|verbatim)\b/i.test(question)) {
        const CHUNK = 3500;
        const clean = text.trim();
        if (clean.length <= CHUNK) {
            return m.reply(`📄 ${doc.name}. Full text\n\n${clean}`);
        }
        const parts = [];
        for (let i = 0; i < clean.length; i += CHUNK)
            parts.push(clean.slice(i, i + CHUNK));
        await m.reply(`📄 ${doc.name}. Full text (${parts.length} parts)`);
        for (let i = 0; i < parts.length; i++) {
            await m.reply(`*[${i + 1}/${parts.length}]*\n\n${parts[i]}`);
        }
        return undefined;
    }
    if (!nexusEnabled()) {
        const head = text.slice(0, 1500);
        return m.reply(`📄 ${doc.name}\n\n${head}${text.length > 1500 ? '\n\n…(truncated)' : ''}`);
    }
    const sys = question
        ? `You are Nexus. Answer the user's QUESTION using ONLY the document text provided. If the answer isn't in it, say so. Be concise and clear.`
        : `You are Nexus. Summarise the document clearly: what it is, its purpose, and the key points/figures/dates. Keep it tight and easy to read.`;
    const userMsg = (question ? `QUESTION: ${question}\n\n` : '') + `DOCUMENT (${doc.name}):\n${text.slice(0, 14_000)}`;
    try {
        const answer = await ask(sys, userMsg);
        await m.reply(`📄 ${doc.name}\n\n${answer || '(no response)'}`);
    }
    catch (err) {
        logger.error({ err }, 'doc summarise failed');
        await m.reply("📄 I read the file, but couldn't summarise it right now (AI unavailable). Try again shortly.");
    }
});
