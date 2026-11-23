// @vitest-environment happy-dom
/**
 * THE REEL'S COMMENT SHEET PASSES THE SERVER'S READINGS TO ITS THREAD: a muted reader is served
 * `canLikeComments: false` (decision 9 of the moderation authority), and a moderator reading outside
 * their audience `canParticipate: false`. Without them the sheet drew a live heart and a refusal
 * followed the tap.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ReelCommentsSheet from './ReelCommentsSheet.svelte';
import type { PostEntity } from '$lib/posts/api';

vi.mock('$lib/components/posts/PostComments.svelte', async () => ({
  default: (await import('./PostCommentsPropsStub.test-helper.svelte')).default,
}));
vi.mock('$lib/components/shared/CommentsDrawer.svelte', async () => ({
  default: (await import('./DrawerPassThroughStub.test-helper.svelte')).default,
}));
vi.mock('$lib/components/moderation/ReportReasonDialog.svelte', async () => ({
  default: (await import('./DrawerPassThroughStub.test-helper.svelte')).default,
}));

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function stubFor(extra: Partial<PostEntity>): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(ReelCommentsSheet, {
    target,
    props: {
      post: { id: 'p1', comments: [], ...extra } as unknown as PostEntity,
      currentUserId: 'u1',
      authToken: 'tok',
      onChange: () => {},
      onClose: () => {},
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return target.querySelector<HTMLElement>('[data-comments-stub]')!;
}

describe('ReelCommentsSheet', () => {
  it('draws the like disabled for a reader served canLikeComments false', () => {
    expect(stubFor({ canLikeComments: false }).dataset.canLike).toBe('false');
  });

  it('draws the thread read-only for a reader served canParticipate false', () => {
    expect(stubFor({ canParticipate: false }).dataset.readOnly).toBe('true');
  });

  it('CONTROL: a reader served nothing (an older server) keeps both open', () => {
    const el = stubFor({});
    expect(el.dataset.canLike).toBe('true');
    expect(el.dataset.readOnly).toBe('false');
  });
});
