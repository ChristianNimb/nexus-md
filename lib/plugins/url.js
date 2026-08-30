import { command } from '../core/registry.js';
import { Spinner } from '../core/progress.js';
import { logger } from '../logger.js';
async function uploadCatbox(buffer, fileName) {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', new Blob([new Uint8Array(buffer)]), fileName);
    const res = await fetch('https://catbox.moe/user/api.php', {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(60_000),
    });
    const text = (await res.text()).trim();
    if (!res.ok || !/^https?:\/\//i.test(text)) {
        throw new Error(`catbox (${res.status}): ${text.slice(0, 120)}`);
    }
    return text;
}
async function upload0x0(buffer, fileName) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buffer)]), fileName);
    const res = await fetch('https://0x0.st', {
        method: 'POST',
        body: form,
        headers: { 'User-Agent': 'Nexus-MD/1.0 (WhatsApp bot)' },
        signal: AbortSignal.timeout(60_000),
    });
    const text = (await res.text()).trim();
    if (!res.ok || !/^https?:\/\//i.test(text)) {
        throw new Error(`0x0 (${res.status}): ${text.slice(0, 120)}`);
    }
    return text;
}
async function uploadTmpfiles(buffer, fileName) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buffer)]), fileName);
    const res = await fetch('https://tmpfiles.org/api/v1/upload', {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.text()).trim();
    let url;
    try {
        url = JSON.parse(body).data?.url;
    }
    catch {
        url = undefined;
    }
    if (!res.ok || !url)
        throw new Error(`tmpfiles (${res.status}): ${body.slice(0, 120)}`);
    return url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
}
const MEDIA_TYPES = new Set([
    'imageMessage',
    'videoMessage',
    'stickerMessage',
    'audioMessage',
    'documentMessage',
]);
const EXT = {
    imageMessage: 'jpg',
    videoMessage: 'mp4',
    stickerMessage: 'webp',
    audioMessage: 'mp3',
    documentMessage: 'bin',
};
command({ pattern: 'url', desc: 'Upload replied media and get a public link', usage: '<reply to media>', category: 'tools' }, async (m) => {
    const ownMedia = MEDIA_TYPES.has(m.type);
    const buffer = await m.downloadMedia(!ownMedia);
    if (!buffer)
        return m.usage();
    const fileName = `nexus.${EXT[m.type] ?? 'bin'}`;
    const hosts = [
        ['catbox', uploadCatbox],
        ['0x0', upload0x0],
        ['tmpfiles', uploadTmpfiles],
    ];
    const spinner = await Spinner.start(m, 'Uploading');
    const errors = [];
    for (const [name, upload] of hosts) {
        try {
            const link = await upload(buffer, fileName);
            await spinner.stop(`✅ Uploaded\n${link}`);
            return;
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            logger.warn({ host: name, reason }, 'upload host failed');
            errors.push(reason);
        }
    }
    logger.error({ errors }, 'all upload hosts failed');
    await spinner.stop(`❌ Upload failed on all hosts.\n_${errors[errors.length - 1] ?? 'unknown error'}_`);
});
