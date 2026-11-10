/**
 * "Lecture automatique des vidéos" (owner, 2026-11-10): Toujours by default, Jamais never starts a
 * feed video, and Wi-Fi only starts one on a link the engine REPORTS as Wi-Fi or Ethernet - an
 * engine that reports nothing (iOS, Safari, Firefox) is not guessed to be on Wi-Fi.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { settings } from '$lib/stores/settingsStore.svelte';
import {
  DEFAULT_VIDEO_AUTOPLAY,
  feedAutoplayAllowed,
  feedAutoplayPermitted,
  networkType,
  networkTypeKnown,
  parseVideoAutoplay,
  videoAutoplayMode,
} from './autoplayPolicy';

function linkType(type: string | undefined) {
  vi.stubGlobal('navigator', { connection: type === undefined ? undefined : { type } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  settings.setVideoAutoplay('');
});

describe('the mode', () => {
  it('a device that never chose plays always', () => {
    expect(DEFAULT_VIDEO_AUTOPLAY).toBe('always');
    expect(parseVideoAutoplay(null)).toBe('always');
    expect(parseVideoAutoplay('sometimes')).toBe('always');
    expect(videoAutoplayMode()).toBe('always');
  });

  it('the stored choice is the mode', () => {
    settings.setVideoAutoplay('never');
    expect(videoAutoplayMode()).toBe('never');
  });
});

describe('the decision', () => {
  it('always and never do not read the link', () => {
    expect(feedAutoplayPermitted('always', null)).toBe(true);
    expect(feedAutoplayPermitted('never', 'wifi')).toBe(false);
  });

  it('wifi plays on Wi-Fi and Ethernet only', () => {
    expect(feedAutoplayPermitted('wifi', 'wifi')).toBe(true);
    expect(feedAutoplayPermitted('wifi', 'ethernet')).toBe(true);
    expect(feedAutoplayPermitted('wifi', 'cellular')).toBe(false);
  });

  it('an unknown link is not Wi-Fi', () => {
    expect(feedAutoplayPermitted('wifi', null)).toBe(false);
  });
});

describe('the link', () => {
  it('reads the Network Information type where the engine has one', () => {
    linkType('cellular');
    expect(networkType()).toBe('cellular');
    expect(networkTypeKnown()).toBe(true);
  });

  it('is unknown where the engine reports none', () => {
    linkType(undefined);
    expect(networkType()).toBeNull();
    expect(networkTypeKnown()).toBe(false);
  });

  it('the gate follows the setting and the live link', () => {
    settings.setVideoAutoplay('wifi');
    linkType('wifi');
    expect(feedAutoplayAllowed()).toBe(true);
    linkType('cellular');
    expect(feedAutoplayAllowed()).toBe(false);
  });
});
