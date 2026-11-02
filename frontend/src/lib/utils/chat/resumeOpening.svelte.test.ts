// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { flushSync } from 'svelte';
import { MOBILE_APP_PROTOCOL } from '$lib/mobile/appSiteAssociation';
import { chatTargetOfLink } from '$lib/mobile/chatLinkTarget';
import { notifNav } from '$lib/stores/notifNav.svelte';
import { APP_FOREGROUND_EVENT } from '$lib/utils/appForeground';
import { createAppForegroundState } from '$lib/utils/appForegroundState.svelte';
import {
  endResumeOpening,
  endResumeOpeningOnNavigation,
  endResumeOpeningUnrouted,
  PAGE_NOTIFICATION_OPENING,
  followResumeSelection,
  noteResumeOpening,
  resumeOpeningHolds,
} from './resumeOpening.svelte';

/**
 * A RESUME FROM A NOTIFICATION FOR Y DOES NOT READ X, THE CONVERSATION LEFT OPEN (owner, 2026-11-02).
 *
 * The receipt effect of `MainChatPage` is reproduced here with its real gate: the foreground state
 * built with the same hooks, `followResumeSelection` in a `pre` effect, then `resumeOpeningHolds`. The shells are
 * driven through the event they dispatch (`canari:foreground` with `detail.opening`), which is the
 * whole of what either platform tells the page - Android from `onResume` with the link `onNewIntent`
 * took, iOS from the resume with the link its notification delegate took. The landing is the real
 * `notifNav`, moved the way `hooks.client.ts` and the landing effect move it.
 */

const link = (id: string) => `${MOBILE_APP_PROTOCOL}//chat/${id}`;

function announce(foreground: boolean, opening?: string) {
  (window as unknown as Record<string, unknown>).__canariForeground = foreground;
  window.dispatchEvent(
    new CustomEvent(APP_FOREGROUND_EVENT, { detail: { foreground, opening: opening ?? null } })
  );
  flushSync();
}

/** The receipt effect's gate, as `MainChatPage` composes it; `marked` is every conversation read. */
function mountReader(initial: string | null) {
  const selection = $state({ key: initial });
  const marked: string[] = [];
  const foreground = createAppForegroundState({
    onResume: (opening) => noteResumeOpening(opening, selection.key),
    onLeave: endResumeOpening,
  });
  const stop = $effect.root(() => {
    $effect.pre(() => followResumeSelection(selection.key));
    $effect(() => {
      const selected = selection.key;
      if (!selected || !foreground.current) return;
      if (resumeOpeningHolds(selected)) return;
      // A message landing re-runs the real effect; `tick` stands for it here.
      void tick.n;
      marked.push(selected);
    });
  });
  flushSync();
  return {
    marked,
    select(key: string) {
      selection.key = key;
      flushSync();
    },
    destroy() {
      stop();
      foreground.destroy();
    },
  };
}

/** A message landing in the open conversation: what re-runs the effect while the app is in front. */
const tick = $state({ n: 0 });
function messageLands() {
  tick.n += 1;
  flushSync();
}

beforeEach(() => {
  announce(true);
  notifNav.clear();
  endResumeOpening();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__canariForeground;
});

describe('a resume that opens a notification for Y, with X left open', () => {
  it('Android order (the edge first, the link reaching the router after): X is not marked, Y is', () => {
    const r = mountReader('X');
    try {
      expect(r.marked).toEqual(['X']);
      announce(false);
      announce(true, link('Y'));
      messageLands(); // something lands in X while the landing is on its way
      expect(r.marked).toEqual(['X']);
      notifNav.navigate(chatTargetOfLink(link('Y'))!); // `hooks.client.ts` publishes the target
      flushSync();
      messageLands();
      expect(r.marked).toEqual(['X']);
      r.select('Y'); // the landing selects it
      expect(r.marked).toEqual(['X', 'Y']);
    } finally {
      r.destroy();
    }
  });

  it('iOS order (the tap reaching the router before the edge): X is not marked, Y is', () => {
    const r = mountReader('X');
    try {
      announce(false);
      notifNav.navigate('Y'); // the tap file drained before the resume's edge was dispatched
      flushSync();
      announce(true, link('Y'));
      messageLands();
      expect(r.marked).toEqual(['X']);
      r.select('Y');
      expect(r.marked).toEqual(['X', 'Y']);
    } finally {
      r.destroy();
    }
  });

  it('a PLAIN resume (no notification) still marks X', () => {
    const r = mountReader('X');
    try {
      announce(false);
      announce(true);
      expect(r.marked).toEqual(['X', 'X']);
    } finally {
      r.destroy();
    }
  });

  it('a tap on a notification for X itself marks X', () => {
    const r = mountReader('X');
    try {
      announce(false);
      announce(true, link('X'));
      expect(r.marked).toEqual(['X', 'X']);
    } finally {
      r.destroy();
    }
  });

  it('a landing that is abandoned (Y unknown) releases X, which is what is on screen', () => {
    const r = mountReader('X');
    try {
      announce(false);
      announce(true, link('Y'));
      notifNav.navigate('Y');
      flushSync();
      expect(r.marked).toEqual(['X']);
      notifNav.clear();
      flushSync();
      expect(r.marked).toEqual(['X', 'X']);
    } finally {
      r.destroy();
    }
  });

  it('a link to a page holds X until it has navigated', () => {
    const r = mountReader('X');
    try {
      announce(false);
      announce(true, `${MOBILE_APP_PROTOCOL}//post/p1`);
      messageLands();
      expect(r.marked).toEqual(['X']);
      endResumeOpeningOnNavigation();
      flushSync();
      expect(r.marked).toEqual(['X', 'X']);
    } finally {
      r.destroy();
    }
  });

  it('the reader picking another conversation ends the hold, and coming back to X reads it', () => {
    const r = mountReader('X');
    try {
      announce(false);
      announce(true, link('Y'));
      r.select('Z');
      r.select('X');
      expect(r.marked).toEqual(['X', 'Z', 'X']);
    } finally {
      r.destroy();
    }
  });

  it('leaving again during the hold, then a plain resume, marks X', () => {
    const r = mountReader('X');
    try {
      announce(false);
      announce(true, link('Y'));
      announce(false);
      announce(true);
      expect(r.marked).toEqual(['X', 'X']);
    } finally {
      r.destroy();
    }
  });
});

describe('a tap on a notification the PAGE raised (the plugin, iOS), with X left open', () => {
  it('the landing its handler publishes after the edge: X is not marked, Y is', () => {
    const r = mountReader('X');
    try {
      announce(false);
      announce(true, PAGE_NOTIFICATION_OPENING);
      messageLands();
      expect(r.marked).toEqual(['X']);
      notifNav.navigate('Y'); // `useNotifications`' onAction publishes the landing
      flushSync();
      messageLands();
      expect(r.marked).toEqual(['X']);
      r.select('Y');
      expect(r.marked).toEqual(['X', 'Y']);
    } finally {
      r.destroy();
    }
  });

  it('the landing published BEFORE the edge reached the page: X is not marked, Y is', () => {
    const r = mountReader('X');
    try {
      announce(false);
      notifNav.navigate('Y');
      flushSync();
      announce(true, PAGE_NOTIFICATION_OPENING);
      messageLands();
      expect(r.marked).toEqual(['X']);
      r.select('Y');
      expect(r.marked).toEqual(['X', 'Y']);
    } finally {
      r.destroy();
    }
  });

  it('a tap the handler routes nowhere releases X, which is what is on screen', () => {
    const r = mountReader('X');
    try {
      announce(false);
      announce(true, PAGE_NOTIFICATION_OPENING);
      expect(r.marked).toEqual(['X']);
      endResumeOpeningUnrouted('a notification this session did not post');
      flushSync();
      expect(r.marked).toEqual(['X', 'X']);
    } finally {
      r.destroy();
    }
  });

  it('a page notification for X itself marks X once it lands', () => {
    const r = mountReader('X');
    try {
      announce(false);
      announce(true, PAGE_NOTIFICATION_OPENING);
      notifNav.navigate('X');
      flushSync();
      expect(r.marked).toEqual(['X', 'X']);
    } finally {
      r.destroy();
    }
  });
});

describe('a cold start from a tap', () => {
  it.each([
    ['a chat link', link('Y')],
    ['a page notification', PAGE_NOTIFICATION_OPENING],
  ])('(%s) marks only Y: no conversation was open, so nothing is held', (_what, opening) => {
    // The page loads in the background (a launch by the tap), with nothing selected.
    announce(false);
    const r = mountReader(null);
    try {
      announce(true, opening);
      notifNav.navigate('Y');
      flushSync();
      r.select('Y');
      messageLands();
      expect(r.marked[0]).toBe('Y');
      expect(new Set(r.marked)).toEqual(new Set(['Y']));
    } finally {
      r.destroy();
    }
  });
});

describe('the wiring', () => {
  it('the receipt effect asks the hold, and the arrival rule does too', () => {
    const page = readFileSync('src/lib/components/MainChatPage.svelte', 'utf8');
    expect(page).toMatch(
      /onResume: \(opening\) => noteResumeOpening\(opening, convs\.selectedContact\)/
    );
    expect(page).toMatch(/onLeave: endResumeOpening/);
    expect(page).toMatch(
      /\$effect\.pre\(\(\) => followResumeSelection\(convs\.selectedContact\)\);/
    );
    expect(page).toMatch(/if \(resumeOpeningHolds\(convs\.selectedContact\)\) return;/);
    const arrival = readFileSync('src/lib/utils/chat/arrivalRuntime.ts', 'utf8');
    expect(arrival).toMatch(/if \(resumeOpeningHolds\(conversationKey\)\) return false;/);
    const layout = readFileSync('src/lib/components/layout/ChatBackgroundService.svelte', 'utf8');
    expect(layout).toMatch(/endResumeOpeningOnNavigation\(\);/);
    const hooks = readFileSync('src/hooks.client.ts', 'utf8');
    expect(hooks).toMatch(/const groupId = chatTargetOfLink\(u\.href\);/);
  });

  it("the page's tap handler releases the hold on every branch that publishes no landing", () => {
    const source = readFileSync('src/lib/composables/useNotifications.svelte.ts', 'utf8');
    expect(source.match(/endResumeOpeningUnrouted\(/g)?.length).toBe(2);
  });

  it("Android's page notifications are built natively and tap as a chat link to the activity", () => {
    // `notifyMessageFromWebSocket` (the page's builder) posts through `showMessageNotification`,
    // whose tap is ACTION_VIEW on the chat link - the intent `onNewIntent` carries into the edge.
    const fms = readFileSync(
      'src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt',
      'utf8'
    );
    expect(fms).toContain('fun notifyMessageFromWebSocket(');
    expect(fms).toMatch(
      /action = Intent\.ACTION_VIEW\s+setData\(android\.net\.Uri\.parse\("fr\.emse\.canari:\/\/chat\/\$groupId"\)\)/
    );
  });

  it('Android sends the link onNewIntent took with the edge onResume dispatches', () => {
    const activity = readFileSync(
      'src-tauri/gen/android/app/src/main/java/fr/emse/canari/MainActivity.kt',
      'utf8'
    );
    expect(activity).toMatch(
      /resumeOpening = if \(intent\.action == Intent\.ACTION_VIEW\) intent\.dataString else null/
    );
    expect(activity).toMatch(/pushForeground\(true, opening\)/);
    expect(activity).toMatch(/detail:\{foreground:\$foreground,opening:\$openingJs\}/);
  });
});
