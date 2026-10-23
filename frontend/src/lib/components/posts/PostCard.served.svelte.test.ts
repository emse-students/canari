// @vitest-environment happy-dom
/**
 * A CARD TAKES THE SERVER'S ROW WHEN ITS PARENT HANDS IT A NEW ONE FOR THE SAME POST (review of
 * #1896). The feed draws its stored copy first - no rights, `canVote: false` - and the keyed list
 * keeps the card when the server's page replaces the row; the card used to copy its prop once, so
 * the vote stayed refused and the old text stayed drawn for the whole session.
 *
 * AND IT DOES NOT TAKE A ROW OLDER THAN ITS OWN WRITE (second review): a feed GET issued before a
 * tap can land after the tap's own POST answered, and adopting that row whole erased the tap.
 */
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PostCard from './PostCard.svelte';
import type { PostEntity } from '$lib/posts/api';
import type { PostComment } from '$lib/posts/api';
import {
  addComment,
  addReaction,
  likeComment,
  deleteComment,
  editComment,
  fetchComments,
  listPosts,
  votePoll,
} from '$lib/posts/api';
import { nextPostSequence, servedAt, stampServed } from '$lib/posts/postCardSync';
import { apiFetch } from '$lib/utils/apiFetch';
import { m } from '$lib/paraglide/messages';
import { flushMacrotask } from '../../../test/flush';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

// The comment sheet is a Modal: its transitions end through the test's own clock.
afterAll(adoptTransitionAnimations());

// `listPosts` stays REAL: the order it stamps its rows in is what is under test.
vi.mock('$lib/posts/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/posts/api')>()),
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  votePoll: vi.fn(),
  fetchComments: vi.fn(),
  addComment: vi.fn(),
  likeComment: vi.fn(),
  editComment: vi.fn(),
  deleteComment: vi.fn(),
}));
// A delete asks first; the test answers yes.
vi.mock('$lib/stores/confirm.svelte', () => ({ showConfirm: vi.fn().mockResolvedValue(true) }));

vi.mock('$lib/utils/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/apiFetch')>()),
  apiFetch: vi.fn(),
}));
vi.mock('$lib/moderation/muteCheck', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/moderation/muteCheck')>()),
  assertNotMuted: async () => {},
  cachedMuteStatus: () => null,
}));

const mounted: (() => void)[] = [];

beforeEach(() => {
  for (const fn of [
    addReaction,
    votePoll,
    fetchComments,
    addComment,
    likeComment,
    editComment,
    deleteComment,
    apiFetch,
  ]) {
    vi.mocked(fn).mockReset();
  }
  // Nothing else on the card may reach the network unasked: an unexpected call never answers.
  vi.mocked(apiFetch).mockImplementation(() => new Promise(() => {}));
  // The comment rows draw avatars, which fetch on their own; there is no server here.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {}))
  );
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function row(extra: Partial<PostEntity>): PostEntity {
  return {
    id: 'p1',
    markdown: 'stored text',
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

/** A row as `$lib/posts/api` hands it over: stamped with the point its read was issued at. */
function servedRow(issuedAt: number, extra: Partial<PostEntity>): PostEntity {
  const r = row(extra);
  stampServed(r, issuedAt);
  return r;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await flushMacrotask();
  flushSync();
}

function mountCard(post: PostEntity, commentsOpen = false) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const props = $state({ post, currentUserId: 'alice', commentsOpen });
  const instance = mount(PostCard, { target, props });
  mounted.push(() => unmount(instance));
  flushSync();
  return { target, props };
}

/** The poll's option buttons, by their `aria-disabled`. */
function optionsRefused(target: HTMLElement): string[] {
  return [...target.querySelectorAll('button[aria-pressed]')].map(
    (b) => b.getAttribute('aria-disabled') ?? ''
  );
}

/**
 * Whether the tally counts the reader's vote: an option's counter reads one vote. Not the "you
 * voted" mark, which follows the selection and would survive a tally that lost the vote.
 */
function tallied(target: HTMLElement): boolean {
  return !!target.querySelector(`[aria-label="${m.post_poll_vote_count_label({ count: 1 })}"]`);
}

/** Opens the reaction picker and returns its buttons. */
function picker(target: HTMLElement): HTMLButtonElement[] {
  if (!target.querySelector('[role="group"]')) {
    (target.querySelector(`button[aria-label="${m.post_reacter()}"]`) as HTMLButtonElement).click();
    flushSync();
  }
  return [...target.querySelectorAll<HTMLButtonElement>('[role="group"] button')];
}

/** Whether alice's reaction is drawn, read from the picker's pressed state. */
function aliceReacted(target: HTMLElement): boolean {
  const pressed = picker(target).some((b) => b.getAttribute('aria-pressed') === 'true');
  // Close it again so the next read starts from the same place.
  (target.querySelector(`button[aria-label="${m.post_reacter()}"]`) as HTMLButtonElement).click();
  flushSync();
  return pressed;
}

it('a $state list keeps its rows and their read stamp through a filter or an append', () => {
  // The feed's own edits (`onDelete`'s filter, the infinite scroll's append) reassign the list; the
  // card adopts a row only when its identity changes, so those must keep it - and the stamp must be
  // read back through Svelte's proxy, or every served row would look older than every write.
  const first = servedRow(41, {});
  const feed = $state({ list: [first, row({ id: 'p2' })] });
  const proxied = feed.list[0];
  feed.list = feed.list.filter((p) => p.id !== 'p2');
  feed.list = [...feed.list, row({ id: 'p3' })];
  expect(feed.list[0]).toBe(proxied);
  expect(servedAt(feed.list[0])).toBe(41);
  // A stored or cached copy is a clone, and a clone carries no stamp.
  expect(servedAt(JSON.parse(JSON.stringify(first)))).toBe(0);
  expect(servedAt(structuredClone(first))).toBe(0);
});

it('adopts the served row: the vote opens and the new text is drawn', () => {
  const { target, props } = mountCard(row({ canVote: false }));

  expect(optionsRefused(target)).toEqual(['true', 'true']);
  expect(target.textContent).toContain('stored text');

  // The server's page: the same post, with this reader's rights and the text as it is now.
  props.post = servedRow(nextPostSequence(), { canVote: true, markdown: 'served text' });
  flushSync();

  expect(optionsRefused(target)).toEqual(['false', 'false']);
  expect(target.textContent).toContain('served text');
  expect(target.textContent).not.toContain('stored text');
});

it('a row whose read was issued BEFORE a reaction answered does not erase the reaction', async () => {
  const { target, props } = mountCard(row({ canVote: true }));
  // The feed's GET leaves now...
  const getIssuedAt = nextPostSequence();
  // ...the reader taps a heart, and its POST answers first...
  vi.mocked(addReaction).mockResolvedValue({ ok: true, reactions: { alice: "J'aime" } });
  picker(target)[0].click();
  await settle();
  expect(aliceReacted(target)).toBe(true);

  // ...then the GET lands, with the row as it was before the heart.
  props.post = servedRow(getIssuedAt, { canVote: true, markdown: 'served text', reactions: {} });
  flushSync();

  expect(target.textContent).toContain('served text');
  expect(aliceReacted(target)).toBe(true);

  // A read issued after the answer speaks for the reactions again.
  props.post = servedRow(nextPostSequence(), { canVote: true, reactions: {} });
  flushSync();
  expect(aliceReacted(target)).toBe(false);
});

it('a row whose read was issued BEFORE a vote answered does not erase the vote', async () => {
  const { target, props } = mountCard(row({ canVote: true }));
  const getIssuedAt = nextPostSequence();
  vi.mocked(votePoll).mockResolvedValue(row({}));
  (
    target.querySelector('button[aria-pressed][aria-disabled="false"]') as HTMLButtonElement
  ).click();
  await settle();
  expect(tallied(target)).toBe(true);

  props.post = servedRow(getIssuedAt, { canVote: true, markdown: 'served text' });
  flushSync();

  expect(target.textContent).toContain('served text');
  expect(tallied(target)).toBe(true);
});

it('a row landing while the vote is still out does not erase it either', async () => {
  const { target, props } = mountCard(row({ canVote: true }));
  const answer = deferred<PostEntity>();
  vi.mocked(votePoll).mockReturnValue(answer.promise);
  (
    target.querySelector('button[aria-pressed][aria-disabled="false"]') as HTMLButtonElement
  ).click();
  await settle();

  // Issued after the tap, answered before the vote committed: it does not have the vote.
  props.post = servedRow(nextPostSequence(), { canVote: true, markdown: 'served text' });
  flushSync();
  answer.resolve(row({}));
  await settle();

  expect(target.textContent).toContain('served text');
  expect(tallied(target)).toBe(true);
});

it('a failed reaction rolls back ONLY the reactions, to the row adopted while it was out', async () => {
  const { target, props } = mountCard(row({ canVote: true }));
  const answer = deferred<{ ok: boolean; reactions: Record<string, string> }>();
  vi.mocked(addReaction).mockReturnValue(answer.promise);
  picker(target)[0].click();
  await settle();

  // The server's page lands while the reaction is out: new text, and alice's heart already there
  // (another device of hers reacted) - the newest thing the server said about the reactions.
  props.post = servedRow(nextPostSequence(), {
    canVote: true,
    markdown: 'served text',
    reactions: { alice: "J'adore" },
  });
  flushSync();

  answer.reject(new Error('offline'));
  await settle();

  expect(target.textContent).toContain('served text');
  const pressed = picker(target).map((b) => b.getAttribute('aria-pressed'));
  expect(pressed.slice(0, 2)).toEqual(['false', 'true']);
});

it('through the REAL listPosts: a GET sent before the heart, landing after its POST, keeps the heart', async () => {
  const { target, props } = mountCard(row({ canVote: true }));
  const response = deferred<Response>();
  vi.mocked(apiFetch).mockReturnValueOnce(response.promise);
  const get = listPosts({ limit: 20 }); // sent now, before the tap
  vi.mocked(addReaction).mockResolvedValue({ ok: true, reactions: { alice: "J'aime" } });
  picker(target)[0].click();
  await settle();

  response.resolve(
    new Response(JSON.stringify([row({ canVote: true, markdown: 'served text' })]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  props.post = (await get)[0];
  flushSync();

  expect(target.textContent).toContain('served text');
  expect(aliceReacted(target)).toBe(true);
});

it('the poll selection follows the card, not a row older than the vote', async () => {
  const { target, props } = mountCard(row({ canVote: true }));
  const getIssuedAt = nextPostSequence();
  vi.mocked(votePoll).mockResolvedValue(row({}));
  (
    target.querySelector('button[aria-pressed][aria-disabled="false"]') as HTMLButtonElement
  ).click();
  await settle();

  // The row read before the vote answered still holds the reader's PREVIOUS answer.
  const before = row({ canVote: true }).polls![0];
  props.post = servedRow(getIssuedAt, {
    canVote: true,
    polls: [
      {
        ...before,
        options: [
          { id: 'o1', label: 'First', votes: [] },
          { id: 'o2', label: 'Second', votes: ['alice'] },
        ],
        votesByUser: { alice: ['o2'] },
      },
    ],
  });
  flushSync();

  const pressed = [...target.querySelectorAll('button[aria-pressed]')].map((b) =>
    b.getAttribute('aria-pressed')
  );
  expect(pressed).toEqual(['true', 'false']);
});

function comment(i: number, extra: Partial<PostComment> = {}): PostComment {
  const id = `c-${String(i).padStart(2, '0')}`;
  return {
    id,
    userId: 'bob',
    text: `note-${id}`,
    likes: [],
    createdAt: '2026-10-15T08:00:00.000Z',
    ...extra,
  };
}

/** The comment SHEET is a portal on the document: what a reader does in the thread is done there. */
const sheet = () => document.body;

it('an edited comment is not put back by a row read before the edit answered', async () => {
  const mine = comment(1, { userId: 'alice', text: 'old words', canEdit: true, canDelete: true });
  const { props } = mountCard(row({ comments: [mine] }), true);
  const getIssuedAt = nextPostSequence();
  vi.mocked(editComment).mockResolvedValue({ comment: { ...mine, text: 'new words' } } as never);

  (
    sheet().querySelector(`button[aria-label="${m.common_edit_label()}"]`) as HTMLButtonElement
  ).click();
  flushSync();
  const input = sheet().querySelector('input[type="text"]') as HTMLInputElement;
  input.value = 'new words';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  (
    sheet().querySelector(`button[aria-label="${m.common_validate_button()}"]`) as HTMLButtonElement
  ).click();
  await settle();
  expect(sheet().textContent).toContain('new words');

  props.post = servedRow(getIssuedAt, { markdown: 'served text', comments: [mine] });
  flushSync();

  expect(sheet().textContent).toContain('served text');
  expect(sheet().textContent).toContain('new words');
  expect(sheet().textContent).not.toContain('old words');
});

it('a deleted comment is not brought back by a row read before the delete answered', async () => {
  const mine = comment(1, { userId: 'alice', text: 'gone words', canEdit: true, canDelete: true });
  const { props } = mountCard(row({ comments: [mine] }), true);
  const getIssuedAt = nextPostSequence();
  vi.mocked(deleteComment).mockResolvedValue({ ok: true } as never);

  (
    sheet().querySelector(`button[aria-label="${m.common_delete_button()}"]`) as HTMLButtonElement
  ).click();
  await settle();
  expect(sheet().textContent).not.toContain('gone words');

  props.post = servedRow(getIssuedAt, { markdown: 'served text', comments: [mine] });
  flushSync();

  expect(sheet().textContent).toContain('served text');
  expect(sheet().textContent).not.toContain('gone words');
});

it('a failed comment takes back only its own row, never a heart still being sent', async () => {
  const theirs = comment(1);
  const { props } = mountCard(row({ comments: [theirs] }), true);
  // A newer row lands first, so a rollback "to the served value" would have one to go back to.
  props.post = servedRow(nextPostSequence(), { comments: [theirs] });
  flushSync();

  vi.mocked(likeComment).mockReturnValue(new Promise(() => {})); // the heart is still out
  // The like is ONE heart control: it is found by its name, and says its count in that name.
  const like = sheet().querySelector(
    `button[aria-label="${m.post_like_label()}"]`
  ) as HTMLButtonElement;
  like.click();
  flushSync();
  const hearted = m.post_likes_count_label({ count: 1 });
  const heartCounted = () => sheet().querySelector(`button[aria-label="${hearted}"]`) !== null;
  expect(heartCounted()).toBe(true);

  vi.mocked(addComment).mockRejectedValue(new Error('offline'));
  const editor = sheet().querySelector('[contenteditable="true"]') as HTMLElement;
  editor.textContent = 'my words';
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  (
    sheet().querySelector(
      `button[aria-label="${m.post_send_comment_label()}"]`
    ) as HTMLButtonElement
  ).click();
  await settle();

  expect(addComment).toHaveBeenCalled();
  expect(heartCounted()).toBe(true);
});

it('older threads the reader read are kept over a fresher feed row', async () => {
  const first = Array.from({ length: 20 }, (_, i) => comment(i + 1));
  // The server counts two more than the twenty a feed row carries: that is what offers the button.
  const { props } = mountCard(row({ comments: first, commentCount: 22 }), true);
  vi.mocked(fetchComments).mockResolvedValueOnce({
    comments: [comment(21), comment(22)],
    nextCursor: null,
    hasMore: false,
  });
  const button = [...sheet().querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === m.post_comment_load_older_label()
  ) as HTMLButtonElement;
  button.click();
  await settle();
  expect(sheet().textContent).toContain('note-c-22');

  // A feed refresh: the row carries the newest few only.
  props.post = servedRow(nextPostSequence(), {
    markdown: 'served text',
    comments: first.slice(0, 3),
  });
  flushSync();

  expect(sheet().textContent).toContain('served text');
  // The older rows stay where the reader put them, and nothing is read again.
  expect(sheet().textContent).toContain('note-c-22');
  expect(fetchComments).toHaveBeenCalledTimes(1);
});
