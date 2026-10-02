import { beforeEach, describe, expect, it } from 'vitest';
import {
  rememberKeyboardHeight,
  rememberedKeyboardHeight,
  resetKeyboardHeightMemoryForTests,
} from './keyboardHeightMemory';

describe('keyboardHeightMemory', () => {
  beforeEach(() => resetKeyboardHeightMemoryForTests());

  it('knows nothing before a keyboard was seen', () => {
    expect(rememberedKeyboardHeight('portrait')).toBeNull();
  });

  it('keeps the LATEST height, per orientation', () => {
    rememberKeyboardHeight(300, 'portrait');
    rememberKeyboardHeight(336.4, 'portrait');
    rememberKeyboardHeight(200, 'landscape');
    expect(rememberedKeyboardHeight('portrait')).toBe(336);
    expect(rememberedKeyboardHeight('landscape')).toBe(200);
  });

  it('survives a restart through localStorage', () => {
    rememberKeyboardHeight(320, 'portrait');
    const stored = localStorage.getItem('canari.keyboardHeight.v1');
    resetKeyboardHeightMemoryForTests();
    localStorage.setItem('canari.keyboardHeight.v1', stored ?? '');
    expect(rememberedKeyboardHeight('portrait')).toBe(320);
  });
});
