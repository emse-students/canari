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

    badges[0].dispatchEvent(new MouseEvent('mouseenter'));
    flushSync();

    const rows = [...(panel()?.querySelectorAll('li') ?? [])].map((li) => li.textContent);
    expect(rows).toEqual(['Camille', 'Dominique']);
  });

  it('names the OTHER badge s reactor when that one is opened, and only that one', () => {
    const { badges } = render();

    badges[1].dispatchEvent(new MouseEvent('mouseenter'));
    flushSync();

    const rows = [...(panel()?.querySelectorAll('li') ?? [])].map((li) => li.textContent);
    expect(rows).toEqual(['Sacha']);
  });

  it('opens no panel until a badge is entered', () => {
    render();
    flushSync();
    expect(panel()).toBeNull();
  });

  it('portals the panel out of the row, so a bubble s overflow cannot clip it', () => {
    const { target, badges } = render();

    badges[0].dispatchEvent(new MouseEvent('mouseenter'));
    flushSync();

    expect(panel()).not.toBeNull();
    expect(target.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('carries no `title`, which is the attribute that named nobody on a touch screen', () => {
    const { badges } = render();
    for (const b of badges) expect(b.getAttribute('title')).toBeNull();
  });

  it('keeps the badge a toggle: entering it does not react on the reader s behalf', () => {
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

    badge.dispatchEvent(new MouseEvent('mouseenter'));
    flushSync();
    expect(reacted).toEqual([]);

    badge.click();
    expect(reacted).toEqual(['👍']);
  });
});
