/**
 * IN A GROUP, THE BADGE MUST NAME WHO REACTED - AND A `title` NAMES NOBODY ON A PHONE.
 *
 * Reported through the user on 2026-09-18: *"on me dit qu'il n'y a pas de moyen de voir qui a mis
 * quelle reaction dans les groupes."* The ids were already on the row and were already resolved to
 * names; the names went into a native `title`, which a touch screen never draws. So the data was
 * never missing and the disclosure was.
 *
 * WHAT IS PINNED HERE IS THE DISCLOSURE, NOT THE PLACEMENT. Where the panel lands, that it follows a
 * scroll and that it closes four ways are `ReactorsPanel`'s own, asserted on the posts side against
 * A1's numbers - this file would only be a second copy of them. What it asserts is that the chat
 * badge opens THAT panel, that the panel holds one line per reactor of THAT emoji and not of its
 * neighbour, and that the `title` nobody could read is gone.
 *
 * `document.body` is queried rather than the mount target: the panel is portalled out, which is the
 * whole reason it can escape a message bubble's `overflow`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MessageReactions from './MessageReactions.svelte';
import { HOVER_INTENT_MS, LONG_PRESS_MS } from '$lib/actions/reactorsTrigger';

/** A hold on a badge - the only gesture that opens the list (Discord's, 2026-10-01). */
function hold(badge: HTMLElement) {
  vi.useFakeTimers();
  try {
    badge.dispatchEvent(
      Object.assign(new Event('pointerdown', { bubbles: true }), {
        pointerType: 'touch',
        button: 0,
        clientX: 0,
        clientY: 0,
      })
    );
    vi.advanceTimersByTime(LONG_PRESS_MS + 50);
    flushSync();
  } finally {
    vi.useRealTimers();
  }
}

const NAMES: Record<string, string> = { u1: 'Camille', u2: 'Dominique', u3: 'Sacha' };

vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => NAMES[id] ?? id,
  resolveUserDisplayName: (id: string) => Promise.resolve(NAMES[id] ?? null),
}));

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** A group message carrying two distinct reactions, the first chosen by two people. */
function render() {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(MessageReactions, {
    target,
    props: {
      groupedReactions: { '👍': ['u1', 'u2'], '🎉': ['u3'] },
      isOwn: false,
      currentUserId: 'me',
    },
  });
  flushSync(); // actions attach in an effect
  mounted.push(() => unmount(app, { outro: false }));

  const badges = [...target.querySelectorAll('button')];
  // happy-dom reports a zero rect, and a zero rect is what `bindFixedPopover` refuses to position
  // against - so each badge is given a box. The numbers are arbitrary; only placement reads them,
  // and placement is asserted elsewhere.
  for (const b of badges) {
    b.getBoundingClientRect = () =>
      ({ left: 40, right: 80, top: 300, bottom: 328, width: 40, height: 28 }) as DOMRect;
  }
  return { target, badges };
}

function panel(): HTMLElement | null {
  return document.body.querySelector('[role="tooltip"]');
}

describe('MessageReactions - who reacted with what', () => {
  it('names every reactor of the badge that was opened', () => {
    const { badges } = render();
    expect(panel()).toBeNull();

    hold(badges[0]);

    const rows = [...(panel()?.querySelectorAll('li') ?? [])].map((li) => li.textContent);
    expect(rows).toEqual(['Camille', 'Dominique']);
  });

  it('names the OTHER badge s reactor when that one is opened, and only that one', () => {
    const { badges } = render();

    hold(badges[1]);

    const rows = [...(panel()?.querySelectorAll('li') ?? [])].map((li) => li.textContent);
    expect(rows).toEqual(['Sacha']);
  });

  it('opens no panel until a badge is held', () => {
    render();
    flushSync();
    expect(panel()).toBeNull();
  });

  it('portals the panel out of the row, so a bubble s overflow cannot clip it', () => {
    const { target, badges } = render();

    hold(badges[0]);

    expect(panel()).not.toBeNull();
    expect(target.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('carries no `title`, which is the attribute that named nobody on a touch screen', () => {
    const { badges } = render();
    for (const b of badges) expect(b.getAttribute('title')).toBeNull();
  });

  it('keeps the badge a toggle: a mouse brushing past opens nothing and reacts to nothing', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const reacted: string[] = [];
    const app = mount(MessageReactions, {
      target,
      props: {
        groupedReactions: { '👍': ['u1'] },
        currentUserId: 'me',
        onReact: (emoji: string) => reacted.push(emoji),
      },
    });
    mounted.push(() => unmount(app, { outro: false }));

    const badge = target.querySelector('button')!;
    badge.getBoundingClientRect = () =>
      ({ left: 40, right: 80, top: 300, bottom: 328, width: 40, height: 28 }) as DOMRect;

    badge.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
    flushSync();
    expect(reacted).toEqual([]);
    expect(panel()).toBeNull();

    badge.click();
    expect(reacted).toEqual(['👍']);
  });
});

/** A pointer event of a given type on a badge. */
function pointer(badge: HTMLElement, type: string, pointerType: 'mouse' | 'touch') {
  badge.dispatchEvent(
    Object.assign(
      new Event(type, { bubbles: type !== 'pointerenter' && type !== 'pointerleave' }),
      {
        pointerType,
        button: 0,
        clientX: 0,
        clientY: 0,
      }
    )
  );
}

describe('MessageReactions - the list opens on a mouse REST, not on the way to a click', () => {
  afterEach(() => vi.useRealTimers());

  it('opens after HOVER_INTENT_MS of resting, names the panel, closes on leave', () => {
    const { badges } = render();
    vi.useFakeTimers();

    pointer(badges[0], 'pointerenter', 'mouse');
    vi.advanceTimersByTime(HOVER_INTENT_MS - 1);
    flushSync();
    expect(panel()).toBeNull();

    vi.advanceTimersByTime(1);
    flushSync();
    expect(panel()).not.toBeNull();
    expect(badges[0].getAttribute('aria-describedby')).toBe(panel()!.id);

    pointer(badges[0], 'pointerleave', 'mouse');
    flushSync();
    expect(panel()).toBeNull();
    expect(badges[0].getAttribute('aria-describedby')).toBeNull();
  });

  it('opens nothing when the mouse leaves before the delay', () => {
    const { badges } = render();
    vi.useFakeTimers();

    pointer(badges[0], 'pointerenter', 'mouse');
    vi.advanceTimersByTime(HOVER_INTENT_MS - 50);
    pointer(badges[0], 'pointerleave', 'mouse');
    vi.advanceTimersByTime(500);
    flushSync();
    expect(panel()).toBeNull();
  });

  it('a press before the delay reacts and never opens the list', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const reacted: string[] = [];
    const app = mount(MessageReactions, {
      target,
      props: {
        groupedReactions: { '👍': ['u1'] },
        currentUserId: 'me',
        onReact: (emoji: string) => reacted.push(emoji),
      },
    });
    mounted.push(() => unmount(app, { outro: false }));
    flushSync();
    const badge = target.querySelector('button')!;
    vi.useFakeTimers();

    pointer(badge, 'pointerenter', 'mouse');
    pointer(badge, 'pointerdown', 'mouse');
    pointer(badge, 'pointerup', 'mouse');
    badge.click();
    vi.advanceTimersByTime(HOVER_INTENT_MS + LONG_PRESS_MS);
    flushSync();
    expect(reacted).toEqual(['👍']);
    expect(panel()).toBeNull();
  });

  it('a touch never hovers: its enter opens nothing, the long press still does', () => {
    const { badges } = render();
    vi.useFakeTimers();

    pointer(badges[0], 'pointerenter', 'touch');
    vi.advanceTimersByTime(HOVER_INTENT_MS + 100);
    flushSync();
    expect(panel()).toBeNull();

    pointer(badges[0], 'pointerdown', 'touch');
    vi.advanceTimersByTime(LONG_PRESS_MS + 50);
    flushSync();
    expect(panel()).not.toBeNull();
  });
});
