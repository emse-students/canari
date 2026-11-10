/**
 * WHERE A SUGGESTED POST GOES IN MON ESPACE, AND HOW IT IS READ (engagement WP-7, L13): at most one
 * in every 8 items, never two in a row, never a post the page already shows, never the page's last
 * item; read once per reader, and forgotten when the reader changes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listSuggestedPosts = vi.fn();
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'me' }));
vi.mock('./api', () => ({ listSuggestedPosts: () => listSuggestedPosts() }));

import type { PostEntity } from './api';
import {
  SUGGESTED_POST_EVERY,
  ensureSuggestedPosts,
  forgetSuggestedPost,
  placeSuggestedPosts,
  resetSuggestedPosts,
  suggestedPosts,
} from './suggestedPosts.svelte';

const post = (id: string) => ({ id }) as PostEntity;
const feed = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);

describe('placeSuggestedPosts', () => {
  it('one after every 7 feed posts: at most one in 8 items, never two in a row', () => {
    expect(SUGGESTED_POST_EVERY).toBe(8);
    const placed = placeSuggestedPosts(feed(30), ['a', 'b', 'c', 'd', 'e'].map(post));
    expect(Object.keys(placed).map(Number)).toEqual([6, 13, 20, 27]);
    expect(Object.values(placed).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a suggestion never ends the page: 7 feed posts carry none, 8 carry one', () => {
    expect(placeSuggestedPosts(feed(7), [post('a')])).toEqual({});
    expect(Object.keys(placeSuggestedPosts(feed(8), [post('a')]))).toEqual(['6']);
  });

  it('a post the feed already shows is skipped, the next suggestion takes its slot', () => {
    const placed = placeSuggestedPosts(['x', ...feed(20)], [post('x'), post('a')]);
    expect(Object.values(placed).map((p) => p.id)).toEqual(['a']);
  });

  it('no suggestions, no slots', () => {
    expect(placeSuggestedPosts(feed(30), [])).toEqual({});
  });
});

describe('the per-reader read', () => {
  beforeEach(() => {
    resetSuggestedPosts();
    listSuggestedPosts.mockReset();
  });

  it('is asked once, and a removed post leaves at once', async () => {
    listSuggestedPosts.mockResolvedValue([post('a'), post('b')]);
    ensureSuggestedPosts();
    ensureSuggestedPosts();
    await vi.waitFor(() => expect(suggestedPosts().map((p) => p.id)).toEqual(['a', 'b']));
    expect(listSuggestedPosts).toHaveBeenCalledTimes(1);
    forgetSuggestedPost('a');
    expect(suggestedPosts().map((p) => p.id)).toEqual(['b']);
  });

  it('an answer that left for the previous reader is dropped', async () => {
    let resolve!: (v: PostEntity[]) => void;
    listSuggestedPosts.mockReturnValue(new Promise((r) => (resolve = r)));
    ensureSuggestedPosts();
    resetSuggestedPosts();
    resolve([post('a')]);
    await Promise.resolve();
    await Promise.resolve();
    expect(suggestedPosts()).toEqual([]);
  });

  it('a failed read is a warning and is not asked again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listSuggestedPosts.mockRejectedValue(new Error('down'));
    ensureSuggestedPosts();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    ensureSuggestedPosts();
    expect(listSuggestedPosts).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
