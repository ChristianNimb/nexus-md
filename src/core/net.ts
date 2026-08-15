import axios from 'axios';
import type { AxiosRequestConfig } from 'axios';

/**
 * Small networking helper shared by all the internet-backed commands.
 *
 * Two jobs:
 *  1) route outbound requests through NEXUS_PROXY when set (so they work behind
 *     the Great Firewall, same proxy yt-dlp / the coder use), and
 *  2) give every feature a clean FALLBACK primitive (`firstOk`) so a single dead
 *     endpoint never breaks a command.
 */

function proxyCfg(): AxiosRequestConfig {
  const p =
    process.env.NEXUS_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!p) return {};
  try {
    const u = new URL(p);
    if (/^socks/i.test(u.protocol)) return {}; // axios can't do SOCKS natively
    return { proxy: { host: u.hostname, port: Number(u.port) || 80, protocol: u.protocol.replace(':', '') } };
  } catch {
    return {};
  }
}

/** GET JSON (or text) with the proxy applied and a sane timeout. Throws on error. */
export async function httpGet<T = unknown>(
  url: string,
  opts: { timeout?: number; headers?: Record<string, string>; text?: boolean } = {},
): Promise<T> {
  const res = await axios.get<T>(url, {
    timeout: opts.timeout ?? 12_000,
    headers: { 'user-agent': 'Nexus-MD/1.0 (+https://github.com)', accept: 'application/json,text/plain,*/*', ...(opts.headers ?? {}) },
    responseType: opts.text ? 'text' : 'json',
    ...proxyCfg(),
  });
  return res.data;
}

/** POST a body (JSON or FormData) with the proxy applied. Throws on error. */
export async function httpPost<T = unknown>(url: string, body: unknown, opts: { timeout?: number; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await axios.post<T>(url, body, {
    timeout: opts.timeout ?? 20_000,
    headers: { ...(opts.headers ?? {}) },
    ...proxyCfg(),
  });
  return res.data;
}

/** GET binary data (images etc.) with the proxy applied. Throws on error. */
export async function httpGetBuffer(url: string, opts: { timeout?: number; headers?: Record<string, string> } = {}): Promise<Buffer> {
  const res = await axios.get<ArrayBuffer>(url, {
    timeout: opts.timeout ?? 20_000,
    responseType: 'arraybuffer',
    maxContentLength: 20 * 1024 * 1024,
    headers: { 'user-agent': 'Nexus-MD/1.0', ...(opts.headers ?? {}) },
    ...proxyCfg(),
  });
  return Buffer.from(res.data);
}

/**
 * Try each async task in order; return the first that resolves to a non-empty
 * value. Errors and empty results fall through to the next task. Returns
 * undefined only if EVERY provider failed — so callers can show one clean
 * "couldn't reach it right now" message. This is the backbone of the rule that
 * every internet feature must have a fallback.
 */
export async function firstOk<T>(tasks: Array<() => Promise<T | undefined | null>>): Promise<T | undefined> {
  for (const task of tasks) {
    try {
      const out = await task();
      if (out !== undefined && out !== null && out !== '') return out;
    } catch {
      /* try the next provider */
    }
  }
  return undefined;
}
