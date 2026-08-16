/**
 * The linking panel. Same API contract as before — /api/health, /api/login,
 * /api/stream (SSE), /api/qr.svg, /api/pair — now driven by React state so the
 * QR swap, tab change and status transitions can animate.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Backdrop from './Backdrop';
import { api } from './apiBase';
import { LogoMark } from './Logo';

type Status = 'starting' | 'waiting' | 'connected' | 'closed' | 'logged-out';

interface Snapshot {
  status: Status;
  hasQr: boolean;
  qrExpiresAt: number | null;
  pairingCode: string | null;
  user: { name?: string; number?: string } | null;
  updatedAt: number;
}

const LABEL: Record<Status, string> = {
  starting: 'starting up, waiting for WhatsApp…',
  waiting: 'ready to link',
  connected: 'linked and online',
  closed: 'disconnected, reconnecting…',
  'logged-out': 'session was logged out, link again below',
};

const Brand = () => (
  <a className="brand panel-brand" href="/">
    <LogoMark size={32} className="mark" />
    <span>Nexus<span className="dim">-MD</span></span>
  </a>
);

/** Live countdown to the next QR rotation. Reassures that a stale-looking code
 *  is about to refresh itself, so nobody reloads the page mid-scan. */
function QrTimer({ expiresAt }: { expiresAt: number | null }) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [expiresAt]);
  if (!expiresAt) return null;
  return <span className="qr-timer">refreshes in {left}s</span>;
}

export default function LinkPanel() {
  const [view, setView] = useState<'loading' | 'login' | 'disabled' | 'link'>('loading');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [busy, setBusy] = useState(false);

  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [tab, setTab] = useState<'qr' | 'code'>('qr');
  const [number, setNumber] = useState('');
  const [code, setCode] = useState('');
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [qrVersion, setQrVersion] = useState(0);
  const [copied, setCopied] = useState(false);

  const streamRef = useRef<EventSource | null>(null);
  const pwRef = useRef<HTMLInputElement>(null);

  const connect = useCallback(() => {
    if (streamRef.current) return;
    const es = new EventSource(api('/api/stream'));
    streamRef.current = es;
    es.onmessage = (ev) => {
      try {
        const next = JSON.parse(ev.data) as Snapshot;
        setSnap(next);
        // Bust the image cache so a rotated QR actually refetches.
        if (next.hasQr) setQrVersion((v) => v + 1);
        if (next.pairingCode) setCode(next.pairingCode);
      } catch {
        /* ignore a malformed frame */
      }
    };
    es.onerror = () => setSnap((s) => (s ? { ...s, status: 'closed' } : s));
  }, []);

  useEffect(() => {
    fetch(api('/api/health'))
      .then((r) => r.json())
      .then((d: { panelEnabled: boolean; authed: boolean }) => {
        if (!d.panelEnabled) return setView('disabled');
        if (d.authed) {
          setView('link');
          connect();
        } else {
          setView('login');
        }
      })
      .catch(() => setView('login'));
    return () => streamRef.current?.close();
  }, [connect]);

  useEffect(() => {
    if (view === 'login') pwRef.current?.focus();
  }, [view]);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setLoginError('');
    try {
      const r = await fetch(api('/api/login'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const body = (await r.json()) as { error?: string };
      if (!r.ok) {
        setLoginError(body.error ?? 'Sign-in failed.');
        pwRef.current?.select();
        return;
      }
      setPassword('');
      setView('link');
      connect();
    } catch {
      setLoginError('Could not reach the bot.');
    } finally {
      setBusy(false);
    }
  }

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const r = await fetch(api('/api/pair'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ number }),
      });
      const body = (await r.json()) as { code?: string; error?: string };
      if (!r.ok) {
        setNote({ kind: 'err', text: body.error ?? 'Could not get a pairing code.' });
        return;
      }
      setCode(body.code ?? '');
      setNote({ kind: 'ok', text: 'Code issued. Enter it on your phone within about a minute.' });
    } catch {
      setNote({ kind: 'err', text: 'Could not reach the bot.' });
    } finally {
      setBusy(false);
    }
  }

  function copyCode() {
    navigator.clipboard?.writeText(code.replace('-', '')).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => undefined,
    );
  }

  const status = snap?.status ?? 'starting';
  const dotClass = status === 'connected' || status === 'waiting' ? 'live' : status === 'logged-out' ? 'bad' : 'warn';

  return (
    <>
      <Backdrop video />

      <main className="panel-page">
        <div className={`panel view-${view}`}>
          {view === 'loading' && (
            <div className="panel-loading">
              <div className="spinner" />
            </div>
          )}

          {view === 'disabled' && (
            <section className="fade-in">
              <Brand />
              <h1>Panel is off</h1>
              <p className="sub">
                No panel password is configured, so linking over the web is disabled. Otherwise anyone who reached
                this page could attach their own phone to your bot.
              </p>
              <div className="note">
                Add this to your <code>.env</code>, then run <code>docker compose restart nexus</code>:
                <pre className="code">NEXUS_WEB_PASSWORD=something-only-you-know</pre>
              </div>
              <a className="back" href="/">
                ← Back to the site
              </a>
            </section>
          )}

          {view === 'login' && (
            <section className="fade-in">
              <Brand />
              <h1>Owner sign-in</h1>
              <p className="sub">
                This panel can link a phone to your bot's WhatsApp account, so it is password protected.
              </p>
              <form onSubmit={login}>
                <div className="field">
                  <label htmlFor="pw">Panel password</label>
                  <input
                    id="pw"
                    ref={pwRef}
                    type="password"
                    autoComplete="current-password"
                    placeholder="NEXUS_WEB_PASSWORD"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                  <p className="hint">
                    Set in your <code>.env</code> as <code>NEXUS_WEB_PASSWORD</code>.
                  </p>
                </div>
                <button className="btn btn-primary full" type="submit" disabled={busy}>
                  {busy ? 'Checking…' : 'Unlock panel'}
                </button>
              </form>
              {loginError && <div className="note err shake">{loginError}</div>}
              <a className="back" href="/">
                ← Back to the site
              </a>
            </section>
          )}

          {view === 'link' && (
            <section className="fade-in">
              <Brand />
              <h1>Link your device</h1>
              <p className="sub">
                Open WhatsApp on your phone → <strong>Settings → Linked devices → Link a device</strong>.
              </p>

              <div className="state-row">
                <span className={`dot ${dotClass}`} />
                {LABEL[status]}
                <span className="right">{snap ? new Date(snap.updatedAt).toLocaleTimeString() : '—'}</span>
              </div>

              {status === 'connected' ? (
                <div className="fade-in">
                  <div className="linked-badge">
                    <div className="tick pop">✓</div>
                    <h3>Linked and online</h3>
                    <p>
                      {snap?.user?.name || snap?.user?.number
                        ? `Signed in as ${snap.user.name || snap.user.number}`
                        : 'Your bot is connected to WhatsApp.'}
                    </p>
                  </div>
                  <a className="btn btn-ghost full" href="/">
                    Back to the site
                  </a>
                </div>
              ) : (
                <>
                  <div className="tabs" role="tablist">
                    <button role="tab" aria-selected={tab === 'qr'} onClick={() => setTab('qr')} type="button">
                      Scan QR code
                    </button>
                    <button role="tab" aria-selected={tab === 'code'} onClick={() => setTab('code')} type="button">
                      Use pairing code
                    </button>
                    <span className={`tab-glider ${tab}`} aria-hidden="true" />
                  </div>

                  {tab === 'qr' ? (
                    <div className="pane fade-in">
                      <div className={`qr-stage${snap?.hasQr ? ' live' : ''}`}>
                        {snap?.hasQr ? (
                          <img key={qrVersion} src={api(`/api/qr.svg?v=${qrVersion}`)} alt="Scan this with WhatsApp" className="qr-img" />
                        ) : (
                          <div className="placeholder">
                            <div className="spinner" />
                            Waiting for a QR code from WhatsApp…
                          </div>
                        )}
                      </div>
                      <div className="qr-foot">
                        <ol className="help">
                          <li>WhatsApp → Settings → Linked devices</li>
                          <li>
                            Tap <strong>Link a device</strong>
                          </li>
                          <li>Point your phone at the code above</li>
                        </ol>
                        <QrTimer expiresAt={snap?.qrExpiresAt ?? null} />
                      </div>
                    </div>
                  ) : (
                    <div className="pane fade-in">
                      <form onSubmit={requestCode}>
                        <div className="field">
                          <label htmlFor="num">Your WhatsApp number</label>
                          <input
                            id="num"
                            type="tel"
                            inputMode="numeric"
                            placeholder="8613800138000"
                            autoComplete="tel"
                            value={number}
                            onChange={(e) => setNumber(e.target.value)}
                            required
                          />
                          <p className="hint">Country code first, digits only. No +, no spaces, no dashes.</p>
                        </div>
                        <button className="btn btn-primary full" type="submit" disabled={busy}>
                          {busy ? 'Asking WhatsApp…' : 'Get pairing code'}
                        </button>
                      </form>

                      {code && (
                        <div className="fade-in">
                          <button className="code-out" onClick={copyCode} type="button" title="Click to copy">
                            {code.split('').map((ch, i) => (
                              <span key={i} className="code-ch" style={{ animationDelay: `${i * 55}ms` }}>
                                {ch}
                              </span>
                            ))}
                          </button>
                          <p className="hint center">{copied ? 'Copied ✓' : 'Click the code to copy it'}</p>
                          <ol className="help">
                            <li>WhatsApp → Settings → Linked devices</li>
                            <li>
                              Tap <strong>Link a device</strong>, then <strong>Link with phone number instead</strong>
                            </li>
                            <li>Type the code above, it expires in about a minute</li>
                          </ol>
                        </div>
                      )}
                    </div>
                  )}

                  {note && <div className={`note ${note.kind} fade-in`}>{note.text}</div>}
                </>
              )}

              <a className="back" href="/">
                ← Back to the site
              </a>
            </section>
          )}
        </div>
      </main>
    </>
  );
}
