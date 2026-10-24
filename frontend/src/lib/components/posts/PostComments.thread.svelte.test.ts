// @vitest-environment happy-dom
/**
 * THE THREAD AS A READER SEES IT (the comment refonte, 2026-10-21): the controls are the ones the
 * SERVER says this reader has (never a comparison of `userId`), a delete asks first, an anonymous
 * comment names nobody and an association's names the association, replies fold from two and a
 * reply the reader just wrote or was told about never hides, and "Repondre" puts the caret in the box.
 */
import { it, expect, afterEach, beforeEach, vi, describe } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import PostComments from './PostComments.svelte';
import type { PostComment } from '$lib/posts/api';
import { m } from '$lib/paraglide/messages';

const confirm = vi.hoisted(() => ({ answer: true, asked: [] as string[] }));
vi.mock('$lib/stores/confirm.svelte', () => ({
  showConfirm: async (message: string) => {
    confirm.asked.push(message);
    return confirm.answer;
  },
}));
// The composer asks which associations the reader may speak for when the box is first used.
vi.mock('$lib/associations/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/associations/api')>()),
  listMyAssociations: vi.fn().mockResolvedValue([]),
  listAssociations: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `User ${id}`,
  resolveUserDisplayName: async (id: string) => `User ${id}`,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplayUrl: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplayUrl: () => {},
}));

const mounted: (() => void)[] = [];
beforeEach(() => {
  confirm.answer = true;
  confirm.asked = [];
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const comment = (id: string, extra: Partial<PostComment> = {}): PostComment => ({
  id,
  userId: 'u2',
  text: `text ${id}`,
  parentId: null,
  createdAt: new Date(0).toISOString(),
  likes: [],
  ...extra,
});

function mountSection(
  comments: PostComment[],
  extra: { pending?: string[]; focus?: string; onReport?: (id: string) => void } = {}
) {
  const handlers = {
    onDeleteComment: vi.fn(async () => {}),
    onEditComment: vi.fn(async () => {}),
    onLikeComment: vi.fn(),
  };
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(PostComments, {
    target,
    props: {
      postId: 'p1',
      comments,
      topLevelComments: comments.filter((c) => !c.parentId),
      commentText: '',
      submittingComment: false,
      currentUserId: 'u1',
      pendingCommentIds: new Set(extra.pending ?? []),
      focusCommentId: extra.focus,
      onReport: extra.onReport,
      onCommentTextChange: vi.fn(async () => {}),
      onAddComment: vi.fn(async () => 'sent' as const),
      ...handlers,
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return { target, ...handlers };
}

const button = (target: HTMLElement, label: string) =>
  target.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const text = (target: HTMLElement, content: string) =>
  [...target.querySelectorAll<HTMLElement>('button')].find(
    (b) => b.textContent?.trim() === content
  );
const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    flushSync();
  }
};

describe("the controls are the server's, not derived from userId", () => {
  it("shows edit and delete only where the server served them - even on a comment of the reader's own account", () => {
    const { target } = mountSection([
      comment('mine', { userId: 'u1' }), // same account, but served without rights
      comment('served', { userId: 'u9', canEdit: true, canDelete: true }),
    ]);
    const rows = [...target.querySelectorAll<HTMLElement>('[id^="comment-"]')];
    const own = rows.find((r) => r.id === 'comment-mine')!;
    const served = rows.find((r) => r.id === 'comment-served')!;
    expect(own.querySelector(`button[aria-label="${m.common_edit_label()}"]`)).toBeNull();
    expect(own.querySelector(`button[aria-label="${m.common_delete_button()}"]`)).toBeNull();
    expect(served.querySelector(`button[aria-label="${m.common_edit_label()}"]`)).not.toBeNull();
    expect(served.querySelector(`button[aria-label="${m.common_delete_button()}"]`)).not.toBeNull();
  });

  it('offers the report on a comment the reader cannot edit, and not on one they can', () => {
    const { target } = mountSection(
      [comment('theirs'), comment('mine', { canEdit: true, canDelete: true })],
      { onReport: vi.fn() }
    );
    const reports = target.querySelectorAll(
      `button[aria-label="${m.post_report_comment_label()}"]`
    );
    expect(reports).toHaveLength(1);
  });

  it('a moderator who may delete but not edit gets the trash and the report', () => {
    const { target } = mountSection([comment('anon', { canDelete: true })], { onReport: vi.fn() });
    expect(button(target, m.common_delete_button())).not.toBeNull();
    expect(button(target, m.common_edit_label())).toBeNull();
    expect(button(target, m.post_report_comment_label())).not.toBeNull();
  });
});

describe('a delete asks first', () => {
  it('deletes only after the reader said yes', async () => {
    const { target, onDeleteComment } = mountSection([comment('c1', { canDelete: true })]);
    button(target, m.common_delete_button())!.click();
    await settle();
    expect(confirm.asked).toEqual([m.post_comment_delete_confirm()]);
    expect(onDeleteComment).toHaveBeenCalledExactlyOnceWith('c1');
  });

  it('does nothing when the reader says no - a stray tap no longer removes a thread', async () => {
    confirm.answer = false;
    const { target, onDeleteComment } = mountSection([comment('c1', { canDelete: true })]);
    button(target, m.common_delete_button())!.click();
    await settle();
    expect(onDeleteComment).not.toHaveBeenCalled();
  });
});

describe('who wrote it', () => {
  it('an anonymous comment names nobody and links nowhere', () => {
    const { target } = mountSection([comment('a1', { userId: undefined, anonymous: true })]);
    const row = target.querySelector<HTMLElement>('#comment-a1')!;
    expect(row.textContent).toContain(m.post_create_anonymous_label());
    expect(row.querySelector('a[href^="/profile/"]')).toBeNull();
  });

  it('says so when an anonymous comment was written by the post author', () => {
    const { target } = mountSection([
      comment('a1', { userId: undefined, anonymous: true, byPostAuthor: true }),
    ]);
    expect(target.querySelector('#comment-a1')!.textContent).toContain(
      m.post_comment_anonymous_author_label()
    );
  });

  it('an association comment carries the association name and its page', () => {
    const { target } = mountSection([
      comment('s1', {
        userId: undefined,
        association: { id: 'a1', name: 'BDE Mines', slug: 'bde-mines', logoUrl: null },
      }),
    ]);
    const row = target.querySelector<HTMLElement>('#comment-s1')!;
    expect(row.textContent).toContain('BDE Mines');
    expect(row.querySelector('a[href="/associations/bde-mines"]')).not.toBeNull();
  });

  it('marks an edited comment', () => {
    const { target } = mountSection([comment('e1', { editedAt: '2026-10-21T10:00:00Z' })]);
    expect(target.querySelector('#comment-e1')!.textContent).toContain(
      m.post_comment_edited_label()
    );
  });
});

describe('replies', () => {
  const thread = (replies: number) => [
    comment('c1'),
    ...Array.from({ length: replies }, (_, i) => comment(`r${i + 1}`, { parentId: 'c1' })),
  ];
  const repliesShown = (target: HTMLElement) =>
    [...target.querySelectorAll('[id^="comment-r"]')].length;

  it('shows a single reply directly - folding one costs a tap and saves one row', () => {
    const { target } = mountSection(thread(1));
    expect(repliesShown(target)).toBe(1);
    expect(text(target, m.post_comment_show_replies_label({ count: 1 }))).toBeUndefined();
  });

  it('folds two or more behind "Voir les N reponses", and opens and closes them', async () => {
    const { target } = mountSection(thread(3));
    expect(repliesShown(target)).toBe(0);
    text(target, m.post_comment_show_replies_label({ count: 3 }))!.click();
    await settle();
    expect(repliesShown(target)).toBe(3);
    text(target, m.post_comment_hide_replies_label())!.click();
    await settle();
    expect(repliesShown(target)).toBe(0);
  });

  it('never hides a reply the reader just wrote', () => {
    const { target } = mountSection(thread(3), { pending: ['r2'] });
    expect(repliesShown(target)).toBe(3);
  });

  it('never hides the reply a notification opened the post at', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    const { target } = mountSection(thread(3), { focus: 'r3' });
    expect(repliesShown(target)).toBe(3);
  });
});

describe('replying', () => {
  it('puts the caret in the box and names who is answered', async () => {
    const { target } = mountSection([comment('c1')]);
    text(target, m.post_reply_label())!.click();
    await tick();
    await tick();
    flushSync();
    expect(target.textContent).toContain(m.post_replying_to_label({ name: 'User u2' }));
    const editor = target.querySelector<HTMLElement>('[contenteditable="true"]')!;
    expect(document.activeElement).toBe(editor);
  });
});

describe('the like is ONE heart, at the right end of the row under the bubble', () => {
  const heart = (row: HTMLElement) => row.querySelector<HTMLButtonElement>('button[aria-pressed]')!;

  it('is a single control per comment, with no text "J\'aime" button next to it', () => {
    const { target } = mountSection([comment('c1', { likes: ['u8', 'u9'] })]);
    const row = target.querySelector<HTMLElement>('#comment-c1')!;
    expect(row.querySelectorAll('button[aria-pressed]')).toHaveLength(1);
    expect(
      [...row.querySelectorAll('button')].some((b) => b.textContent?.trim() === m.post_like_label())
    ).toBe(false);
  });

  it('says the count once: in the heart, as a number, and in its accessible name - not as a chip on the bubble', () => {
    const { target } = mountSection([comment('c1', { likes: ['u8', 'u9'] })]);
    const row = target.querySelector<HTMLElement>('#comment-c1')!;
    const button = heart(row);
    expect(button.textContent?.trim()).toBe('2');
    expect(button.getAttribute('aria-label')).toBe(m.post_likes_count_label({ count: 2 }));
    // The heart sits in the row UNDER the bubble, not inside it.
    expect(row.querySelector('.rounded-3xl')?.contains(button)).toBe(false);
    const showingTheCount = [...row.querySelectorAll('*')].filter(
      (el) => el.children.length === 0 && el.textContent?.trim() === '2'
    );
    expect(showingTheCount).toHaveLength(1);
  });

  it('shows no number when nobody liked it, and presses on a tap', () => {
    const { target, onLikeComment } = mountSection([comment('c1')]);
    const button = heart(target.querySelector<HTMLElement>('#comment-c1')!);
    expect(button.textContent?.trim()).toBe('');
    expect(button.getAttribute('aria-label')).toBe(m.post_like_label());
    button.click();
    expect(onLikeComment).toHaveBeenCalledExactlyOnceWith('c1');
  });

  it('is filled and pressed when the reader already liked it', () => {
    const { target } = mountSection([comment('c1', { likes: ['u1'] })]);
    const button = heart(target.querySelector<HTMLElement>('#comment-c1')!);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.className).toContain('text-red-500');
  });

  it('is withheld on a comment the server has not acknowledged yet', () => {
    const { target } = mountSection([comment('pending-1')], { pending: ['pending-1'] });
    expect(target.querySelector('#comment-pending-1 button[aria-pressed]')).toBeNull();
  });
});
