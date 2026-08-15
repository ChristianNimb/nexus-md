import { logger } from '../logger.js';

/**
 * Upload a buffer to a public host and return a direct URL. Tries several hosts
 * in order and returns the first that works — single hosts (catbox, 0x0) are
 * flaky/overloaded, so redundancy matters. No dependencies (Node fetch/FormData).
 */

const TIMEOUT = 30_000;

async function catbox(buffer: Buffer, name: string): Promise<string | undefined> {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', new Blob([new Uint8Array(buffer)]), name);
  const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: form, signal: AbortSignal.timeout(TIMEOUT) });
  const text = (await res.text()).trim();
  return res.ok && /^https?:\/\//i.test(text) ? text : undefined;
}

async function telegraph(buffer: Buffer, name: string): Promise<string | undefined> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: 'image/jpeg' }), name);
  const res = await fetch('https://telegra.ph/upload', { method: 'POST', body: form, signal: AbortSignal.timeout(TIMEOUT) });
  const data = (await res.json().catch(() => null)) as Array<{ src?: string }> | { error?: string } | null;
  const src = Array.isArray(data) ? data[0]?.src : undefined;
  return src ? `https://telegra.ph${src}` : undefined;
}

async function tmpfiles(buffer: Buffer, name: string): Promise<string | undefined> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)]), name);
  const res = await fetch('https://tmpfiles.org/api/v1/upload', { method: 'POST', body: form, signal: AbortSignal.timeout(TIMEOUT) });
  const data = (await res.json().catch(() => null)) as { data?: { url?: string } } | null;
  const url = data?.data?.url;
  return url ? url.replace('tmpfiles.org/', 'tmpfiles.org/dl/') : undefined;
}

async function zerox(buffer: Buffer, name: string): Promise<string | undefined> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)]), name);
  const res = await fetch('https://0x0.st', { method: 'POST', body: form, headers: { 'User-Agent': 'Nexus-MD/1.0 (WhatsApp bot)' }, signal: AbortSignal.timeout(TIMEOUT) });
  const text = (await res.text()).trim();
  return res.ok && /^https?:\/\//i.test(text) ? text : undefined;
}

/** Upload to the first host that succeeds. Throws only if all fail. */
export async function uploadImage(buffer: Buffer, fileName = 'file.jpg'): Promise<string> {
  const hosts: Array<[string, (b: Buffer, n: string) => Promise<string | undefined>]> = [
    ['catbox', catbox],
    ['telegraph', telegraph],
    ['tmpfiles', tmpfiles],
    ['0x0', zerox],
  ];
  for (const [name, fn] of hosts) {
    try {
      const url = await fn(buffer, fileName);
      if (url) return url;
      logger.warn({ host: name }, 'upload: host returned no url, trying next');
    } catch (err) {
      logger.warn({ err, host: name }, 'upload: host failed, trying next');
    }
  }
  throw new Error('all upload hosts failed');
}
