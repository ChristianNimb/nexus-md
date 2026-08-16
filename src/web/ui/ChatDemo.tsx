/**
 * The hero's WhatsApp simulation.
 *
 * Not a static mock: a scripted conversation plays on a loop. The text types
 * itself into the composer character by character, sends, Nexus shows the
 * typing indicator, then replies. Read receipts go blue when Nexus picks the
 * message up, the way they do on a real phone.
 *
 * The whole sequence is one async runner rather than a state machine, because
 * "type, pause, send, wait, reply" reads in source order that way. `cancelled`
 * is checked after every await so a React unmount (or Fast Refresh) stops it
 * cleanly instead of leaving timers writing into a dead component.
 */
import { useEffect, useRef, useState } from 'react';
import { LogoMark } from './Logo';

/**
 * A message being quoted, the way a WhatsApp reply shows what it answers.
 *
 * Used in both directions. Half of what makes a real bot thread readable is
 * that every answer is pinned to the thing it answers, and a demo of loose
 * bubbles in sequence quietly misses that.
 */
interface Quote {
  author: string;
  text: string;
  /** Green rail for your own words, brand rail for the bot's. */
  own?: boolean;
}

/**
 * The three states of the one message that runs the download.
 *
 * `ask` offers the qualities, `working` counts up, `done` names the file. All
 * three are the SAME bubble, edited in place. That is the thing worth showing:
 * a job that reports on itself without laying four messages down the thread.
 */
type JobPhase = 'ask' | 'working' | 'done';

type Step =
  | { kind: 'user'; text: string; quote?: Quote }
  | { kind: 'userVoice'; length: string }
  | { kind: 'bot'; text: string; think?: number; quote?: Quote }
  | { kind: 'botVoice'; length: string; think?: number }
  | { kind: 'botVideo'; title: string; length: string; think?: number; quote?: Quote }
  /** Posts the job bubble in its `ask` phase. */
  | { kind: 'job'; think?: number }
  /** Edits the job bubble already on screen. */
  | { kind: 'jobPhase'; phase: JobPhase; think?: number };

const DL_LINK = 'https://x.com/status/2089035734464245991';

/**
 * The question, kept where the answer can quote it.
 *
 * Written once so the quote block can never drift from the message it claims
 * to be quoting.
 */
const QUALITY_QUOTE: Quote = { author: 'Nexus', text: 'Link ready. Which quality?' };

const SCRIPT: Step[] = [
  { kind: 'user', text: "nexus, what's the weather in shanghai tomorrow?" },
  {
    kind: 'bot',
    text: 'Rain most of the morning, clearing around 4pm. 24°C and muggy. Take the umbrella you keep forgetting 🌧️',
    think: 1500,
  },

  // A whole job, start to finish, in one message that keeps editing itself.
  { kind: 'user', text: `.dl ${DL_LINK}` },
  { kind: 'job', think: 1300 },
  { kind: 'user', text: '1', quote: QUALITY_QUOTE },
  { kind: 'jobPhase', phase: 'working', think: 650 },
  { kind: 'jobPhase', phase: 'done' },
  {
    kind: 'botVideo',
    title: 'Match highlights, 16/08/2026',
    length: '0:12',
    think: 500,
    quote: { author: 'You', text: '1', own: true },
  },

  { kind: 'userVoice', length: '0:04' },
  { kind: 'bot', text: 'Heard you, answering out loud 🔊', think: 1400 },
  { kind: 'botVoice', length: '0:07', think: 900 },
];

interface Bubble {
  id: number;
  step: Step;
  time: string;
  read: boolean;
  /** Job bubbles only: which of the three faces they are currently showing. */
  phase?: JobPhase;
  /** Job bubbles only: 0 to 100, driven by the runner. */
  progress?: number;
  /** Job bubbles only: shows WhatsApp's "Edited" stamp once it has changed. */
  edited?: boolean;
}

const clock = () => {
  const d = new Date();
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'am' : 'pm'}`;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const prefersReduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** WhatsApp's double check. Blue once the recipient has read it. */
function Ticks({ read }: { read: boolean }) {
  return (
    <svg className={`ticks${read ? ' read' : ''}`} viewBox="0 0 18 12" width="16" height="11" aria-hidden="true">
      <path d="M1 6.4l2.6 2.6L9 3.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.4 6.4L10 9l5.4-5.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The block above a reply showing what it is answering. */
function QuoteBlock({ quote }: { quote: Quote }) {
  return (
    <div className={`wa-quote${quote.own ? ' own' : ''}`}>
      <strong>{quote.author}</strong>
      <span>{quote.text}</span>
    </div>
  );
}

/** A voice note: play button, waveform, duration. The bars animate while it "plays". */
function VoiceNote({ length, outgoing }: { length: string; outgoing: boolean }) {
  // A fixed pseudo-random set of bar heights, stable across renders, so the
  // waveform doesn't reshuffle itself on every state change.
  const bars = [7, 12, 18, 10, 22, 15, 26, 19, 11, 24, 16, 9, 20, 27, 13, 8, 17, 23, 12, 19, 10, 14, 21, 9];
  return (
    <div className="voice">
      <button className="voice-play" type="button" aria-label="Play voice message" tabIndex={-1}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
      </button>
      <div className="wave">
        {bars.map((h, i) => (
          <span key={i} style={{ height: `${h}px`, animationDelay: `${i * 0.055}s` }} className={outgoing ? 'out' : ''} />
        ))}
      </div>
      <span className="voice-len">{length}</span>
    </div>
  );
}

/**
 * The delivered video.
 *
 * The poster is drawn rather than shipped. A still from somebody else's
 * football clip is not ours to put on a marketing page, and the point of the
 * frame is that a file arrived, not what is in it.
 */
function VideoCard({ title, length }: { title: string; length: string }) {
  return (
    <div className="wa-video">
      <div className="wa-video-poster">
        <span className="wa-video-play">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
        </span>
        <span className="wa-video-len">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
            <path d="M17 10.5V7a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1v-3.5l4 4v-11l-4 4z" />
          </svg>
          {length}
        </span>
      </div>
      <span className="wa-video-title">{title}</span>
    </div>
  );
}

/** The qualities on offer, in the order the bot lists them. */
const QUALITIES = [
  { n: '1', tone: 'hd', label: 'HD', note: '1080p, best balance' },
  { n: '2', tone: 'sd', label: 'SD', note: 'smaller and faster' },
  { n: '3', tone: 'max', label: 'Max', note: 'highest available' },
];

/** One bubble, three faces. Which one is showing is the whole point. */
function JobCard({ phase, progress }: { phase: JobPhase; progress: number }) {
  if (phase === 'ask') {
    return (
      <div className="job">
        <p className="job-head">
          <b>Link ready.</b> Which quality?
        </p>
        <ul className="job-opts">
          {QUALITIES.map((q) => (
            <li key={q.n}>
              <span className="job-n">{q.n}</span>
              <i className={`job-dot ${q.tone}`} />
              <b>{q.label}</b>
              <span className="job-note">{q.note}</span>
            </li>
          ))}
        </ul>
        <p className="job-foot">Just reply 1, 2 or 3.</p>
      </div>
    );
  }

  if (phase === 'working') {
    return (
      <div className="job">
        <p className="job-head">Downloading (yt-dlp, HD)</p>
        <div className="job-bar">
          <span style={{ width: `${progress}%` }} />
        </div>
        <p className="job-foot mono">{progress}%</p>
      </div>
    );
  }

  return (
    <div className="job">
      <p className="job-head">
        <span className="job-tick">✓</span> <b>Downloaded</b>
      </p>
      <p className="job-file">Match highlights, 16/08/2026 · 10.1 MB</p>
    </div>
  );
}

export default function ChatDemo() {
  const [messages, setMessages] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState('');
  const [botTyping, setBotTyping] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);

  // Keep the newest message in view, exactly like the real app.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, botTyping]);

  useEffect(() => {
    // Reduced motion: show the finished conversation, skip the performance.
    if (prefersReduced()) {
      setMessages(
        SCRIPT.filter((step) => step.kind !== 'jobPhase').map((step, i) => ({
          id: i,
          step,
          time: clock(),
          read: true,
          // Straight to the job's end state, since there is no animation that
          // would otherwise arrive at it.
          ...(step.kind === 'job' ? { phase: 'done' as const, progress: 100, edited: true } : {}),
        })),
      );
      return;
    }

    let cancelled = false;
    const push = (step: Step, extra: Partial<Bubble> = {}) =>
      setMessages((prev) => [...prev, { id: idRef.current++, step, time: clock(), read: false, ...extra }]);
    const markRead = () => setMessages((prev) => prev.map((m) => ({ ...m, read: true })));

    /** Rewrites the job bubble wherever it has ended up in the thread. */
    const editJob = (patch: Partial<Bubble>) =>
      setMessages((prev) => prev.map((m) => (m.step.kind === 'job' ? { ...m, ...patch } : m)));

    (async () => {
      while (!cancelled) {
        setMessages([]);
        setDraft('');
        await sleep(450);

        for (const step of SCRIPT) {
          if (cancelled) return;

          if (step.kind === 'user') {
            /*
             * Type it out, with jitter. A constant interval reads as a progress
             * bar rather than as someone typing.
             *
             * Long strings get a faster rhythm: nobody hunts and pecks a URL
             * they pasted, and watching one appear at conversational speed is
             * several seconds of the demo spent on nothing.
             */
            const pace = step.text.length > 30 ? 13 : 26;
            for (let i = 1; i <= step.text.length; i++) {
              if (cancelled) return;
              setDraft(step.text.slice(0, i));
              await sleep(pace + Math.random() * 45);
            }
            await sleep(420);
            if (cancelled) return;
            setDraft('');
            push(step);
            await sleep(650);
          } else if (step.kind === 'userVoice') {
            // Holding the mic: the composer swaps to a recording state.
            setDraft(' recording');
            await sleep(1900);
            if (cancelled) return;
            setDraft('');
            push(step);
            await sleep(650);
          } else if (step.kind === 'job') {
            markRead();
            setBotTyping(true);
            await sleep(step.think ?? 1300);
            if (cancelled) return;
            setBotTyping(false);
            push(step, { phase: 'ask', progress: 0 });
            await sleep(900);
          } else if (step.kind === 'jobPhase') {
            markRead();
            await sleep(step.think ?? 400);
            if (cancelled) return;

            // `edited` from here on. The bubble is no longer what was first
            // sent, and WhatsApp says so; saying so is most of the point.
            editJob({ phase: step.phase, edited: true });

            if (step.phase === 'working') {
              // Not linear. A download that crawls, jumps, then finishes is what
              // a real one looks like, and a smooth sweep looks like a mockup.
              for (const pct of [4, 11, 23, 27, 45, 61, 68, 84, 97, 100]) {
                if (cancelled) return;
                editJob({ progress: pct });
                await sleep(150 + Math.random() * 190);
              }
            }
            await sleep(step.phase === 'done' ? 900 : 250);
          } else {
            markRead();
            setBotTyping(true);
            await sleep(step.think ?? 1300);
            if (cancelled) return;
            setBotTyping(false);
            push(step);
            await sleep(1000);
          }
        }

        markRead();
        await sleep(3000);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const recording = draft === ' recording';

  return (
    <div className="wa" role="img" aria-label="Animated demonstration of a WhatsApp conversation with the Nexus bot">
      <div className="wa-frame">
        {/* header */}
        <div className="wa-head">
          <svg className="wa-back" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
            <path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z" />
          </svg>
          <span className="wa-avatar">
            {/* A real profile picture, the same mark as everywhere else. It sits
                in the brand ink on the brand green, the way a photo would fill
                a WhatsApp avatar, rather than a letter standing in for one. */}
            <LogoMark size={24} />
          </span>
          <div className="wa-who">
            <strong>Nexus</strong>
            <span>{botTyping ? 'typing…' : 'online'}</span>
          </div>
          <div className="wa-actions" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor"><path d="M17 10.5V7a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1v-3.5l4 4v-11l-4 4z" /></svg>
            <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor"><path d="M20 15.5c-1.2 0-2.4-.2-3.6-.6a1 1 0 00-1 .2l-2.2 2.2a15.1 15.1 0 01-6.6-6.6l2.2-2.2a1 1 0 00.2-1c-.4-1.2-.6-2.4-.6-3.6a1 1 0 00-1-1H4a1 1 0 00-1 1A17 17 0 0020 21a1 1 0 001-1v-3.5a1 1 0 00-1-1z" /></svg>
            <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor"><circle cx="12" cy="5" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="12" cy="19" r="1.8" /></svg>
          </div>
        </div>

        {/* conversation */}
        <div className="wa-body" ref={bodyRef}>
          <div className="wa-day">TODAY</div>

          {messages.map(({ id, step, time, read, phase, progress, edited }) => {
            const outgoing = step.kind === 'user' || step.kind === 'userVoice';
            const isText = step.kind === 'user' || step.kind === 'bot';
            const quote = 'quote' in step ? step.quote : undefined;
            return (
              <div key={id} className={`wa-row ${outgoing ? 'out' : 'in'}`}>
                {/* `rich` bubbles (voice, media, jobs, anything quoting) put the
                    timestamp on its own line; plain text bubbles reserve room
                    for it on the last line with an inline spacer, which is how
                    WhatsApp itself keeps the clock off the words. */}
                <div className={`wa-bubble${isText && !quote ? '' : ' rich'}`}>
                  {quote && <QuoteBlock quote={quote} />}
                  {isText && (
                    <p>
                      {step.kind === 'user' ? step.text : step.kind === 'bot' ? step.text : ''}
                      {!quote && <span className={`meta-spacer${outgoing ? ' out' : ''}`} />}
                    </p>
                  )}
                  {step.kind === 'job' && <JobCard phase={phase ?? 'ask'} progress={progress ?? 0} />}
                  {step.kind === 'botVideo' && <VideoCard title={step.title} length={step.length} />}
                  {(step.kind === 'userVoice' || step.kind === 'botVoice') && (
                    <VoiceNote length={step.length} outgoing={outgoing} />
                  )}
                  <span className="wa-meta">
                    {edited && <span className="wa-edited">Edited</span>}
                    {time}
                    {outgoing && <Ticks read={read} />}
                  </span>
                </div>
              </div>
            );
          })}

          {botTyping && (
            <div className="wa-row in">
              <div className="wa-bubble wa-typing" aria-label="Nexus is typing">
                <i /><i /><i />
              </div>
            </div>
          )}
        </div>

        {/* composer */}
        <div className="wa-composer">
          <div className={`wa-input${recording ? ' rec' : ''}`}>
            {recording ? (
              <>
                <span className="rec-dot" />
                <span className="rec-text">Recording…</span>
                <span className="rec-wave"><i /><i /><i /><i /><i /><i /></span>
              </>
            ) : (
              <>
                <svg className="wa-emoji" viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden="true">
                  <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm-3.5 7A1.5 1.5 0 1110 10.5 1.5 1.5 0 018.5 9zm7 0A1.5 1.5 0 1117 10.5 1.5 1.5 0 0115.5 9zM12 18a5.5 5.5 0 01-5-3.2h10A5.5 5.5 0 0112 18z" />
                </svg>
                <span className="wa-draft">
                  {draft || <span className="wa-placeholder">Message</span>}
                  {draft && <span className="caret" />}
                </span>
                <svg className="wa-clip" viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden="true">
                  <path d="M16.5 6v11.5a4.5 4.5 0 01-9 0V5a3 3 0 016 0v11.5a1.5 1.5 0 01-3 0V6H9v10.5a3 3 0 006 0V5a4.5 4.5 0 00-9 0v12.5a6 6 0 0012 0V6h-1.5z" />
                </svg>
              </>
            )}
          </div>
          <button className={`wa-send${draft && !recording ? ' active' : ''}`} type="button" tabIndex={-1} aria-hidden="true">
            {draft && !recording ? (
              <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor"><path d="M12 15a3 3 0 003-3V6a3 3 0 00-6 0v6a3 3 0 003 3zm5-3a5 5 0 01-10 0H5a7 7 0 006 6.9V21h2v-2.1A7 7 0 0019 12h-2z" /></svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
