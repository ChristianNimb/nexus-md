import { useEffect, useState, type ReactNode } from 'react';
import Backdrop from './Backdrop';
import { api } from './apiBase';
import ChatDemo from './ChatDemo';
import Icon, { type IconName } from './Icons';
import { LogoMark } from './Logo';
import { useCounter, useReveal, useScrollProgress, useScrollSpy, useScrolled, useTilt } from './hooks';

/** Wraps children in a scroll-triggered fade-and-rise. */
function Reveal({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  const [ref, shown] = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} className={`reveal${shown ? ' in' : ''} ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

/** Section heading block. `eyebrow` is a quiet label, not a green pill. */
function SectionHead({ eyebrow, title, children }: { eyebrow: string; title: ReactNode; children?: ReactNode }) {
  return (
    <Reveal>
      <div className="section-head">
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
        {children && <p>{children}</p>}
      </div>
    </Reveal>
  );
}

function Card({ icon, title, children, delay = 0 }: { icon: IconName; title: string; children: ReactNode; delay?: number }) {
  const tilt = useTilt<HTMLDivElement>();
  return (
    <Reveal delay={delay}>
      <div className="card tilt" ref={tilt}>
        <div className="ico"><Icon name={icon} /></div>
        <h3>{title}</h3>
        <p>{children}</p>
      </div>
    </Reveal>
  );
}

function Stat({ value, suffix, label, delay }: { value: number; suffix?: string; label: string; delay: number }) {
  const [ref, n] = useCounter(value);
  return (
    <div ref={ref} className="stat" style={{ transitionDelay: `${delay}ms` }}>
      <b>
        {n}
        {suffix}
      </b>
      <span>{label}</span>
    </div>
  );
}

/**
 * Where the managed hosting dashboard lives.
 *
 * Relative on purpose. In production the control plane serves this site at /
 * and the dashboard at /app, so nothing needs a domain baked into the bundle
 * and changing the domain needs no rebuild.
 *
 * Self-hosting the bot standalone serves this page too, where /app does not
 * exist. If that matters to you, set this to the platform's absolute URL —
 * https://your-domain/app — and rebuild.
 */
const HOSTING_URL = '/app';

const NAV_LINKS: [string, string][] = [
  ['#features', 'Features'],
  ['#commands', 'Commands'],
  ['#ai', 'AI stack'],
  ['#hosting', 'Hosting'],
  ['#setup', 'Setup'],
];

/** Module scope, not a literal in the render: useScrollSpy takes it as an effect
 *  dependency, and a fresh array every render would re-subscribe every render. */
const SPY_IDS = NAV_LINKS.map(([href]) => href.slice(1));

const COMMANDS: [IconName, string, string[]][] = [
  ['brain', 'Nexus', ['.nexus', '.ai', '.voice', '.tts', '.memory', '.forget', '.search', '.who', '.tz']],
  ['download', 'Downloader', ['.play', '.video', '.ytmp3', '.ytmp4', '.dl', '.autodl']],
  ['media', 'Media & fun', ['.sticker', '.take', '.imagine', '.logo', '.nobg', '.fancy', '.photo']],
  ['shield', 'Group & moderation', ['.antilink', '.antibot', '.antidelete', '.warn', '.welcome', '.tagall', '.tagonline', '.kick']],
  ['tools', 'Tools & system', ['.menu', '.alive', '.ping', '.schedule', '.birthday', '.notes', '.seen', '.code', '.setprefix']],
];

/** The failover ladder. The active tier cycles, so the "drops to the next
 *  automatically" claim is shown rather than asserted. */
function FailoverFlow() {
  const [active, setActive] = useState(0);
  const [ref, shown] = useReveal<HTMLDivElement>(0.3);

  useEffect(() => {
    if (!shown) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t = setInterval(() => setActive((a) => (a + 1) % 3), 2600);
    return () => clearInterval(t);
  }, [shown]);

  const tiers = [
    { tier: 'Tier 1 · local', title: 'Ollama on your box', body: 'Qwen3 for chat, Qwen2.5-VL for vision, on your own hardware. No rate limits, no per-token cost, nothing leaving the house.' },
    { tier: 'Tier 2 · fallback', title: 'Groq, free tier', body: "Llama 3.3 70B and Whisper take over the moment the GPU box is asleep. Same conversation, same memory, no restart." },
    { tier: 'Tier 3 · voice', title: 'Piper → Edge → local TTS', body: 'Offline Piper is the floor, so voice never fully breaks. Edge Neural adds range; an expressive local server handles described tones.' },
  ];

  return (
    <div ref={ref}>
      {/* The rail above the cards. The section claims Nexus "drops to the next
          the moment one is unreachable"; the hand-off travelling along the track
          is that sentence, drawn. Each segment lights as the tier it leads to
          takes over, so the motion is the claim rather than an ornament. */}
      <div className="flow-rail" aria-hidden="true">
        {tiers.map((t, i) => (
          <span key={t.tier} className={`rail-cell${active > i ? ' lit' : ''}`}>
            <i className={`rail-dot${active === i ? ' hot' : active > i ? ' done' : ''}`} />
          </span>
        ))}
      </div>

      <div className="flow">
        {tiers.map((t, i) => (
          <div key={t.tier} className={`card flow-card${active === i ? ' hot' : ''}`}>
            <div className="tier">
              <span className="tier-dot" />
              {t.tier}
            </div>
            <h3>{t.title}</h3>
            <p>{t.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

const STEPS = [
  {
    h: 'Install Docker and grab a free key',
    p: 'Docker Desktop, then a free key from console.groq.com. That is the only account you need, and only for stage one.',
  },
  {
    h: 'Configure and start',
    p: 'Copy .env.example to .env, paste your key, set a panel password, and bring it up.',
    code: '# .env\nNEXUS_API_KEY=gsk_your_key_here\nNEXUS_WEB_PASSWORD=something-only-you-know\n\n# then\ndocker compose up -d --build',
  },
  {
    h: 'Link your phone in the browser',
    p: 'Open the panel, sign in, then scan the QR on screen or enter your number for an 8-character pairing code.',
    code: 'http://localhost:3000/link',
  },
  {
    h: 'Move to local AI, when you want to',
    p: 'Install Ollama, pull two models, point the primary endpoint at it. Groq stays configured as the fallback, so nothing breaks when the GPU box sleeps.',
  },
];

interface Health {
  bot: string;
  online: boolean;
  panelEnabled: boolean;
}

export default function Landing() {
  const [health, setHealth] = useState<Health | null>(null);
  /** Whether the health probe has finished, however it finished. */
  const [probed, setProbed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const scrolled = useScrolled();
  const progressRef = useScrollProgress<HTMLSpanElement>();
  const activeSection = useScrollSpy(SPY_IDS);

  useEffect(() => {
    fetch(api('/api/health'))
      .then((r) => r.json())
      // Only a payload that actually reports a link state can be shown as one.
      // Anything else — notably the hosting platform's own /api/health, which is
      // a perfectly valid response from a server that is not a bot — has no
      // `online` field, and reading `undefined` as "not linked" made a linked
      // bot advertise itself as unlinked on its own front page.
      .then((d: Partial<Health>) => setHealth(typeof d?.online === 'boolean' ? (d as Health) : null))
      .catch(() => setHealth(null))
      .finally(() => setProbed(true));
  }, []);

  // Escape closes the mobile menu, and so does growing the window past the
  // breakpoint — otherwise the panel stays open behind a nav that is visible
  // again, which looks broken.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    const mq = matchMedia('(min-width: 781px)');
    const onWide = () => mq.matches && setMenuOpen(false);
    addEventListener('keydown', onKey);
    mq.addEventListener('change', onWide);
    return () => {
      removeEventListener('keydown', onKey);
      mq.removeEventListener('change', onWide);
    };
  }, [menuOpen]);

  const bot = health?.bot ?? 'Nexus-MD';

  return (
    <>
      <Backdrop />

      <header className={`nav${scrolled || menuOpen ? ' solid' : ''}`}>
        <div className="wrap nav-bar">
          <a className="brand" href="/">
            <LogoMark size={30} className="mark" animated />
            <span>Nexus<span className="dim">-MD</span></span>
          </a>

          <nav className="nav-links">
            {NAV_LINKS.map(([href, label]) => (
              <a key={href} href={href} className={activeSection === href.slice(1) ? 'active' : undefined}>
                {label}
              </a>
            ))}
          </nav>

          <a className="btn btn-primary btn-sm nav-cta" href="/link">
            Link device
          </a>

          <button
            className={`nav-toggle${menuOpen ? ' open' : ''}`}
            type="button"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <span />
            <span />
          </button>

          <span className="nav-progress" ref={progressRef} aria-hidden="true" />
        </div>

        <div className={`nav-panel${menuOpen ? ' open' : ''}`}>
          <div className="wrap">
            {NAV_LINKS.map(([href, label]) => (
              <a key={href} href={href} onClick={() => setMenuOpen(false)}>
                {label}
              </a>
            ))}
            <a className="btn btn-primary full" href="/link">
              Link device
            </a>
          </div>
        </div>
      </header>

      <section className="hero">
        <div className="wrap hero-grid">
          <div className="hero-copy">
            {/*
              Three states, not two. The pill is only meaningful when something
              answered for a BOT; on the hosting platform's own front page there
              is no bot to report on, and a permanent "checking status…" reads as
              a page that never finished loading. Once the probe has come back
              empty, say nothing rather than something vague.
            */}
            {(health || !probed) && (
              <div className="status-pill">
                <span className={`dot ${health?.online ? 'live' : health ? 'warn' : ''}`} />
                {health ? (health.online ? `${bot} is online and linked` : `${bot} is running but not linked yet`) : 'checking status…'}
              </div>
            )}

            <h1>
              <span className="l1">The WhatsApp bot</span>
              <span className="l2 accent">that actually thinks.</span>
            </h1>

            <p className="lead">
              A TypeScript bot framework built on Baileys, with a real assistant that runs on{' '}
              <strong>your own GPU</strong> and fails over to the cloud automatically. Voice notes it can hear and
              answer in its own voice. Downloads, moderation, scheduling, stickers.
            </p>

            <div className="cta">
              <a className="btn btn-primary" href="/link">
                <Icon name="qr" size={17} />
                Link your device
              </a>
              <a className="btn btn-ghost" href="#setup">
                Read the setup guide
              </a>
            </div>

            <p className="hint">Scan a QR in your browser or type an 8-character pairing code. No terminal logs.</p>
          </div>

          <div className="hero-demo">
            <ChatDemo />
          </div>
        </div>
      </section>

      <section className="tight">
        <div className="wrap">
          <Reveal>
            <div className="stats">
              <Stat value={45} suffix="+" label="Plugins" delay={0} />
              <Stat value={100} suffix="%" label="TypeScript" delay={80} />
              <Stat value={0} label="API keys required" delay={160} />
              <Stat value={2} label="Ways to link" delay={240} />
            </div>
          </Reveal>
        </div>
      </section>

      <section id="features">
        <div className="wrap">
          <SectionHead eyebrow="What it does" title="Everything, without the bloat.">
            Each capability is a self-contained plugin that registers its own commands on import. Drop a file in{' '}
            <code>src/plugins</code> and it is live on the next restart.
          </SectionHead>

          <div className="grid g3">
            <Card icon="brain" title="Nexus, the assistant" delay={0}>
              Conversational AI with persistent memory, timezone awareness and live web search. It can run the bot's
              own commands for you. Ask it to download something and it just does it.
            </Card>
            <Card icon="wave" title="A voice, not a robot" delay={70}>
              Hears voice notes through Whisper and answers with neural speech. Piper runs offline and free; a local
              expressive server unlocks "soft, whispering, romantic" on request.
            </Card>
            <Card icon="download" title="Downloads that work" delay={140}>
              YouTube, TikTok, Instagram and X via yt-dlp and Cobalt, with several fallback routes. Paste a link and
              autodl catches it without a command.
            </Card>
            <Card icon="shield" title="Group moderation" delay={0}>
              Antilink, antibot, antidelete, warnings, welcome and goodbye cards, member tools and join-request
              approvals, with admin checks enforced at dispatch.
            </Card>
            <Card icon="eye" title="It can see" delay={70}>
              Reply to a photo and ask what is in it. Reverse image search, OCR, document reading, background removal
              and image generation are one command away.
            </Card>
            <Card icon="clock" title="Runs on schedule" delay={140}>
              Cron-backed scheduled messages, birthday reminders, presence tracking and auto-status viewing. All
              armed the moment the socket connects.
            </Card>
          </div>
        </div>
      </section>

      <section id="commands" className="band">
        <div className="wrap">
          <SectionHead eyebrow="The menu" title="One prefix. Everything under it.">
            Owner-only commands stay hidden from the public menu. Change the prefix at runtime with{' '}
            <code>.setprefix</code>. No restart, the regexes recompile live.
          </SectionHead>

          {/* Each group is a bordered card so an uneven number of commands wraps
              INSIDE its own box instead of leaving ragged holes across the page.
              The last group spans the leftover columns for the same reason. */}
          <div className="cmd-groups">
            {COMMANDS.map(([icon, name, list], gi) => (
              <Reveal key={name} delay={gi * 60} className="cmd-cell">
                <div className="cmd-group">
                  <p className="cat-title">
                    <Icon name={icon} size={15} /> {name}
                  </p>
                  <div className="cmds">
                    {list.map((c, i) => (
                      <span className="chip" key={c} style={{ transitionDelay: `${i * 26}ms` }}>
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section id="ai">
        <div className="wrap">
          <SectionHead
            eyebrow="Local first"
            title={
              <>
                Your GPU when it's on.
                <br />
                The cloud when it isn't.
              </>
            }
          >
            Nexus tries each tier in order and drops to the next the moment one is unreachable, mid conversation,
            without a restart, without you noticing.
          </SectionHead>

          <FailoverFlow />

          <Reveal delay={120}>
            <div className="card wide">
              <h3>Search without a key</h3>
              <p>
                DuckDuckGo is the default engine. No signup, no key, no quota. Point <code>NEXUS_SEARCH_ENGINE</code>{' '}
                at Tavily or Brave for higher-quality results, or at Groq's compound model for built-in live search.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Presented as a fork, not a funnel. Self-hosting is the honest default
          for a project you can read the source of, so it is stated first and in
          full — the hosted option earns its place by removing work, not by
          hiding the alternative. */}
      <section id="hosting">
        <div className="wrap">
          <SectionHead eyebrow="Two ways to run it" title="Run it yourself, or let it be run for you.">
            Same bot, same plugins, same commands. The only difference is who keeps the machine up.
          </SectionHead>

          <div className="grid g2">
            <Reveal>
              <div className="card choice">
                <div className="ico"><Icon name="terminal" /></div>
                <h3>Self-host</h3>
                <p className="choice-price">Free · your hardware</p>
                <ul className="ticks">
                  <li>Full control, nothing leaves your machine</li>
                  <li>Point it at your own GPU for local AI</li>
                  <li>Ten minutes with Docker</li>
                  <li>You handle uptime, updates and backups</li>
                </ul>
                <a className="btn btn-ghost full" href="#setup">Read the setup guide</a>
              </div>
            </Reveal>

            <Reveal delay={80}>
              <div className="card choice featured">
                <span className="ribbon">Managed</span>
                <div className="ico"><Icon name="qr" /></div>
                <h3>Nexus Hosting</h3>
                <p className="choice-price">Free tier · no card to start</p>
                <ul className="ticks">
                  <li>Link your phone in the browser, no terminal</li>
                  <li>Live logs, restarts and resource limits</li>
                  <li>Runs whether your computer is on or not</li>
                  <li>Run several bots from one dashboard</li>
                </ul>
                {/* Same origin now, so it navigates in place. A new tab is for
                    leaving a site, not for moving within one. */}
                <a className="btn btn-primary full" href={HOSTING_URL}>
                  Deploy on Nexus Hosting
                </a>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* Heading on the left, steps on the right. A full-width heading over a
          two-column step grid left one column short and the other tall — and a
          wide empty gutter beside the heading either way. */}
      <section id="setup" className="band">
        <div className="wrap setup-grid">
          <div className="setup-aside">
            <SectionHead eyebrow="Get running" title="Working bot in ten minutes.">
              Set it up in stages. After each one you have a bot that runs. Only move on once the current stage works.
            </SectionHead>
            <Reveal delay={100}>
              <a className="btn btn-primary" href="/link">
                Open the linking panel
              </a>
            </Reveal>
          </div>

          <ol className="steps">
            {STEPS.map((s, i) => (
              <Reveal key={s.h} delay={i * 70}>
                <li className="step">
                  <div className="n">{i + 1}</div>
                  <div className="step-body">
                    <h3>{s.h}</h3>
                    <p>{s.p}</p>
                    {s.code && <pre className="code">{s.code}</pre>}
                  </div>
                </li>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      <footer>
        <div className="wrap">
          <span>Nexus-MD, MIT licensed. Built with Baileys and TypeScript.</span>
          <span>
            <a href="/link">Link device</a> · <a href="#setup">Setup</a> · <a href="#features">Features</a>
          </span>
        </div>
      </footer>
    </>
  );
}
