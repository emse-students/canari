/**
 * "Défilement infini des CanaReels" (owner, 2026-11-10): on, a feed video's viewer goes on to the
 * CanaReels stream; off, it ends at the opened post.
 */
import { afterEach, expect, it } from 'vitest';
import { settings } from '$lib/stores/settingsStore.svelte';
import { feedReelsContinue } from './infiniteReels';

afterEach(() => settings.setInfiniteReelsEnabled(true));

it('is on by default: the viewer goes on to the CanaReels stream', () => {
  expect(settings.infiniteReelsEnabled).toBe(true);
  expect(feedReelsContinue()).toBe(true);
});

it('off, the viewer stops at the opened post', () => {
  settings.setInfiniteReelsEnabled(false);
  expect(feedReelsContinue()).toBe(false);
});
