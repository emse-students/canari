/**
 * "Lecture automatique des vidéos" (owner, 2026-11-10): Toujours by default, Jamais never starts a
 * feed video, and Wi-Fi only starts one on a link the engine REPORTS as Wi-Fi or Ethernet. Where the
 * engine reports no link (iOS, Safari, Firefox), Wi-Fi is not offered, and a stored "wifi" applies -
 * and is drawn - as Jamais (owner, 2026-11-11).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { settings } from '$lib/stores/settingsStore.svelte';
import {
  DEFAULT_VIDEO_AUTOPLAY,
  feedAutoplayAllowed,
  feedAutoplayPermitted,
  networkType,
  networkTypeKnown,
  offeredVideoAutoplayModes,
  parseVideoAutoplay,
  videoAutoplayMode,
} from './autoplayPolicy';

/** A Network Information connection object, as Chromium exposes it. */
class Connection extends EventTarget {
  constructor(public type: string) {
    super();
  }
}

function linkType(type: string | undefined) {
  vi.stubGlobal('navigator', {
    connection: type === undefined ? undefined : new Connection(type),
  });
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

  it('a stored wifi on a device that reports no link applies as never', () => {
    linkType(undefined);
    settings.setVideoAutoplay('wifi');
    expect(videoAutoplayMode()).toBe('never');
    linkType('cellular');
    expect(videoAutoplayMode()).toBe('wifi');
  });
});

describe('the choices offered', () => {
  it('all three where the device tells its link, no Wi-Fi where it cannot', () => {
    linkType('wifi');
    expect(offeredVideoAutoplayModes()).toEqual(['always', 'wifi', 'never']);
    linkType(undefined);
    expect(offeredVideoAutoplayModes()).toEqual(['always', 'never']);
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

  it('the gate follows the setting and the live link, a change event included', () => {
    settings.setVideoAutoplay('wifi');
    const connection = new Connection('wifi');
    vi.stubGlobal('navigator', { connection });
    expect(feedAutoplayAllowed()).toBe(true);
    connection.type = 'cellular';
    connection.dispatchEvent(new Event('change'));
    expect(feedAutoplayAllowed()).toBe(false);
  });
});
