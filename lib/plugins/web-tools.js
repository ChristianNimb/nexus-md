import { command } from '../core/registry.js';
import { httpGet, httpGetBuffer, httpPost, firstOk } from '../core/net.js';
import { resolveJid } from '../core/lid.js';
import { logger } from '../logger.js';
async function qrQuickChart(text) {
    const buf = await httpGetBuffer(`https://quickchart.io/qr?size=500&margin=2&text=${encodeURIComponent(text)}`);
    return buf.length > 500 ? buf : undefined;
}
async function qrServer(text) {
    const buf = await httpGetBuffer(`https://api.qrserver.com/v1/create-qr-code/?size=500x500&margin=8&data=${encodeURIComponent(text)}`);
    return buf.length > 500 ? buf : undefined;
}
command({ pattern: 'qr(?: (.+))?', desc: 'QR code. Text, link, or a WhatsApp contact', usage: '<text|url|number> or reply', category: 'utility' }, async (m, match) => {
    let text = (match?.[1] ?? '').trim();
    let caption = '';
    if (!text && m.quoted?.sender) {
        const pn = await resolveJid(m.client, m.quoted.sender, m.isGroup ? m.chat : undefined);
        const num = pn.split('@')[0].split(':')[0];
        if (pn.endsWith('@s.whatsapp.net') && /^\d{7,15}$/.test(num)) {
            text = `https://wa.me/${num}`;
            caption = `🔳 Scan to message +${num} on WhatsApp`;
        }
        else if (m.quoted.text) {
            text = m.quoted.text;
        }
        else {
            return m.reply('🔳 Couldn\'t get that person\'s number just now. Reply again, or give me one: .qr <number>.');
        }
    }
    if (!caption && /^\+?[\d][\d\s-]{6,}$/.test(text)) {
        const num = text.replace(/\D/g, '');
        if (num.length >= 7) {
            text = `https://wa.me/${num}`;
            caption = `🔳 Scan to message +${num} on WhatsApp`;
        }
    }
    if (!text)
        return m.reply('🔳 .qr <text/link>, or reply to a message to get that person\'s WhatsApp QR, or .qr <number> for a click-to-chat code.');
    await m.react('🔳');
    const buf = await firstOk([() => qrQuickChart(text), () => qrServer(text)]);
    if (!buf)
        return m.reply('😕 Couldn\'t make that QR right now. Try again shortly.');
    await m.send({ image: buf, caption: caption || `🔳 QR for: ${text.slice(0, 80)}` }, { quoted: m.raw });
});
async function shortIsGd(url) {
    const r = await httpGet(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`, { text: true });
    return /^https?:\/\//i.test(r.trim()) ? r.trim() : undefined;
}
async function shortTinyUrl(url) {
    const r = await httpGet(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`, { text: true });
    return /^https?:\/\//i.test(r.trim()) ? r.trim() : undefined;
}
command({ pattern: 'short (.+)', desc: 'Shorten a long link', usage: '<url>', category: 'utility' }, async (m, match) => {
    const url = (match?.[1] ?? '').trim();
    if (!/^https?:\/\//i.test(url))
        return m.reply('Give me a full link. .short https://example.com/very/long/path');
    await m.react('🔗');
    const out = await firstOk([() => shortIsGd(url), () => shortTinyUrl(url)]);
    await m.reply(out ? `🔗 ${out}` : '😕 Couldn\'t shorten that right now.');
});
async function ssThumIo(url) {
    const buf = await httpGetBuffer(`https://image.thum.io/get/width/1000/crop/1400/${url}`, { timeout: 25_000 });
    return buf.length > 2000 ? buf : undefined;
}
async function ssMicrolink(url) {
    const buf = await httpGetBuffer(`https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=true&embed=screenshot.url`, { timeout: 25_000 });
    return buf.length > 2000 ? buf : undefined;
}
command({ pattern: 'ss (.+)', desc: 'Screenshot a web page', usage: '<url>', category: 'utility' }, async (m, match) => {
    let url = (match?.[1] ?? '').trim();
    if (!/^https?:\/\//i.test(url))
        url = `https://${url}`;
    await m.react('📸');
    const buf = await firstOk([() => ssThumIo(url), () => ssMicrolink(url)]);
    if (!buf)
        return m.reply('😕 Couldn\'t screenshot that page. It may block bots, or be unreachable from here.');
    await m.send({ image: buf, caption: `📸 ${url}` }, { quoted: m.raw });
});
async function imageBuffer(m) {
    if (m.type === 'imageMessage')
        return m.downloadMedia(false);
    const q = m.quoted?.raw;
    if (q && ('imageMessage' in q || 'stickerMessage' in q))
        return m.downloadMedia(true);
    return undefined;
}
command({ pattern: 'scan', desc: 'Read a QR code from an image (reply to it)', category: 'utility' }, async (m) => {
    const buf = await imageBuffer(m);
    if (!buf)
        return m.reply('📷 Reply to an image with a QR code and I\'ll read it.');
    await m.react('🔍');
    try {
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(buf)]), 'qr.png');
        const data = await httpPost('https://api.qrserver.com/v1/read-qr-code/', form, { timeout: 20_000 });
        const value = data?.[0]?.symbol?.[0]?.data;
        if (!value)
            return m.reply('😕 I couldn\'t find a QR code in that image (or it was unreadable).');
        await m.reply(`🔍 QR content:\n${value}`);
    }
    catch (err) {
        logger.warn({ err }, 'qr scan failed');
        await m.reply('😕 Couldn\'t read that QR right now. Try a clearer image.');
    }
});
logger.debug('web-tools plugin loaded');
