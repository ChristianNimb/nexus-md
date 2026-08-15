/**
 * The Nexus-MD web layer: a landing page, and a password-gated panel that shows
 * the live linking QR / issues a pairing code — so you never have to squint at
 * a QR in `docker compose logs` again.
 *
 * Built on node:http with Server-Sent Events. No Express, no websocket library,
 * no new dependencies at all: the QR has to travel one way (server → browser),
 * and SSE does exactly that over plain HTTP, including through the reverse
 * proxies people put in front of this.
 *
 * SECURITY — read before exposing this to the internet.
 * Whoever can see the QR can link THEIR phone as this bot's account. So every
 * route that reveals a QR, a pairing code, or session status requires the
 * password in NEXUS_WEB_PASSWORD. With no password set, the panel refuses to
 * serve anything at all and only the public landing page is reachable.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  getLinkState,
  onLinkChange,
  pairingAvailable,
  normalizeNumber,
  requestPairingCode,
  type LinkSnapshot,
} from './link-state.js';
import { qrToSvg } from './qr-svg.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Static assets live beside this module (src/web/public). After `npm run build`
 * the compiled JS sits in dist/web/ and tsc does NOT copy .html/.css, so fall
 * back to the source tree — that way both `npm start` (tsx) and `npm run serve`
 * (dist) serve the same pages.
 */
const PUBLIC_DIR = [join(__dirname, 'public'), resolve(process.cwd(), 'src', 'web', 'public')].find((d) =>
  existsSync(d),
);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const COOKIE = 'nexus_link';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

/** Signing key for the session cookie. Regenerated per process — a restart
 *  simply logs the browser out again, which is the safe direction to fail. */
const SIGNING_KEY = randomBytes(32);

// ---- auth ------------------------------------------------------------------

function sign(value: string): string {
  return createHmac('sha256', SIGNING_KEY).update(value).digest('base64url');
}

function issueToken(): string {
  const exp = String(Date.now() + SESSION_TTL_MS);
  return `${exp}.${sign(exp)}`;
}

function tokenValid(token: string | undefined): boolean {
  if (!token) return false;
  const [exp, mac] = token.split('.');
  if (!exp || !mac) return false;
  const expected = Buffer.from(sign(exp));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  return Number(exp) > Date.now();
}

/** Constant-time password check, so response timing can't leak the password. */
function passwordMatches(given: string): boolean {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(config.web.password);
  // Compare a digest of each side: timingSafeEqual needs equal lengths, and
  // hashing first stops the length itself from leaking.
  const ha = createHmac('sha256', SIGNING_KEY).update(a).digest();
  const hb = createHmac('sha256', SIGNING_KEY).update(b).digest();
  return timingSafeEqual(ha, hb);
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function isAuthed(req: IncomingMessage): boolean {
  return config.web.password !== '' && tokenValid(readCookie(req, COOKIE));
}

// ---- helpers ---------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/** Read a JSON request body, with a hard cap so a bad actor can't exhaust memory. */
async function readJson(req: IncomingMessage, limit = 4096): Promise<Record<string, unknown>> {
  return await new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        resolvePromise(text ? (JSON.parse(text) as Record<string, unknown>) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** What the panel is allowed to know. Deliberately omits the raw QR payload —
 *  the browser fetches it as an image from /api/qr.svg instead. */
function publicSnapshot(s: LinkSnapshot): Record<string, unknown> {
  return {
    status: s.status,
    hasQr: Boolean(s.qr),
    qrExpiresAt: s.qrExpiresAt ?? null,
    pairingCode: s.pairingCode ?? null,
    pairingNumber: s.pairingNumber ?? null,
    user: s.user ?? null,
    message: s.message ?? null,
    pairingAvailable: pairingAvailable(),
    updatedAt: s.updatedAt,
  };
}

function serveStatic(res: ServerResponse, urlPath: string): void {
  if (!PUBLIC_DIR) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('web assets missing (src/web/public not found)');
    return;
  }
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  const file = join(PUBLIC_DIR, rel);
  // Path-traversal guard: the resolved file must stay inside PUBLIC_DIR.
  if (!file.startsWith(PUBLIC_DIR + sep) && file !== PUBLIC_DIR) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(file).pipe(res);
}

// ---- routes ----------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // Clickjacking / sniffing hardening on every response.
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'same-origin');

  // --- public ---------------------------------------------------------------
  if (path === '/' || path === '/index.html') return serveStatic(res, 'index.html');

  if (path === '/link' || path === '/link.html') return serveStatic(res, 'link.html');

  /**
   * The landing page's "Deploy on Nexus Hosting" button points at `/app`, which
   * the hosting platform serves. This server does not — so without this the
   * button is a 404 on a page the bot itself is serving.
   *
   * With NEXUS_HOSTING_URL set, redirect there. Without it, say plainly that
   * this instance is self-hosted rather than returning a bare "not found" that
   * looks like the site is broken.
   */
  if (path === '/app' || path.startsWith('/app/')) {
    if (config.web.hostingUrl) {
      res.writeHead(302, { location: config.web.hostingUrl, 'cache-control': 'no-store' });
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Not hosted here</title>` +
        `<style>body{background:#05070a;color:#e9eef5;font:16px/1.6 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:2rem}` +
        `a{color:#4ade80}code{background:rgba(255,255,255,.06);padding:.15em .4em;border-radius:5px;font-size:.9em}</style>` +
        `<div><h1>This bot is self-hosted</h1>` +
        `<p>The managed hosting dashboard is not part of this instance.</p>` +
        `<p>Point <code>NEXUS_HOSTING_URL</code> at your platform to link them, or ` +
        `<a href="/link">link a device here</a> instead.</p></div>`,
    );
    return;
  }

  /** Tells the landing page whether the panel is usable, without revealing anything. */
  if (path === '/api/health') {
    return json(res, 200, {
      bot: config.botName,
      online: getLinkState().status === 'connected',
      panelEnabled: config.web.password !== '',
      authed: isAuthed(req),
    });
  }

  if (path === '/api/login' && method === 'POST') {
    if (config.web.password === '') {
      return json(res, 503, { error: 'The panel is disabled: set NEXUS_WEB_PASSWORD in .env and restart.' });
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      return json(res, 400, { error: 'Bad request.' });
    }
    if (!passwordMatches(String(body.password ?? ''))) {
      logger.warn({ ip: req.socket.remoteAddress }, 'web: failed login');
      // A deliberate small delay blunts brute-forcing over a LAN.
      await new Promise((r) => setTimeout(r, 600));
      return json(res, 401, { error: 'Wrong password.' });
    }
    const cookie = [
      `${COOKIE}=${issueToken()}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ].join('; ');
    return json(res, 200, { ok: true }, { 'set-cookie': cookie });
  }

  if (path === '/api/logout' && method === 'POST') {
    return json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Max-Age=0` });
  }

  // --- everything below needs the password ----------------------------------
  if (path.startsWith('/api/')) {
    if (!isAuthed(req)) return json(res, 401, { error: 'Not authorised.' });

    if (path === '/api/state') return json(res, 200, publicSnapshot(getLinkState()));

    if (path === '/api/qr.svg') {
      const { qr } = getLinkState();
      if (!qr) {
        res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        res.end('no qr right now');
        return;
      }
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      res.end(qrToSvg(qr));
      return;
    }

    /** Live push: the browser never polls, so a new QR shows up the instant
     *  WhatsApp rotates it (~every 20s). */
    if (path === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no', // stops nginx buffering the stream
      });
      const send = (s: LinkSnapshot) => res.write(`data: ${JSON.stringify(publicSnapshot(s))}\n\n`);
      send(getLinkState());
      const unsubscribe = onLinkChange(send);
      // Comment frames keep idle proxies from closing the connection.
      const beat = setInterval(() => res.write(': ping\n\n'), 25_000);
      const stop = () => {
        clearInterval(beat);
        unsubscribe();
      };
      req.on('close', stop);
      res.on('close', stop);
      return;
    }

    if (path === '/api/pair' && method === 'POST') {
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        return json(res, 400, { error: 'Bad request.' });
      }
      const number = normalizeNumber(String(body.number ?? ''));
      if (!number) {
        return json(res, 400, { error: 'Enter your full number with country code, digits only. Example: 8613800138000' });
      }
      try {
        const code = await requestPairingCode(number);
        logger.info({ number }, 'web: issued pairing code');
        return json(res, 200, { code, number });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not get a pairing code.';
        logger.warn({ err }, 'web: pairing request failed');
        return json(res, 409, { error: message });
      }
    }

    return json(res, 404, { error: 'Unknown endpoint.' });
  }

  // --- static ---------------------------------------------------------------
  return serveStatic(res, path);
}

let started = false;

/**
 * Boot the web server. Safe to call when disabled (it just returns), and safe
 * to call twice. Never throws into the bot's startup path — if the port is
 * taken, the bot keeps running and only the website is unavailable.
 */
export function startWebServer(): void {
  if (!config.web.enabled || started) return;
  started = true;

  if (!PUBLIC_DIR) {
    logger.error('web: src/web/public not found — website disabled');
    return;
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error({ err, url: req.url }, 'web: request failed');
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
    });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error({ port: config.web.port }, 'web: port already in use — website disabled');
    } else {
      logger.error({ err }, 'web: server error');
    }
  });

  server.listen(config.web.port, config.web.host, () => {
    logger.info({ host: config.web.host, port: config.web.port }, 'web: site up at /  •  linking panel at /link');
    if (config.web.password === '') {
      logger.warn('web: NEXUS_WEB_PASSWORD is not set — the linking panel is DISABLED (landing page still works)');
    }
  });
}
