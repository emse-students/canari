/**
 * The bench page: `ChatArea` mounted over a synthetic salon, the keyboard store initialised as the
 * app does, and `window.__kbBench` to drive the Android shell's announcement and read what it cost.
 */
import '../../src/app.css';
import { flushSync, mount } from 'svelte';
import ChatArea from '$lib/components/chat/ChatArea.svelte';
import { initKeyboardViewport } from '$lib/stores/keyboardViewport.svelte';
import type { ChatMessage, Conversation } from '$lib/types';
import { seedUserDisplayName } from '$lib/utils/users/displayName';

for (const [id, name] of [
  ['alice', 'Alice Banc'],
  ['bob', 'Bob Banc'],
]) {
  seedUserDisplayName(id, name, name.split(' ')[0]);
}

/** A salon of `rows` one-line messages over three days, two senders alternating. */
function salonOf(rows: number): Conversation {
  const DAY = 86_400_000;
  const step = (2 * DAY) / Math.max(1, rows - 1);
  const base = Date.now() - 2 * DAY;
  const messages: ChatMessage[] = Array.from({ length: rows }, (_, i) => ({
    id: `m${String(i).padStart(4, '0')}`,
    senderId: i % 2 ? 'alice' : 'bob',
    content: `banc clavier ${i}`,
    timestamp: new Date(base + i * step),
    isOwn: false,
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

const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

/** Mounts the salon and the keyboard store, and waits until the rows are shown. */
async function ready(rows: number): Promise<number> {
  const target = document.getElementById('pane')!;
  mount(ChatArea, {
    target,
    props: {
      conversation: salonOf(rows),
      currentUserId: 'bench-reader',
      messageText: '',
      onMessageChange: () => {},
      bindDraftWriter: () => () => {},
      onSend: () => {},
      onInviteMembers: () => {},
    },
  });
  flushSync();
  initKeyboardViewport();
  for (let i = 0; i < 600; i++) {
    const scroller = document.querySelector('.chat-messages-scroll');
    if (scroller?.classList.contains('opacity-100') && scroller.querySelector('[id^="msg-"]'))
      break;
    await frame();
  }
  await new Promise((r) => setTimeout(r, 1500));
  await frame();
  return document.querySelectorAll('*').length;
}

/** The median of a list of numbers. */
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * What one write costs in style and layout, forced right after it: the median of `n` alternating
 * writes, each from a clean document. A SHAPE (desktop V8, throttled), never a phone's number.
 */
function styleCost(n = 15): Record<string, number | string> {
  const root = document.documentElement;
  const scroller = document.querySelector<HTMLElement>('.chat-messages-scroll')!;
  const band = document.querySelector<HTMLElement>('[data-keyboard-ride="box"]')!;
  const footer = document.querySelector<HTMLElement>('.chat-composer-footer')!;
  const probe = scroller.lastElementChild as HTMLElement;
  const force = () => {
    void getComputedStyle(probe).color;
    void probe.offsetHeight;
  };
  const time = (fn: (i: number) => void) => {
    const r: number[] = [];
    for (let i = 0; i < n; i++) {
      force();
      const t = performance.now();
      fn(i);
      force();
      r.push(performance.now() - t);
    }
    return +median(r).toFixed(2);
  };
  try {
    CSS.registerProperty({
      name: '--zz-reg-inh',
      syntax: '<length>',
      inherits: true,
      initialValue: '0px',
    });
    CSS.registerProperty({
      name: '--zz-reg-noinh',
      syntax: '<length>',
      inherits: false,
      initialValue: '0px',
    });
    CSS.registerProperty({ name: '--zz-reg-any', syntax: '*', inherits: false });
  } catch {
    // Registered on an earlier call.
  }
  const px = (i: number) => `${i % 2 ? 357.98 : 0}px`;
  const out: Record<string, number | string> = {
    elements: document.querySelectorAll('*').length,
    scrollerSubtree: scroller.querySelectorAll('*').length,
    bandSubtree: band.querySelectorAll('*').length,
  };
  out.rootUnusedVar = time((i) => root.style.setProperty('--zz-unused', px(i)));
  out.rootLayoutInset = time((i) =>
    root.style.setProperty('--keyboard-layout-inset-bottom', px(i))
  );
  out.rootSameValue = time(() => root.style.setProperty('--keyboard-layout-inset-bottom', '0px'));
  out.rootRegisteredInherited = time((i) => root.style.setProperty('--zz-reg-inh', px(i)));
  out.rootRegisteredNotInherited = time((i) => root.style.setProperty('--zz-reg-noinh', px(i)));
  out.rootClassNoRule = time((i) => root.classList.toggle('zz-probe', i % 2 === 0));
  out.bodyUnusedVar = time((i) => document.body.style.setProperty('--zz-unused', px(i)));
  out.scrollerUnusedVar = time((i) => scroller.style.setProperty('--zz-unused', px(i)));
  out.scrollerRegisteredNotInherited = time((i) =>
    scroller.style.setProperty('--zz-reg-noinh', px(i))
  );
  out.scrollerUniversalNotInherited = time((i) =>
    scroller.style.setProperty('--zz-reg-any', px(i))
  );
  out.scrollerPaddingBottom = time((i) => scroller.style.setProperty('padding-bottom', px(i)));
  out.bandUnusedVar = time((i) => band.style.setProperty('--zz-unused', px(i)));
  out.bandLayoutInset = time((i) =>
    band.style.setProperty('--keyboard-layout-inset-bottom', px(i))
  );
  out.footerLayoutInset = time((i) =>
    footer.style.setProperty('--keyboard-layout-inset-bottom', px(i))
  );
  out.leafUnusedVar = time((i) => probe.style.setProperty('--zz-unused', px(i)));
  for (const el of [root, document.body, scroller, band, footer, probe]) {
    for (const p of [
      '--zz-unused',
      '--zz-reg-inh',
      '--zz-reg-noinh',
      '--zz-reg-any',
      'padding-bottom',
    ])
      el.style.removeProperty(p);
  }
  band.style.removeProperty('--keyboard-layout-inset-bottom');
  footer.style.removeProperty('--keyboard-layout-inset-bottom');
  root.style.setProperty('--keyboard-layout-inset-bottom', '0px');
  root.classList.remove('zz-probe');
  return out;
}

/** The Mi 9T's keyboard curve, as the shell samples it (24 points of a decelerating interpolator). */
const CURVE = Array.from({ length: 24 }, (_, i) => 1 - (1 - i / 23) ** 3);

/** What the riding pieces' LAYOUT says (offsets and scroll, which no transform changes). */
function layoutOfPieces(): number[] {
  const scroller = document.querySelector<HTMLElement>('.chat-messages-scroll')!;
  const footer = document.querySelector<HTMLElement>('.chat-composer-footer')!;
  const last = scroller.lastElementChild as HTMLElement;
  return [
    footer.offsetTop,
    footer.offsetHeight,
    scroller.scrollTop,
    parseFloat(getComputedStyle(scroller).paddingBottom),
    last.offsetTop,
  ];
}

/** One announcement, as the Android shell makes it, and what the page did with it. */
interface AnnouncementReading {
  /** Style mutations on `:root` made inside the announcement's own task. */
  rootWritesInTask: number;
  /** Riding pieces (`[data-keyboard-leaf]`) whose style the task wrote. */
  leafWritesInTask: number;
  /** Rendering updates (animation frames) between the announcement and the ride's start. */
  framesToRide: number | null;
  /** Rendering updates between the announcement and the root write. */
  framesAtRoot: number;
  /** Whether the root was written after the ride had started (the deferred write). */
  rootWrittenAfterRide: boolean;
  /** Which pieces the ride animates: the composer band, the thread's rows. */
  riding: { composer: boolean; rows: boolean };
  /** The pieces' layout right after the ride started, and right after the root write. */
  layoutAtRide: number[];
  layoutAfterRoot: number[];
}

/**
 * Announces a keyboard to `px` as the shell does and watches: which styles the announcement's task
 * wrote, how many frames the ride waited, and whether the root write that follows moved a piece.
 */
function announce(px: number): Promise<AnnouncementReading> {
  const root = document.documentElement;
  const take = (window as unknown as { canariImeTarget: (v: unknown) => boolean }).canariImeTarget;
  const observer = new MutationObserver(() => {});
  observer.observe(document.body.parentElement!, {
    attributes: true,
    attributeFilter: ['style'],
    subtree: true,
  });
  let frames = 0;
  let counting = true;
  const countFrames = () => {
    if (!counting) return;
    frames++;
    requestAnimationFrame(countFrames);
  };
  return new Promise((done) => {
    let framesToRide: number | null = null;
    let layoutAtRide: number[] = [];
    let rideStarted = false;
    let riding = { composer: false, rows: false };
    window.addEventListener(
      'canari:keyboard-ride',
      () => {
        framesToRide = frames;
        rideStarted = true;
        layoutAtRide = layoutOfPieces();
        const targets = new Set(
          document.getAnimations().map((x) => (x.effect as KeyframeEffect | null)?.target)
        );
        const band = document.querySelector('[data-keyboard-ride="box"]');
        const scroller = document.querySelector('.chat-messages-scroll');
        riding = {
          composer: targets.has(band),
          rows: Array.from(scroller?.children ?? []).some((row) => targets.has(row)),
        };
      },
      { once: true }
    );
    const rootWatch = new MutationObserver((records) => {
      if (!records.some((r) => r.target === root)) return;
      rootWatch.disconnect();
      counting = false;
      done({
        rootWritesInTask,
        leafWritesInTask,
        framesToRide,
        rootWrittenAfterRide: rideStarted,
        framesAtRoot: frames,
        riding,
        layoutAtRide,
        layoutAfterRoot: layoutOfPieces(),
      });
    });
    requestAnimationFrame(countFrames);
    take({ px, durationMs: 285, curve: CURVE });
    const inTask = observer.takeRecords();
    observer.disconnect();
    const rootWritesInTask = inTask.filter((r) => r.target === root).length;
    const leafWritesInTask = new Set(
      inTask.map((r) => r.target as Element).filter((el) => el.hasAttribute('data-keyboard-leaf'))
    ).size;
    rootWatch.observe(root, { attributes: true, attributeFilter: ['style'] });
  });
}

(window as unknown as { __kbBench: unknown }).__kbBench = { ready, styleCost, announce };
