/**
 * "Défilement infini des CanaReels" (owner, 2026-11-10): on, a feed video's viewer builds the
 * CanaReels list itself (`undefined`); off, it is handed the list that ends at the opened post.
 */
import { afterEach, expect, it } from 'vitest';
import { settings } from '$lib/stores/settingsStore.svelte';
import { NO_FURTHER_REELS } from './allReels';
import { feedReelLoader } from './infiniteReels';

afterEach(() => settings.setInfiniteReelsEnabled(true));

it('is on by default: the viewer goes on to the CanaReels list', () => {
  expect(settings.infiniteReelsEnabled).toBe(true);
  expect(feedReelLoader()).toBeUndefined();
});

it('off, the viewer stops at the opened post', () => {
  settings.setInfiniteReelsEnabled(false);
  expect(feedReelLoader()).toBe(NO_FURTHER_REELS);
});
