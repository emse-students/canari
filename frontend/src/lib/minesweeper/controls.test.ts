// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLAG_PRIMARY_STORAGE_KEY, loadFlagPrimary, saveFlagPrimary } from './controls';

describe('the stored gestures', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('is unknown until the player chooses, so the tutorial can ask', () => {
    expect(loadFlagPrimary()).toBeNull();
  });

  it('keeps the choice under the key the game reads', () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    saveFlagPrimary(true);
    expect(localStorage.getItem(FLAG_PRIMARY_STORAGE_KEY)).toBe('1');
    expect(loadFlagPrimary()).toBe(true);
    saveFlagPrimary(false);
    expect(loadFlagPrimary()).toBe(false);
  });

  it('treats an unreadable value as no choice', () => {
    localStorage.setItem(FLAG_PRIMARY_STORAGE_KEY, 'maybe');
    expect(loadFlagPrimary()).toBeNull();
  });
});
