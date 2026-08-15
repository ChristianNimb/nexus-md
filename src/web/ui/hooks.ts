/** Small shared hooks. Deliberately dependency-free — see build.mjs. */
import { useEffect, useRef, useState } from 'react';

const reduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A single poll shared by every pending reveal.
 *
 * Content must never be able to get stuck invisible. IntersectionObserver
 * callbacks and scroll events are both delivered on the browser's schedule, and
 * a fast scroll — a trackpad flick, the End key, an anchor jump — can carry an
 * element past the viewport without either arriving. The element then sits at
 * opacity:0 forever and the page shows a blank gap where a section should be.
 *
 * A rect check on a timer cannot be missed. It runs ONLY while something is
 * still waiting to be revealed, over a handful of elements, and stops itself
 * entirely once the page has been read through — so the steady-state cost is
 * zero.
 */
const pending = new Set<() => void>();
let poll: ReturnType<typeof setInterval> | undefined;

function startPolling(): void {
  if (poll !== undefined) return;
  poll = setInterval(() => {
    for (const check of pending) check();
    if (pending.size === 0) {
      clearInterval(poll);
      poll = undefined;
    }
  }, 200);
}

/**
 * Reveal-on-scroll. Returns a ref to attach and whether it has entered view.
 * Fires once — re-animating on every scroll past is noise.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>(threshold = 0.15) {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduced() || typeof IntersectionObserver !== 'function') {
      setShown(true);
      return;
    }

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setShown(true);
      io.disconnect();
      pending.delete(check);
    };

    const check = () => {
      const r = el.getBoundingClientRect();
      if (r.top < window.innerHeight - 40 && r.bottom > 0) finish();
    };

    // The observer is the fast path — it reveals on the same frame the element
    // appears. The poll below is the guarantee that it happens at all.
    const io = new IntersectionObserver(([entry]) => entry.isIntersecting && finish(), {
      threshold,
      rootMargin: '0px 0px -60px 0px',
    });
    io.observe(el);

    check(); // anything already on screen at mount shows immediately
    if (!done) {
      pending.add(check);
      startPolling();
    }

    return () => {
      io.disconnect();
      pending.delete(check);
    };
  }, [threshold]);

  return [ref, shown] as const;
}

/**
 * Count up to `target` once visible. Eased so it decelerates into the final
 * number instead of stopping dead.
 */
export function useCounter(target: number, duration = 1400) {
  const [ref, shown] = useReveal<HTMLDivElement>(0.4);
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!shown) return;
    if (reduced()) {
      setValue(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setValue(Math.round(target * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [shown, target, duration]);

  return [ref, value] as const;
}

/**
 * Pointer-tracked tilt + a light that follows the cursor across the card.
 * Skipped entirely on coarse pointers — there is no hover on a phone, and the
 * listeners would just cost battery.
 */
export function useTilt<T extends HTMLElement = HTMLDivElement>(max = 4) {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduced() || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    // Pointer events fire far faster than the screen refreshes, and each custom
    // property write invalidates style for the subtree. Writing on every event
    // meant several style recalcs per frame — the jank you feel as "sticky"
    // hover. Coalesce to one write per frame instead.
    let queued = false;
    let px = 0.5;
    let py = 0.5;
    // The rect only changes on scroll/resize, so cache it rather than forcing a
    // layout on every pointer move.
    let rect: DOMRect | null = null;

    const paint = () => {
      queued = false;
      el.style.setProperty('--rx', `${((0.5 - py) * max).toFixed(2)}deg`);
      el.style.setProperty('--ry', `${((px - 0.5) * max).toFixed(2)}deg`);
      el.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`);
      el.style.setProperty('--my', `${(py * 100).toFixed(1)}%`);
    };

    const move = (e: PointerEvent) => {
      if (!rect) rect = el.getBoundingClientRect();
      px = (e.clientX - rect.left) / rect.width;
      py = (e.clientY - rect.top) / rect.height;
      if (!queued) {
        queued = true;
        requestAnimationFrame(paint);
      }
    };
    const enter = () => {
      rect = el.getBoundingClientRect();
      el.classList.add('tilting');
    };
    const leave = () => {
      rect = null;
      el.classList.remove('tilting');
      el.style.setProperty('--rx', '0deg');
      el.style.setProperty('--ry', '0deg');
    };
    const invalidate = () => {
      rect = null;
    };

    el.addEventListener('pointerenter', enter);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    window.addEventListener('scroll', invalidate, { passive: true });
    window.addEventListener('resize', invalidate, { passive: true });
    return () => {
      el.removeEventListener('pointerenter', enter);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
      window.removeEventListener('scroll', invalidate);
      window.removeEventListener('resize', invalidate);
    };
  }, [max]);

  return ref;
}

/**
 * Drives the reading-progress bar in the nav.
 *
 * Writes a custom property straight onto the element instead of going through
 * useState. Progress changes on every scroll frame, and a state update per frame
 * would re-render the whole landing page to move a 2px bar. The rAF coalescing
 * is the same shape as useTilt's, and for the same reason.
 */
export function useScrollProgress<T extends HTMLElement = HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let queued = false;
    const paint = () => {
      queued = false;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? Math.min(Math.max(window.scrollY / max, 0), 1) : 0;
      el.style.setProperty('--p', p.toFixed(4));
    };
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(paint);
    };

    paint();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return ref;
}

/**
 * Which section is currently being read, for the nav's active link.
 *
 * Unlike the progress bar this DOES use state — but it only changes when you
 * cross a section boundary, not on every frame, so a re-render is affordable.
 *
 * The band is a thin horizontal slice near the top of the viewport rather than
 * "is it visible": with several sections on screen at once on a tall display,
 * plain visibility lights up three links simultaneously.
 */
export function useScrollSpy(ids: string[]): string {
  const [active, setActive] = useState('');

  useEffect(() => {
    const pick = () => {
      let current = '';
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        // 30% down the viewport: the section you are actually reading, not the
        // one whose bottom edge happens to be peeking in.
        if (el.getBoundingClientRect().top <= window.innerHeight * 0.3) current = id;
      }
      setActive((prev) => (prev === current ? prev : current));
    };

    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        pick();
      });
    };

    pick();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [ids]);

  return active;
}

/** Have we scrolled past `y`? Used to condense the nav bar. */
export function useScrolled(y = 12) {
  const [past, setPast] = useState(false);
  useEffect(() => {
    const onScroll = () => setPast(window.scrollY > y);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [y]);
  return past;
}
