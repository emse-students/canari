// @vitest-environment happy-dom
/**
 * A SCHEDULED POST IS DRAWN FOR ITS EDITORS AS A "NOT FINAL" CARD (owner, 2026-11-13): the dashed,
 * dimmed ring of a proposed event, a "Publication prevue le <date>" line, and none of what needs
 * readers - no reaction bar, no comment button or preview. Its menu keeps "Modifier" and
 * "Supprimer"; a published card is unchanged.
 */
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PostCard from './PostCard.svelte';
import type { PostEntity } from '$lib/posts/api';
import { apiFetch } from '$lib/utils/apiFetch';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

vi.mock('$lib/utils/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/apiFetch')>()),
  apiFetch: vi.fn(),
}));

const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.mocked(apiFetch).mockImplementation(() => new Promise(() => {}));
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

const row = (extra: Partial<PostEntity> = {}): PostEntity => ({
  id: 'p1',
  markdown: 'announced for later',
  mentions: [],
  links: [],
  media: [],
  images: [],
  reactions: {},
  polls: [],
  createdAt: '2026-11-04T08:00:00.000Z',
  publishedAt: '2026-12-01T08:00:00.000Z',
  scheduledAt: '2026-12-01T08:00:00.000Z',
  updatedAt: '2026-11-04T08:00:00.000Z',
  canEdit: true,
  canManage: true,
  ...extra,
});

function mountCard(post: PostEntity, scheduled: boolean) {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(PostCard, {
    target,
    props: { post, currentUserId: 'editor', scheduled },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  return target;
}

const commentButton = (t: HTMLElement) =>
  t.querySelector(`button[aria-label="${m.post_commenter()}"]`);

it('draws the dashed ring, the publication line, and no reaction or comment control', () => {
  const t = mountCard(row({ commentCount: 2 }), true);
  const ring = t.querySelector('[data-scheduled-post="true"]') as HTMLElement | null;
  expect(ring).not.toBeNull();
  expect(ring!.getAttribute('style')).toContain('dashed');
  expect(t.textContent).toContain(m.post_scheduled_on_label({ date: '' }).trim().split(' ')[0]);
  expect(commentButton(t)).toBeNull();
  expect(t.textContent).toContain('announced for later');
});

it('keeps the menu, where Modifier and Supprimer live', () => {
  const t = mountCard(row(), true);
  expect(t.querySelector(`button[aria-label="${m.post_more_actions_label()}"]`)).not.toBeNull();
});

it('leaves a published post untouched: no ring, no line, the comment button', () => {
  const t = mountCard(row({ scheduledAt: null }), false);
  expect(t.querySelector('[data-scheduled-post]')).toBeNull();
  expect(commentButton(t)).not.toBeNull();
});
