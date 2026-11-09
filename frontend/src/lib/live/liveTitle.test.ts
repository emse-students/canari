import { describe, expect, it } from 'vitest';
import { clampLiveTitleInput, liveTitleLength, liveTitleToSend } from './liveTitle';

describe('a live title, client side', () => {
  it('counts characters as the server does: code points, so an emoji is one', () => {
    expect(liveTitleLength('Soirée')).toBe(6);
    expect(liveTitleLength('🐤🐤')).toBe(2);
  });

  it('cuts the field at the bound without splitting a character, and keeps it one line', () => {
    expect(clampLiveTitleInput('🐤'.repeat(81), 80)).toBe('🐤'.repeat(80));
    expect(clampLiveTitleInput('ligne\nautre', 80)).toBe('ligne autre');
    expect(clampLiveTitleInput('court', 80)).toBe('court');
  });

  it('sends a trimmed title, and blank as none', () => {
    expect(liveTitleToSend('  Soirée ')).toBe('Soirée');
    expect(liveTitleToSend('   ')).toBeNull();
  });
});
