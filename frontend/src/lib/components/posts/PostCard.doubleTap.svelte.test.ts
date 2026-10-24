// @vitest-environment happy-dom
/**
 * A DOUBLE TAP ON A POST CARD LIKES IT, AND NEVER UNLIKES IT (user, 2026-10-19).
 *
 * Pinned: it takes the reaction picker's own path - the same request, the same refusal by a known
 * mute, the same rollback and sentence on a failure; a post the reader already reacted to (with
 * any reaction) gets the heart and NO request; a poll option or the action bar keeps its own taps;
 * a signed-out reader likes nothing; and a like given in the reel viewer reaches the card.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PostCard from './PostCard.svelte';
import type { PostEntity } from '$lib/posts/api';
import { addReaction, removeReaction, votePoll } from '$lib/posts/api';
import { cachedMuteStatus } from '$lib/moderation/muteCheck';
import { publishPostReactions } from '$lib/posts/postReaction';
import { apiFetch } from '$lib/utils/apiFetch';
import { m } from '$lib/paraglide/messages';
import { flushMacrotask } from '../../../test/flush';

vi.mock('$lib/posts/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/posts/api')>()),
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  votePoll: vi.fn(),
}));
vi.mock('$lib/utils/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/apiFetch')>()),
  apiFetch: vi.fn(),
}));
vi.mock('$lib/moderation/muteCheck', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/moderation/muteCheck')>()),
  assertNotMuted: async () => {},
  cachedMuteStatus: vi.fn(() => null),
}));

const mounted: (() => void)[] = [];

beforeEach(() => {
  for (const fn of [addReaction, removeReaction, votePoll, apiFetch]) vi.mocked(fn).mockReset();
  vi.mocked(cachedMuteStatus).mockReturnValue(null);
  vi.mocked(apiFetch).mockImplementation(() => new Promise(() => {}));
  vi.mocked(votePoll).mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {}))
  );
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function row(extra: Partial<PostEntity> = {}): PostEntity {
  return {
    id: 'p1',
    markdown: 'A post worth a heart',
    mentions: [],
    links: [],
    media: [],
    images: [],
    reactions: {},
    polls: [
      {
        id: 'poll1',
        question: 'Which one?',
        options: [
          { id: 'o1', label: 'First', votes: [] },
          { id: 'o2', label: 'Second', votes: [] },
        ],
        multipleChoice: false,
        votesByUser: {},
      },
    ],
    createdAt: '2026-10-15T08:00:00.000Z',
    publishedAt: '2026-10-15T08:00:00.000Z',
    updatedAt: '2026-10-15T08:00:00.000Z',
    ...extra,
  };
}

function mountCard(post: PostEntity, currentUserId = 'alice') {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const instance = mount(PostCard, { target, props: { post, currentUserId } });
  mounted.push(() => unmount(instance));
  flushSync();
  return target;
}

async function settle(): Promise<void> {
  await flushMacrotask();
  flushSync();
}

/**
 * Two taps on `el`, as an engine sends them: two clicks with a pointer behind them, both HAPPENED
 * before the first is handled - the gesture reads each event's `timeStamp`, so however long the
 * first click's work takes under suite load, the pair stays a double tap, as on a busy phone.
 */
function doubleTap(el: Element) {
  const clicks = [1, 2].map(
    (detail) =>
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 50, clientY: 50, detail })
  );
  for (const e of clicks) el.dispatchEvent(e);
  flushSync();
}

const text = (target: HTMLElement) => target.querySelector('.post-markdown')!;
const hearts = (target: HTMLElement) => target.querySelectorAll('[data-double-tap-heart]').length;
/** The emoji the reaction button shows as the reader's own, or null when they have not reacted. */
function myReaction(target: HTMLElement): string | null {
  const button = target.querySelector(`button[aria-label="${m.post_reacter()}"]`)!;
  return button.querySelector('img.emoji')?.getAttribute('alt') ?? null;
}

it('likes a post the reader has not reacted to: one request, the heart, the tally moved at once', async () => {
  vi.mocked(addReaction).mockResolvedValue({ ok: true, reactions: { alice: "J'aime" } });
  const target = mountCard(row());

  doubleTap(text(target));

  expect(myReaction(target)).toBe('❤️');
  expect(hearts(target)).toBe(1);
  await settle();
  // Sent behind `assertNotMuted`, so after a turn of the loop - once.
  expect(addReaction).toHaveBeenCalledTimes(1);
  expect(addReaction).toHaveBeenCalledWith('p1', "J'aime");
  expect(myReaction(target)).toBe('❤️');
});

it('never unlikes: an already-liked post gets the heart again and no request', async () => {
  const target = mountCard(row({ reactions: { alice: "J'aime" } }));

  doubleTap(text(target));
  await settle();

  expect(addReaction).not.toHaveBeenCalled();
  expect(removeReaction).not.toHaveBeenCalled();
  expect(myReaction(target)).toBe('❤️');
  expect(hearts(target)).toBe(1);
});

it('never replaces a reaction the reader chose', async () => {
  const target = mountCard(row({ reactions: { alice: 'Rire' } }));

  doubleTap(text(target));
  await settle();

  expect(addReaction).not.toHaveBeenCalled();
  expect(removeReaction).not.toHaveBeenCalled();
  expect(myReaction(target)).toBe('😂');
});

it('the heart leaves when its animation ends', () => {
  vi.mocked(addReaction).mockReturnValue(new Promise(() => {}));
  const target = mountCard(row());
  doubleTap(text(target));
  target.querySelector('[data-double-tap-heart]')!.dispatchEvent(new Event('animationend'));
  flushSync();
  expect(hearts(target)).toBe(0);
});

it('a double tap on a poll option is two taps on the option, never a like', async () => {
  const target = mountCard(row());
  const option = [...target.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('First')
  )!;

  doubleTap(option);
  await settle();

  // The option took its taps (a single-choice poll votes on the tap)...
  expect(votePoll).toHaveBeenCalled();
  // ...and the post was not liked.
  expect(addReaction).not.toHaveBeenCalled();
  expect(hearts(target)).toBe(0);
});

it("a double tap on the action bar is the bar's, never a like", async () => {
  const target = mountCard(row());
  const button = target.querySelector(`button[aria-label="${m.post_reacter()}"]`)!;

  doubleTap(button);
  await settle();

  expect(addReaction).not.toHaveBeenCalled();
  expect(hearts(target)).toBe(0);
});

it('a known mute refuses it as it refuses the heart button: no request, no heart, the same line', async () => {
  vi.mocked(cachedMuteStatus).mockReturnValue({ isMuted: true } as never);
  const target = mountCard(row());

  doubleTap(text(target));
  await settle();

  expect(addReaction).not.toHaveBeenCalled();
  expect(hearts(target)).toBe(0);
  expect(target.textContent).toContain(m.post_action_not_allowed());
});

it('a failed request rolls the like back and says so, as the heart button does', async () => {
  vi.mocked(addReaction).mockRejectedValue(new Error('refused'));
  const target = mountCard(row());

  doubleTap(text(target));
  expect(myReaction(target)).toBe('❤️');
  await settle();

  expect(myReaction(target)).toBeNull();
  expect(target.textContent).toContain(m.post_reaction_error());
});

it('a signed-out reader likes nothing', async () => {
  const target = mountCard(row(), '');

  doubleTap(text(target));
  await settle();

  expect(addReaction).not.toHaveBeenCalled();
  expect(hearts(target)).toBe(0);
});

it('a like given in the reel viewer reaches the card', () => {
  const target = mountCard(row());

  publishPostReactions('p1', { alice: "J'aime" });
  flushSync();

  expect(myReaction(target)).toBe('❤️');
});
