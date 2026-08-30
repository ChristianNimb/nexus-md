import axios from 'axios';
import { command } from '../core/registry.js';
import { runCommandText } from '../core/handler.js';
import { isDownloadableUrl } from '../core/downloaders/index.js';
import { Progress } from '../core/progress.js';
import { logger } from '../logger.js';
command({ pattern: 'download (.+)', desc: 'Download a file from a URL', usage: '<url>', category: 'media', fromMe: true }, async (m, match) => {
    const url = match?.[1]?.trim();
    if (!url || !/^https?:\/\//i.test(url))
        return m.reply('Usage: .download <http(s) url>');
    if (isDownloadableUrl(url)) {
        await runCommandText(m, `dl ${url} hd`);
        return;
    }
    const progress = await Progress.start(m, '📥');
    try {
        const res = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 120_000,
            maxContentLength: 100 * 1024 * 1024,
            maxRedirects: 5,
        });
        const buffer = Buffer.from(res.data);
        await progress.done();
        const fileName = url.split('/').pop()?.split('?')[0] || 'file';
        const mimetype = String(res.headers['content-type'] ?? 'application/octet-stream');
        await m.send({ document: buffer, fileName, mimetype }, { quoted: m.raw });
    }
    catch (err) {
        logger.error({ err, url }, 'download failed');
        await progress.fail();
        await m.reply('❌ Download failed. The link may be invalid or too large.');
    }
});
