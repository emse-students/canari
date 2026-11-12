/**
 * The CanaReels order ("Nos principes", owner 2026-11-10): Pour toi by default, Récents when chosen,
 * remembered per device, and a stored value that names no order read as the default.
 */
import { beforeEach, expect, it } from 'vitest';
import { settings } from '$lib/stores/settingsStore.svelte';
import {
  DEFAULT_REEL_ORDER,
  parseReelOrder,
  preferredReelOrder,
  rememberReelOrder,
} from './reelOrder';

beforeEach(() => settings.setReelsOrder(''));

it('a reader who never chose opens Pour toi', () => {
  expect(DEFAULT_REEL_ORDER).toBe('ranked');
  expect(preferredReelOrder()).toBe('ranked');
});

it('the chosen order is remembered', () => {
  rememberReelOrder('recent');
  expect(settings.reelsOrder).toBe('recent');
  expect(preferredReelOrder()).toBe('recent');
});

it('a stored value that names no order is not an order', () => {
  expect(parseReelOrder('chronological')).toBeNull();
  expect(parseReelOrder(null)).toBeNull();
  expect(parseReelOrder('recent')).toBe('recent');
});
