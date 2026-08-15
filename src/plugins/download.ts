import axios from 'axios';
import { command } from '../core/registry.js';
import { runCommandText } from '../core/handler.js';
import { isDownloadableUrl } from '../core/downloaders/index.js';
import { ProgressBar, humanBytes } from '../core/progress.js';
import { logger } from '../logger.js';

/**
 * Download a DIRECT file from a URL (a .zip/.pdf/.mp3 link, etc.) and send it
 * back with a live progress bar. For social/media links (YouTube, Pinterest,
 * TikTok…) it hands off to the real media downloader (.dl) — raw-fetching those
 * just grabs an HTML page, which is useless.
 */
command(
  { pattern: 'download (.+)', desc: 'Download a file from a URL', usage: '<url>', category: 'media', fromMe: true },
  async (m, match) => {
    const url = match?.[1]?.trim();
    if (!url || !/^https?:\/\//i.test(url)) return m.reply('Usage: .download <http(s) url>');

    // A social/media link → use the proper media downloader, not a raw fetch.
    if (isDownloadableUrl(url)) {
      await runCommandText(m, `dl ${url} hd`);
      return;
    }

    const bar = await ProgressBar.start(m, 'Downloading', '📥');
    try {
      const res = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: 120_000,
        maxContentLength: 100 * 1024 * 1024,
        maxRedirects: 5,
        onDownloadProgress: (e) => {
          if (e.total) void bar.update(e.loaded / e.total, `${humanBytes(e.loaded)} / ${humanBytes(e.total)}`);
        },
      });

      const buffer = Buffer.from(res.data);
      await bar.finish(`✅ *Downloaded* — \`${humanBytes(buffer.length)}\``);

      const fileName = url.split('/').pop()?.split('?')[0] || 'file';
      const mimetype = String(res.headers['content-type'] ?? 'application/octet-stream');
      await m.send({ document: buffer, fileName, mimetype }, { quoted: m.raw });
    } catch (err) {
      logger.error({ err, url }, 'download failed');
      await bar.finish('❌ *Download failed.* The link may be invalid or too large.');
    }
  },
);
