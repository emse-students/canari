// @vitest-environment happy-dom
/**
 * MINESWEEPER SETTINGS (2026-11-04): per-device, validated field by field. Pinned: the defaults are
 * the behaviour before the settings existed, a round trip keeps every field, one corrupted field
 * falls back alone, the long-press delay snaps into its range, and a missing `animations` follows the
 * system's reduced-motion preference.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  animationMs,
  clampLongPressMs,
  loadMinesweeperSettings,
  saveMinesweeperSettings,
} from './settings';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('minesweeper settings', () => {
  it('defaults to the behaviour of before the settings existed', () => {
    expect(loadMinesweeperSettings()).toEqual({
      doubleTapZoom: true,
      longPressMs: 350,
      haptics: true,
      animations: 'normal',
    });
  });

  it('round-trips every field', () => {
    const chosen = {
      doubleTapZoom: false,
      longPressMs: 500,
      haptics: false,
      animations: 'fast' as const,
    };
    saveMinesweeperSettings(chosen);
    expect(loadMinesweeperSettings()).toEqual(chosen);
  });

  it('keeps the good fields when one is corrupted', () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ doubleTapZoom: false, longPressMs: 'slow', haptics: 3, animations: 'warp' })
    );
    expect(loadMinesweeperSettings()).toEqual({ ...DEFAULT_SETTINGS, doubleTapZoom: false });
  });

  it('survives unparsable storage', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, '{nope');
    expect(loadMinesweeperSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('snaps the long-press delay into 200-600 ms in steps of 50', () => {
    expect(clampLongPressMs(10)).toBe(200);
    expect(clampLongPressMs(9999)).toBe(600);
    expect(clampLongPressMs(372)).toBe(350);
    expect(clampLongPressMs(NaN)).toBe(350);
    expect(clampLongPressMs(undefined)).toBe(350);
  });

  it('scales a duration by the animation speed, and zeroes it when off', () => {
    expect(animationMs(220, 'normal')).toBe(220);
    expect(animationMs(220, 'fast')).toBe(110);
    expect(animationMs(220, 'off')).toBe(0);
  });

  it('defaults animations to off when the system asks for reduced motion, unless the player chose', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(loadMinesweeperSettings().animations).toBe('off');
    saveMinesweeperSettings({ ...DEFAULT_SETTINGS, animations: 'normal' });
    expect(loadMinesweeperSettings().animations).toBe('normal');
    vi.unstubAllGlobals();
  });
});
