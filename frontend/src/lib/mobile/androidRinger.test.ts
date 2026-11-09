// @vitest-environment happy-dom
/**
 * ON ANDROID AN APP TONE PLAYS ONLY AT THE NORMAL RINGER MODE (2026-11-04).
 *
 * Pinned: silent and vibrate silence the tones, normal and an unknown mode do not; a missing
 * bridge or a throwing one never silences and is said at error level (the bridge's absence once);
 * off Android the bridge is never asked.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ android: true }));
vi.mock('$lib/utils/appVersion', () => ({ isAndroidTauriRuntime: () => platform.android }));

import {
  RINGER_MODE_NORMAL,
  RINGER_MODE_SILENT,
  RINGER_MODE_UNREADABLE,
  RINGER_MODE_VIBRATE,
  resetAndroidRingerForTest,
  ringerSilencesAppTones,
} from './androidRinger';

function bridge(mode: () => number) {
  const ringerMode = vi.fn(mode);
  Object.defineProperty(window, 'canariAudio', { configurable: true, value: { ringerMode } });
  return ringerMode;
}

beforeEach(() => {
  platform.android = true;
  resetAndroidRingerForTest();
});

afterEach(() => {
  Reflect.deleteProperty(window, 'canariAudio');
  vi.restoreAllMocks();
});

it('silent and vibrate silence the app tones', () => {
  bridge(() => RINGER_MODE_SILENT);
  expect(ringerSilencesAppTones()).toBe(true);
  bridge(() => RINGER_MODE_VIBRATE);
  expect(ringerSilencesAppTones()).toBe(true);
});

it('normal plays them, and so does a mode this code has never met - said ONCE, not per tone', () => {
  bridge(() => RINGER_MODE_NORMAL);
  expect(ringerSilencesAppTones()).toBe(false);
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  bridge(() => 7);
  expect(ringerSilencesAppTones()).toBe(false);
  expect(ringerSilencesAppTones()).toBe(false);
  const said = [...info.mock.calls, ...log.mock.calls].filter((c) =>
    c.some((part) => String(part).includes('unknown ringer mode 7'))
  );
  expect(said.length).toBeLessThanOrEqual(1);
});

it('a mode the native side could not read plays the tone, said once at error level', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  bridge(() => RINGER_MODE_UNREADABLE);
  expect(ringerSilencesAppTones()).toBe(false);
  expect(ringerSilencesAppTones()).toBe(false);
  expect(error).toHaveBeenCalledTimes(1);
});

it('reads the mode at every tone, never a cached value', () => {
  let mode = RINGER_MODE_NORMAL;
  const read = bridge(() => mode);
  expect(ringerSilencesAppTones()).toBe(false);
  mode = RINGER_MODE_SILENT;
  expect(ringerSilencesAppTones()).toBe(true);
  expect(read).toHaveBeenCalledTimes(2);
});

it('a missing bridge never silences, and is said once at error level', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(ringerSilencesAppTones()).toBe(false);
  expect(ringerSilencesAppTones()).toBe(false);
  expect(error).toHaveBeenCalledTimes(1);
});

it('a throwing bridge never silences, and is said', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  bridge(() => {
    throw new Error('binder died');
  });
  expect(ringerSilencesAppTones()).toBe(false);
  expect(error).toHaveBeenCalledTimes(1);
});

it('off Android the bridge is never asked', () => {
  platform.android = false;
  const read = bridge(() => RINGER_MODE_SILENT);
  expect(ringerSilencesAppTones()).toBe(false);
  expect(read).not.toHaveBeenCalled();
});
