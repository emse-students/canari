/**
 * The bench page: `window.__salonBench.open(options)` mounts `ChatArea` over a synthetic salon,
 * `window.__salonBench.openFromHub(options)` taps a salon row of a drawn communities hub; both answer
 * what the open cost, measured in the page itself. `run.mjs` drives them over CDP.
 */
import '../../src/app.css';
import { flushSync, mount, unmount } from 'svelte';
import ChatArea from '$lib/components/chat/ChatArea.svelte';
import HubScene from './HubScene.svelte';
import type { ChatMessage, Conversation } from '$lib/types';
import { seedUserDisplayName } from '$lib/utils/users/displayName';

// The `mixed` shape's senders are KNOWN, as on a phone whose directory has met them: an unknown one
// is looked up on the network (the real module's own fetch, which the stub cannot reach), and that
// lookup answered the bench's 404 with a refresh attempt and an engine warning per open.
for (const [id, name] of [
  ['alice', 'Alice Banc'],
  ['bob', 'Bob Banc'],
]) {
  seedUserDisplayName(id, name, name.split(' ')[0]);
}

/** What one open is asked to draw. */
interface OpenOptions {
  /** Messages in the salon. */
  rows: number;
  /** `own`: every row the reader's (the bench seed's shape); `mixed`: two other senders alternate. */
  shape: 'own' | 'mixed';
  /** How long to watch after the reveal, for the widen that follows it. */
  settleMs: number;
  /**
   * Calendar days the messages are spread over, ending today (1: a second apart, the bench
   * seed's shape). A salon read for months has a day separator per day, each one named.
   */
  days: number;
}

/** What one open cost, in ms from the gesture (`performance.now()` clock). */
interface OpenReading {
  /** The gesture's synchronous part (`mount` or the tap, then `flushSync`): the open's first task. */
  mountMs: number;
  /** The list committed as shown (`opacity-100`, with rows): the reveal, painted at that frame's end. */
  revealMs: number | null;
  /** Message rows in the DOM at that moment. */
  rowsAtReveal: number;
  /** Message rows once the widen has settled. */
  rowsSettled: number;
  /** Every long task (> 50 ms) from the gesture to the end of the settle, `[start, duration]`. */
  longTasks: [number, number][];
  /**
   * Every `error` event the window received meanwhile - "ResizeObserver loop completed with
   * undelivered notifications" is one, which neither `console.*` nor the engine's `Log` reports.
   */
  errors: string[];
}

const ROW_SELECTOR = '[id^="msg-"]';

/**
 * A salon of `rows` short one-line messages: a second apart (the bench seed's shape), or spread
 * evenly over the last `days` days.
 */
function salonOf(rows: number, shape: OpenOptions['shape'], days: number): Conversation {
  const DAY = 86_400_000;
  const step = days > 1 ? ((days - 1) * DAY) / Math.max(1, rows - 1) : 1000;
  const base = days > 1 ? Date.now() - (days - 1) * DAY : Date.UTC(2026, 10, 2, 8, 0, 0);
  const messages: ChatMessage[] = Array.from({ length: rows }, (_, i) => ({
    id: `m${String(i).padStart(4, '0')}`,
    senderId: shape === 'own' ? 'bench-reader' : i % 2 ? 'alice' : 'bob',
    content: `banc ouverture ${i}`,
    timestamp: new Date(base + i * step),
    isOwn: shape === 'own',
  }));
  return {
    id: 'channel_bench',
    name: 'general',
    contactName: 'channel_bench',
    messages,
    lifecycle: 'active',
    mlsStateHex: null,
  } as Conversation;
}

/** Long tasks seen since the page loaded, on the `performance.now()` clock. */
const longTasks: [number, number][] = [];
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) longTasks.push([e.startTime, e.duration]);
}).observe({ type: 'longtask', buffered: true });

/** Error events since the page loaded; `measure` keeps the ones of its own open. */
const errorEvents: string[] = [];
window.addEventListener('error', (e) => errorEvents.push(e.message));

/** One frame. */
const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

/**
 * Waits for the list to be committed as shown, and reads it there - NOT A FRAME LATER. `ChatArea`
 * flips the scroller to `opacity-100` inside an animation frame and starts its widen right after,
 * in tasks that run before the next frame, so a per-frame poll saw the widened rows a frame too
 * late. The observer runs in the microtask after the flush that flipped the class: the reveal is
 * committed then, and that frame paints it.
 */
function reveal(target: HTMLElement, t0: number): Promise<{ at: number | null; rows: number }> {
  const scroller = target.querySelector('.chat-messages-scroll');
  return new Promise((done) => {
    if (!scroller) return done({ at: null, rows: 0 });
    const isShown = () =>
      scroller.classList.contains('opacity-100') && !!scroller.querySelector(ROW_SELECTOR);
    const settle = () => {
      observer.disconnect();
      done({ at: performance.now() - t0, rows: target.querySelectorAll(ROW_SELECTOR).length });
    };
    const observer = new MutationObserver(() => {
      if (isShown()) settle();
    });
    observer.observe(scroller, { attributes: true, attributeFilter: ['class'] });
    if (isShown()) settle();
    setTimeout(() => {
      observer.disconnect();
      done({ at: null, rows: 0 });
    }, 10_000);
  });
}

/**
 * Times one open: `gesture` does it and returns the teardown. From its call to the reveal, then the
 * widen that follows, until `settleMs` after the reveal's frame.
 */
async function measure(
  target: HTMLElement,
  settleMs: number,
  gesture: () => () => Promise<void>
): Promise<OpenReading> {
  const t0 = performance.now();
  const errorsBefore = errorEvents.length;
  const teardown = gesture();
  flushSync();
  const mountMs = performance.now() - t0;
  const shown = await reveal(target, t0);
  // The reveal's frame is painted before anything else is read.
  await frame();
  await new Promise((r) => setTimeout(r, settleMs));
  const end = performance.now();
  const reading: OpenReading = {
    mountMs,
    revealMs: shown.at,
    rowsAtReveal: shown.rows,
    rowsSettled: target.querySelectorAll(ROW_SELECTOR).length,
    longTasks: longTasks
      .filter(([s, d]) => s + d >= t0 && s <= end)
      .map(([s, d]) => [Math.round(s - t0), Math.round(d)]),
    errors: errorEvents.slice(errorsBefore),
  };
  await teardown();
  target.replaceChildren();
  return reading;
}

/** `pane`: `ChatArea` mounted over the salon - the pane and its rows, nothing around them. */
function open(options: OpenOptions): Promise<OpenReading> {
  const target = document.getElementById('pane')!;
  return measure(target, options.settleMs, () => {
    const app = mount(ChatArea, {
      target,
      props: {
        conversation: salonOf(options.rows, options.shape, options.days),
        currentUserId: 'bench-reader',
        messageText: '',
        onMessageChange: () => {},
        bindDraftWriter: () => () => {},
        onSend: () => {},
        onInviteMembers: () => {},
      },
    });
    return () => unmount(app);
  });
}

/**
 * `hub`: the communities hub is drawn first (ten communities, nine salons each), then the tap on a
 * salon row is timed - the pane takes the salon, the sidebar hides, the listing refreshes.
 */
async function openFromHub(options: OpenOptions): Promise<OpenReading> {
  const target = document.getElementById('pane')!;
  const scene = mount(HubScene, {
    target,
    props: {
      communities: 10,
      salons: 9,
      salon: salonOf(options.rows, options.shape, options.days),
    },
  });
  flushSync();
  await frame();
  await new Promise((r) => setTimeout(r, 300));
  return measure(target, options.settleMs, () => {
    (scene as unknown as { open: () => void }).open();
    return () => unmount(scene);
  });
}

(window as unknown as { __salonBench: unknown }).__salonBench = { open, openFromHub };
