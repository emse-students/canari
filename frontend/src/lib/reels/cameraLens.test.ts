// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAMERA_LENS_KEY, recallLens, rememberLens } from './cameraLens';

describe('the lens memory', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reads the front lens when nothing is stored, without accusing anything', () => {
    expect(recallLens()).toBe('user');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('returns what was remembered, both lenses', () => {
    rememberLens('environment');
    expect(recallLens()).toBe('environment');
    rememberLens('user');
    expect(recallLens()).toBe('user');
  });

  it('falls back to the front lens, warning, on a value that is no lens', () => {
    localStorage.setItem(CAMERA_LENS_KEY, 'wide');
    expect(recallLens()).toBe('user');
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('falls back to the front lens, warning, when the store throws on read', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    expect(recallLens()).toBe('user');
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('warns and does not throw when the store refuses a write', () => {
    vi.stubGlobal('localStorage', {
      setItem: () => {
        throw new Error('quota');
      },
    });
    expect(() => rememberLens('environment')).not.toThrow();
    expect(console.warn).toHaveBeenCalledOnce();
  });
});
