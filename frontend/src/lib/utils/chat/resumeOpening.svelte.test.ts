// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { flushSync } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { processAppLinks } from '$lib/mobile/appLinkRouter';
import { MOBILE_APP_PROTOCOL } from '$lib/mobile/appSiteAssociation';
import { listenForNativeNotificationTaps } from '$lib/mobile/notificationTapDrain';
import { notifNav } from '$lib/stores/notifNav.svelte';
import type { Conversation } from '$lib/types';
import { APP_FOREGROUND_EVENT } from '$lib/utils/appForeground';
import { isReadingConversationNow } from './arrivalRuntime';
import { resolveConversationKey } from './openConversationFromId';
import { routePageNotificationTap } from './pageNotificationTap';
import {
  createResumeReadGate,
  noteOpenNavigated,
  noteOpenRoutedNowhere,
  notePageTapsRoutable,
  PAGE_NOTIFICATION_OPENING,
} from './resumeOpening.svelte';

const goto = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('$app/navigation', () => ({ goto }));

/**
 * A RESUME FROM A NOTIFICATION FOR Y DOES NOT READ X, THE CONVERSATION LEFT OPEN (owner, 2026-11-02).
 *
 * The receipt effect's gate is the REAL one `MainChatPage` uses, `createResumeReadGate`, over a real
 * conversation map whose KEYS ARE NOT THE GROUP IDS (a DM's key is not its group id - the case a raw
 * comparison got wrong). The shells are driven through the event they dispatch (`canari:foreground`
 * with `detail.opening`); the router's outcomes through what it calls: `notifNav.navigate` (a
 * landing), `noteOpenNavigated` (`afterNavigate`), `noteOpenRoutedNowhere`, and the page's own tap
 * handler, `routePageNotificationTap`. Each router outcome before and after the edge.
 */

const X = { key: 'dm:xavier', group: 'grp-x' };
const Y = { key: 'dm:yann', group: 'grp-y' };
const link = (group: string) => `${MOBILE_APP_PROTOCOL}//chat/${group}`;

function announce(foreground: boolean, opening?: string) {
  (window as unknown as Record<string, unknown>).__canariForeground = foreground;
  window.dispatchEvent(
    new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground, opening: opening ?? null } })
  );
  flushSync();
}

/** A message landing in the open conversation: what re-runs the receipt effect. */
const tick = $state({ n: 0 });
function messageLands() {
  tick.n += 1;
  flushSync();
}

/** The receipt effect, gated as `MainChatPage` gates it; `marked` lists every conversation read. */
function mountReader(initial: string | null) {
  const conversations = new SvelteMap<string, Conversation>();
  for (const c of [X, Y]) conversations.set(c.key, { id: c.group } as Conversation);
  const selection = $state({ key: initial });
  const marked: string[] = [];
  let gate!: ReturnType<typeof createResumeReadGate>;
  const stop = $effect.root(() => {
    gate = createResumeReadGate(
      () => selection.key,
      (id) => resolveConversationKey(conversations, id)
    );
    $effect(() => {
      const selected = selection.key;
      if (!selected || !gate.current) return;
      if (gate.holds(selected)) return;
      void tick.n;
      marked.push(selected);
    });
  });
  flushSync();
  return {
    marked,
    gate,
    select(key: string | null) {
      selection.key = key;
      flushSync();
    },
    destroy() {
      stop();
      gate.destroy();
    },
  };
}

/** The landing effect's work: the target is selected (by its map key). */
function landingSelects(r: ReturnType<typeof mountReader>, c: { key: string }) {
  r.select(c.key);
}

let reader: ReturnType<typeof mountReader> | null = null;
function open(initial: string | null) {
  reader = mountReader(initial);
  return reader;
}

beforeEach(() => {
  announce(false);
  notifNav.clear();
  announce(true);
});

afterEach(() => {
  reader?.destroy();
  reader = null;
  delete (window as unknown as Record<string, unknown>).__canariForeground;
});

describe('a resume that opens a chat link for Y, with X left open (keys are not group ids)', () => {
  it('the edge first, the link reaching the router after (Android): X is not marked, Y is', () => {
    const r = open(X.key);
    expect(r.marked).toEqual([X.key]);
    announce(false);
    announce(true, link(Y.group));
    messageLands();
    expect(r.marked).toEqual([X.key]);
    notifNav.navigate(Y.group);
    flushSync();
    messageLands();
    expect(r.marked).toEqual([X.key]);
    landingSelects(r, Y);
    expect(r.marked).toEqual([X.key, Y.key]);
  });

  it('the landing published before the edge: X is not marked, Y is', () => {
    const r = open(X.key);
    announce(false);
    notifNav.navigate(Y.group);
    flushSync();
    announce(true, link(Y.group));
    messageLands();
    expect(r.marked).toEqual([X.key]);
    landingSelects(r, Y);
    expect(r.marked).toEqual([X.key, Y.key]);
  });

  it('Y already SELECTED before the edge: Y is read at the edge, nothing is held', () => {
    const r = open(X.key);
    announce(false);
    notifNav.navigate(Y.group);
    flushSync();
    landingSelects(r, Y); // the landing ran while the app was still in the background
    announce(true, link(Y.group));
    expect(r.marked).toEqual([X.key, Y.key]);
    expect(r.gate.holds(Y.key)).toBe(false);
  });

  it("a tap on X's OWN notification (a DM) reads X at once, landing pending or not", () => {
    const r = open(X.key);
    announce(false);
    announce(true, link(X.group));
    expect(r.marked).toEqual([X.key, X.key]);
    // The landing sees X already on screen and leaves its target pending: still read.
    notifNav.navigate(X.group);
    flushSync();
    messageLands();
    expect(r.marked).toEqual([X.key, X.key, X.key]);
  });

  it('a PLAIN resume (no notification) still marks X', () => {
    const r = open(X.key);
    announce(false);
    announce(true);
    expect(r.marked).toEqual([X.key, X.key]);
  });

  it('a landing published BEFORE the edge and then abandoned releases X', () => {
    const r = open(X.key);
    announce(false);
    notifNav.navigate(Y.group);
    flushSync();
    announce(true, link(Y.group));
    expect(r.marked).toEqual([X.key]);
    notifNav.clear();
    flushSync();
    expect(r.marked).toEqual([X.key, X.key]);
  });

  it("another conversation's landing replacing Y's keeps X held", () => {
    const r = open(X.key);
    announce(false);
    announce(true, link(Y.group));
    notifNav.navigate(Y.group);
    flushSync();
    notifNav.navigate('grp-zoe');
    flushSync();
    messageLands();
    expect(r.marked).toEqual([X.key]);
    // ...and released once no landing is pending.
    notifNav.clear();
    flushSync();
    expect(r.marked).toEqual([X.key, X.key]);
  });

  it('a landing that is abandoned releases X, which is what is on screen', () => {
    const r = open(X.key);
    announce(false);
    announce(true, link(Y.group));
    notifNav.navigate(Y.group);
    flushSync();
    expect(r.marked).toEqual([X.key]);
    notifNav.clear();
    flushSync();
    expect(r.marked).toEqual([X.key, X.key]);
  });

  it('the reader picking another conversation ends the hold, and coming back to X reads it', () => {
    const r = open(X.key);
    announce(false);
    announce(true, link(Y.group));
    r.select('dm:zoe');
    r.select(X.key);
    expect(r.marked).toEqual([X.key, 'dm:zoe', X.key]);
  });

  it('leaving again during the hold, then a plain resume, marks X', () => {
    const r = open(X.key);
    announce(false);
    announce(true, link(Y.group));
    announce(false);
    announce(true);
    expect(r.marked).toEqual([X.key, X.key]);
  });

  it('an arrival in X during the hold is not read on arrival', () => {
    window.history.replaceState(null, '', '/chat');
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    try {
      const r = open(X.key);
      expect(isReadingConversationNow(X.key, X.key)).toBe(true);
      announce(false);
      announce(true, link(Y.group));
      expect(isReadingConversationNow(X.key, X.key)).toBe(false);
      landingSelects(r, Y);
      expect(isReadingConversationNow(Y.key, Y.key)).toBe(true);
    } finally {
      focus.mockRestore();
    }
  });
});

describe('a resume that opens a link to anything else', () => {
  it('a page link holds X until it has navigated', () => {
    const r = open(X.key);
    announce(false);
    announce(true, `${MOBILE_APP_PROTOCOL}//post/p1`);
    messageLands();
    expect(r.marked).toEqual([X.key]);
    noteOpenNavigated();
    flushSync();
    expect(r.marked).toEqual([X.key, X.key]);
  });

  it('a page link that navigated BEFORE the edge holds nothing', () => {
    const r = open(X.key);
    announce(false);
    noteOpenNavigated();
    announce(true, `${MOBILE_APP_PROTOCOL}//post/p1`);
    expect(r.marked).toEqual([X.key, X.key]);
  });

  it('a link the router routes NOWHERE (an unclaimed open?url) releases X, after the edge', () => {
    const r = open(X.key);
    announce(false);
    announce(true, `${MOBILE_APP_PROTOCOL}//open?url=https%3A%2F%2Fexample.org`);
    expect(r.marked).toEqual([X.key]);
    noteOpenRoutedNowhere('an open link to no claimed page');
    flushSync();
    expect(r.marked).toEqual([X.key, X.key]);
  });

  it('... and holds nothing when it was routed nowhere BEFORE the edge', () => {
    const r = open(X.key);
    announce(false);
    noteOpenRoutedNowhere('an open link to no claimed page');
    announce(true, `${MOBILE_APP_PROTOCOL}//open?url=https%3A%2F%2Fexample.org`);
    expect(r.marked).toEqual([X.key, X.key]);
  });

  it('a second leave signal while already away is not a leave: the outcome before it still counts', () => {
    const r = open(X.key);
    announce(false);
    noteOpenRoutedNowhere('an open link to no claimed page');
    // A repeated `false` (a background page load, a repeated edge) must not re-snapshot: the
    // outcome above would then predate the baseline and the edge below would hold X for good.
    announce(false);
    announce(true, `${MOBILE_APP_PROTOCOL}//open?url=https%3A%2F%2Fexample.org`);
    expect(r.marked).toEqual([X.key, X.key]);
  });
});

describe('the REAL router and tap drain report a link that routes nowhere', () => {
  const unclaimed = `${MOBILE_APP_PROTOCOL}//open?url=https%3A%2F%2Fexample.org`;

  it('processAppLinks on an unclaimed open?url releases X (no hand-called outcome)', () => {
    const r = open(X.key);
    announce(false);
    announce(true, unclaimed);
    expect(r.marked).toEqual([X.key]);
    processAppLinks([unclaimed]);
    flushSync();
    expect(r.marked).toEqual([X.key, X.key]);
  });

  it('processAppLinks on a CLAIMED link whose navigation fails releases X', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    goto.mockRejectedValueOnce(new Error('navigation aborted'));
    const claimed = 'https://canari.emse.fr/posts/abc';
    try {
      const r = open(X.key);
      announce(false);
      announce(true, claimed);
      expect(r.marked).toEqual([X.key]);
      processAppLinks([claimed]);
      await vi.waitFor(() => {
        flushSync();
        expect(r.marked).toEqual([X.key, X.key]);
      });
    } finally {
      error.mockRestore();
    }
  });

  it('processAppLinks on a checkout return to no known page releases X', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unknown = `${MOBILE_APP_PROTOCOL}//payment/elsewhere`;
    try {
      const r = open(X.key);
      announce(false);
      announce(true, unknown);
      processAppLinks([unknown]);
      flushSync();
      expect(r.marked).toEqual([X.key, X.key]);
    } finally {
      warn.mockRestore();
    }
  });

  it('processAppLinks on a link that is not ours releases X', () => {
    const r = open(X.key);
    announce(false);
    announce(true, 'mailto:someone@example.org');
    processAppLinks(['mailto:someone@example.org']);
    flushSync();
    expect(r.marked).toEqual([X.key, X.key]);
  });

  it('the native tap drain, its record not JSON, releases X through its own wiring', async () => {
    const r = open(X.key);
    announce(false);
    announce(true, unclaimed);
    expect(r.marked).toEqual([X.key]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const opened: string[] = [];
    let taken!: () => void;
    const done = new Promise<void>((res) => (taken = res));
    const stop = listenForNativeNotificationTaps(
      (l) => opened.push(l),
      async () => {
        queueMicrotask(taken);
        return 'not json';
      },
      Promise.resolve()
    );
    try {
      await done;
      await Promise.resolve();
      flushSync();
      expect(opened).toEqual([]);
      expect(r.marked).toEqual([X.key, X.key]);
    } finally {
      stop();
      error.mockRestore();
    }
  });

  it('the native tap drain handing an unclaimed link to the real router releases X', async () => {
    const r = open(X.key);
    announce(false);
    announce(true, unclaimed);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let routed!: () => void;
    const done = new Promise<void>((res) => (routed = res));
    const stop = listenForNativeNotificationTaps(
      (l) => {
        processAppLinks([l]);
        routed();
      },
      async () => JSON.stringify({ deepLink: unclaimed }),
      Promise.resolve()
    );
    try {
      await done;
      flushSync();
      expect(r.marked).toEqual([X.key, X.key]);
    } finally {
      stop();
      warn.mockRestore();
    }
  });
});

describe('a tap on a notification the PAGE raised (the plugin, iOS), with X left open', () => {
  const posted = new Map([[7, Y.group]]);
  const tap = (id: number | null) =>
    routePageNotificationTap(
      id === null ? { notification: null } : { notification: { id } },
      posted,
      (t) => notifNav.navigate(t)
    );
  // The listener these taps come through is registered (`armPageTapListener` resolved); the page
  // that never registered one is `resumeOpening.pageTapListener.svelte.test.ts`.
  beforeEach(() => notePageTapsRoutable());

  it('its landing published after the edge: X is not marked, Y is', () => {
    const r = open(X.key);
    announce(false);
    announce(true, PAGE_NOTIFICATION_OPENING);
    messageLands();
    expect(r.marked).toEqual([X.key]);
    expect(tap(7)).toBe('landed');
    flushSync();
    messageLands();
    expect(r.marked).toEqual([X.key]);
    landingSelects(r, Y);
    expect(r.marked).toEqual([X.key, Y.key]);
  });

  it('its landing published BEFORE the edge: X is not marked, Y is', () => {
    const r = open(X.key);
    announce(false);
    tap(7);
    flushSync();
    announce(true, PAGE_NOTIFICATION_OPENING);
    messageLands();
    expect(r.marked).toEqual([X.key]);
    landingSelects(r, Y);
    expect(r.marked).toEqual([X.key, Y.key]);
  });

  it.each([
    ['no identity', null],
    ['a notification this session did not post', 99],
  ])('routed nowhere (%s) AFTER the edge: X is released', (_why, id) => {
    const r = open(X.key);
    announce(false);
    announce(true, PAGE_NOTIFICATION_OPENING);
    expect(r.marked).toEqual([X.key]);
    expect(tap(id)).not.toBe('landed');
    flushSync();
    expect(r.marked).toEqual([X.key, X.key]);
  });

  it.each([
    ['no identity', null],
    ['a notification this session did not post', 99],
  ])('routed nowhere (%s) BEFORE the edge: nothing is held', (_why, id) => {
    const r = open(X.key);
    announce(false);
    tap(id);
    announce(true, PAGE_NOTIFICATION_OPENING);
    expect(r.marked).toEqual([X.key, X.key]);
  });

  it('a page notification for X itself marks X once it lands', () => {
    const r = open(X.key);
    announce(false);
    announce(true, PAGE_NOTIFICATION_OPENING);
    routePageNotificationTap({ notification: { id: 3 } }, new Map([[3, X.group]]), (t) =>
      notifNav.navigate(t)
    );
    flushSync();
    expect(r.marked).toEqual([X.key, X.key]);
  });
});

describe('a cold start from a tap', () => {
  it.each([
    ['a chat link', link(Y.group)],
    ['a page notification', PAGE_NOTIFICATION_OPENING],
  ])('(%s) marks only Y: no conversation was open, so nothing is held', (_what, opening) => {
    announce(false); // the page loads in the background, a launch by the tap, nothing selected
    const r = open(null);
    announce(true, opening);
    notifNav.navigate(Y.group);
    flushSync();
    landingSelects(r, Y);
    messageLands();
    expect(new Set(r.marked)).toEqual(new Set([Y.key]));
  });
});

/**
 * THE KOTLIN HALF, which cannot run here: a source contract only. The page's half is the behaviour
 * above; the iOS half is pinned in `appForeground.contract.test.ts` on the iOS branch.
 */
describe('the Android shell', () => {
  const read = (file: string) =>
    readFileSync(`src-tauri/gen/android/app/src/main/java/fr/emse/canari/${file}`, 'utf8');

  it('sends the link onNewIntent took with the edge onResume dispatches', () => {
    const activity = read('MainActivity.kt');
    expect(activity).toMatch(
      /resumeOpening = if \(intent\.action == Intent\.ACTION_VIEW\) intent\.dataString else null/
    );
    expect(activity).toMatch(/pushForeground\(true, opening\)/);
    expect(activity).toMatch(/detail:\{foreground:\$foreground,opening:\$openingJs\}/);
  });

  it("builds the page's notifications natively, so their tap is a chat link to the activity", () => {
    const fms = read('CanariFirebaseMessagingService.kt');
    expect(fms).toContain('fun notifyMessageFromWebSocket(');
    expect(fms).toMatch(
      /action = Intent\.ACTION_VIEW\s+setData\(android\.net\.Uri\.parse\("fr\.emse\.canari:\/\/chat\/\$groupId"\)\)/
    );
  });
});
