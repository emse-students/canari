// @vitest-environment happy-dom
/**
 * THE "ENTRE ÉTUDIANTS" CHIP IS ON THE CARD FOR EVERY READER (owner, 2026-11-04, decision 8): the
 * server serves `studentsOnly` to everyone who may read the post, the author and a republisher
 * included, and the header draws it from that field alone.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PostHeader from './PostHeader.svelte';
import type { PostEntity } from '$lib/posts/api';
import { m } from '$lib/paraglide/messages';

vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplay: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplay: () => {},
}));

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function header(studentsOnly: boolean | undefined) {
  const post: PostEntity = {
    id: 'p1',
    markdown: 'la soirée',
    mentions: [],
    links: [],
    media: [],
    images: [],
    polls: [],
    associationId: 'list-1',
    association: { id: 'list-1', name: 'Liste Kraken', slug: 'kraken', logoUrl: null },
    republishedBy: [{ id: 'bde', name: 'BDE', slug: 'bde', logoUrl: null }],
    createdAt: new Date().toISOString(),
    publishedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(studentsOnly === undefined ? {} : { studentsOnly }),
  } as PostEntity;
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(PostHeader, { target, props: { post } });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

describe('PostHeader - the "Entre étudiants" chip', () => {
  it('is drawn, republished or not, with who may read it in its title', () => {
    const chip = header(true).querySelector('[data-students-only-chip]');
    expect(chip?.textContent?.trim()).toBe(m.post_students_only_chip());
    expect(chip?.getAttribute('title')).toBe(m.post_students_only_chip_title());
  });

  it('is absent from an open post, and from a server older than the field', () => {
    expect(header(false).querySelector('[data-students-only-chip]')).toBeNull();
    expect(header(undefined).querySelector('[data-students-only-chip]')).toBeNull();
  });
});
