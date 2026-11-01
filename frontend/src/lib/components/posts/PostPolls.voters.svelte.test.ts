// @vitest-environment happy-dom
/**
 * The voter list of a poll: a capped hover preview (mouse only), and an info button that opens the
 * FULL list in a sheet and never votes. Covers the post poll and the channel poll alike, since both
 * render `PostPolls`.
 *
 * Two voters may share a display name; the rows are keyed by voter id (a name key threw
 * `each_key_duplicate`).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PostPolls from './PostPolls.svelte';
import type { Poll } from '$lib/posts/api';

vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => id,
  resolveUserDisplayName: async (id: string) => `Name ${id}`,
}));

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const ids = (n: number) => Array.from({ length: n }, (_, i) => `u${i + 1}`);

function render(votes: string[] | number, extra: Partial<Poll> = {}) {
  const poll = {
    id: 'poll',
    question: 'q',
    multipleChoice: false,
    votesByUser: {},
    options: [
      { id: 'o1', label: 'one', votes },
      { id: 'o2', label: 'two', votes: ['z1'] },
    ],
    ...extra,
  } as unknown as Poll;
  const onVoteClick = vi.fn();
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(PostPolls, {
    target,
    props: {
      polls: [poll],
      selectedOptions: [],
      onVoteClick,
      onSubmitVote: () => {},
      isOver: () => false,
    },
  });
  mounted.push(() => unmount(component));
  return { target, onVoteClick };
}

const settle = async () => {
  await new Promise<void>((r) => setTimeout(r, 0));
  flushSync();
};
const info = (t: HTMLElement) =>
  t.querySelector<HTMLButtonElement>('[data-testid="poll-voters-info"]')!;
const hover = async (el: HTMLElement, pointerType: string) => {
  const e = new PointerEvent('pointerover', { pointerType, bubbles: true });
  el.dispatchEvent(e);
  await settle();
};
const tooltipRows = () => [...document.body.querySelectorAll('[role="tooltip"] li')];

describe('PostPolls voter list', () => {
  it('draws two homonym voters as two rows without a duplicate key', async () => {
    const { target } = render(['u1', 'u2']);
    info(target).click();
    await settle();
    const rows = [...document.body.querySelectorAll('[data-testid="poll-voters-list"] li')];
    expect(rows.map((r) => r.textContent)).toEqual(['Name u1', 'Name u2']);
  });

  it('caps the hover tooltip at 10 names and says how many more', async () => {
    const { target } = render(ids(45));
    await hover(info(target), 'mouse');
    expect(tooltipRows()).toHaveLength(10);
    expect(document.body.querySelector('[role="tooltip"]')!.textContent).toMatch(/35/);
  });

  it('shows no "+N" when 10 voters or fewer', async () => {
    const { target } = render(ids(10));
    await hover(info(target), 'mouse');
    expect(tooltipRows()).toHaveLength(10);
    expect(document.body.querySelector('[role="tooltip"]')!.textContent).not.toMatch(/\+/);
  });

  it('does not open the tooltip on a touch pointer', async () => {
    const { target } = render(ids(3));
    await hover(info(target), 'touch');
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('opens the full list of 45 in a dialog, and the info button never votes', async () => {
    const { target, onVoteClick } = render(ids(45));
    info(target).click();
    await settle();
    expect(onVoteClick).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.querySelectorAll('[data-testid="poll-voters-list"] li')).toHaveLength(45);
  });

  it('keeps the info button a sibling of the vote button, never a child', () => {
    const { target } = render(ids(2));
    expect(info(target).closest('button[aria-pressed]')).toBeNull();
  });

  it('switches option inside the sheet', async () => {
    const { target } = render(ids(3));
    info(target).click();
    await settle();
    const tabs = [...document.body.querySelectorAll<HTMLElement>('[role="dialog"] [aria-pressed]')];
    expect(tabs).toHaveLength(2);
    tabs[1].click();
    await settle();
    const rows = [...document.body.querySelectorAll('[data-testid="poll-voters-list"] li')];
    expect(rows.map((r) => r.textContent)).toEqual(['Name z1']);
  });

  it('closes on Escape and returns focus to the info button', async () => {
    const { target } = render(ids(2));
    const btn = info(target);
    btn.focus();
    btn.click();
    await settle();
    document.body
      .querySelector('[role="dialog"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => {
      flushSync();
      expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    });
    expect(document.activeElement).toBe(btn);
  });

  it('has an accessible name on the info button', () => {
    const { target } = render(ids(2));
    expect(info(target).getAttribute('aria-label')).toMatch(/one/);
  });

  it('offers no info button on an anonymous poll (a tally, no voters)', () => {
    const { target } = render(7, { anonymous: true });
    expect(info(target)).toBeNull();
    expect(target.textContent).toContain('7');
  });

  it('offers no info button for an option with 0 voters', () => {
    const { target } = render([]);
    const buttons = target.querySelectorAll('[data-testid="poll-voters-info"]');
    // only the second option (1 voter) has one
    expect(buttons).toHaveLength(1);
  });

  it('opens a single voter in the sheet', async () => {
    const { target } = render(['u1']);
    info(target).click();
    await settle();
    expect(document.body.querySelectorAll('[data-testid="poll-voters-list"] li')).toHaveLength(1);
  });
});
