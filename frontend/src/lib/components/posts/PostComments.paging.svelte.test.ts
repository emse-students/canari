// @vitest-environment happy-dom
/**
 * OLDER COMMENTS, PAGE BY PAGE (`PostComments`): the button follows the SERVER's answer to "is there
 * more" - its count only before the first page - and the sorts that are about the WHOLE thread read
 * the pages first, or "oldest" would be the oldest of what happens to be loaded.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PostComments from './PostComments.svelte';
import type { PostComment } from '$lib/posts/api';
import { m } from '$lib/paraglide/messages';

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
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const comment = (n: number): PostComment => ({
  id: `c${n}`,
  userId: 'u2',
  text: `text ${n}`,
  parentId: null,
  likes: [],
  createdAt: new Date(Date.UTC(2026, 9, 21, 9, n)).toISOString(),
});

function mountThread(opts: {
  rows: number;
  totalCommentCount?: number;
  hasMoreComments?: boolean;
  loadingMore?: boolean;
  onLoadOlder: (props: { comments: PostComment[]; hasMoreComments?: boolean }) => Promise<void>;
}) {
  const props = $state({
    postId: 'p1',
    comments: Array.from({ length: opts.rows }, (_, i) => comment(i)),
    topLevelComments: [] as PostComment[],
    commentText: '',
    submittingComment: false,
    currentUserId: 'u1',
    totalCommentCount: opts.totalCommentCount,
    hasMoreComments: opts.hasMoreComments,
    loadingMore: opts.loadingMore ?? false,
    onCommentTextChange: async () => {},
    onAddComment: async () => 'sent' as const,
    onLikeComment: () => {},
    onEditComment: async () => {},
    onDeleteComment: async () => {},
    onLoadOlder: async () => opts.onLoadOlder(props),
  });
  // The top-level list follows the rows, as the card derives it.
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(PostComments, {
    target,
    props: {
      get postId() {
        return props.postId;
      },
      get comments() {
        return props.comments;
      },
      get topLevelComments() {
        return props.comments.filter((c) => !c.parentId);
      },
      get commentText() {
        return props.commentText;
      },
      get submittingComment() {
        return props.submittingComment;
      },
      get currentUserId() {
        return props.currentUserId;
      },
      get totalCommentCount() {
        return props.totalCommentCount;
      },
      get hasMoreComments() {
        return props.hasMoreComments;
      },
      get loadingMore() {
        return props.loadingMore;
      },
      onCommentTextChange: props.onCommentTextChange,
      onAddComment: props.onAddComment,
      onLikeComment: props.onLikeComment,
      onEditComment: props.onEditComment,
      onDeleteComment: props.onDeleteComment,
      onLoadOlder: props.onLoadOlder,
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return { target, props };
}

const olderButton = (t: HTMLElement) =>
  [...t.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === m.post_comment_load_older_label()
  );
const sortButton = (t: HTMLElement, label: string) =>
  [...t.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
const settle = async () => {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    flushSync();
  }
};

describe('the "older comments" button', () => {
  it('before any page, follows the server count against the rows held', () => {
    const more = mountThread({ rows: 20, totalCommentCount: 30, onLoadOlder: async () => {} });
    expect(olderButton(more.target)).toBeDefined();
    const none = mountThread({ rows: 20, totalCommentCount: 20, onLoadOlder: async () => {} });
    expect(olderButton(none.target)).toBeUndefined();
  });

  it('then follows the server answer: no more means no button, whatever the count says', () => {
    const { target } = mountThread({
      rows: 20,
      totalCommentCount: 30, // threads by blocked accounts are counted and never served
      hasMoreComments: false,
      onLoadOlder: async () => {},
    });
    expect(olderButton(target)).toBeUndefined();
  });

  it('is offered while the server says there is more, even when the count looks complete', () => {
    const { target } = mountThread({
      rows: 20,
      totalCommentCount: 20,
      hasMoreComments: true,
      onLoadOlder: async () => {},
    });
    expect(olderButton(target)).toBeDefined();
  });

  it('asks for the next page on a tap, and says so while the page is on its way', () => {
    const onLoadOlder = vi.fn(async () => {});
    const { target, props } = mountThread({ rows: 20, hasMoreComments: true, onLoadOlder });
    olderButton(target)!.click();
    expect(onLoadOlder).toHaveBeenCalledOnce();

    props.loadingMore = true;
    flushSync();
    const loading = [...target.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === m.common_loading_label()
    );
    expect(loading?.disabled).toBe(true);
  });
});

describe('a sort about the whole thread', () => {
  it('reads every remaining page before it sorts "oldest"', async () => {
    let page = 0;
    const onLoadOlder = vi.fn(
      async (props: { comments: PostComment[]; hasMoreComments?: boolean }) => {
        page++;
        props.comments = [...props.comments, comment(100 + page), comment(200 + page)];
        props.hasMoreComments = page < 3;
      }
    );
    const { target } = mountThread({ rows: 20, hasMoreComments: true, onLoadOlder });

    sortButton(target, m.post_sort_oldest_label()).click();
    await settle();

    expect(onLoadOlder).toHaveBeenCalledTimes(3);
    expect(olderButton(target)).toBeUndefined();
  });

  it('reads nothing for "recent", the order the pages come in', async () => {
    const onLoadOlder = vi.fn(async () => {});
    const { target } = mountThread({ rows: 20, hasMoreComments: true, onLoadOlder });

    sortButton(target, m.post_sort_recent_label()).click();
    await settle();

    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it('stops waiting when a page brought nothing - a failure the host already said', async () => {
    const onLoadOlder = vi.fn(async () => {}); // the rows do not grow
    const { target } = mountThread({ rows: 20, hasMoreComments: true, onLoadOlder });

    sortButton(target, m.post_sort_liked_label()).click();
    await settle();

    expect(onLoadOlder).toHaveBeenCalledOnce();
  });
});
