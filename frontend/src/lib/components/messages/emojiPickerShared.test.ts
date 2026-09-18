import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import enI18n from 'emoji-picker-element/i18n/en';

import { getLocale, locales, overwriteGetLocale } from '$lib/paraglide/runtime';

import { emojiPickerI18n, getRecentEmojis, persistRecentEmoji } from './emojiPickerShared';

const realLocale = getLocale();
afterAll(() => overwriteGetLocale(() => realLocale));

/** Builds the table as a client with that locale would, and puts the locale back either way. */
function asLocale<T>(locale: (typeof locales)[number], read: () => T): T {
  overwriteGetLocale(() => locale);
  try {
    return read();
  } finally {
    overwriteGetLocale(() => realLocale);
  }
}

/**
 * A MISSING KEY HERE IS A CRASH, NOT A MISSING WORD - and it has been one, in production, on every
 * reaction: `emoji-picker-element` calls `.replace()` on `skinToneLabel` inside its own effect, so
 * the thirteen-of-fourteen table we used to hand-write threw from inside the library, with no stack
 * frame naming us. Spreading its defaults is what makes absence impossible; this asserts that the
 * spread is still there, in BOTH locales, rather than trusting the next reader to notice.
 */
describe('the table handed to the picker is complete, in whichever locale is live', () => {
  it('carries every key the library itself defines', () => {
    for (const locale of locales) {
      const i18n: Record<string, unknown> = asLocale(locale, emojiPickerI18n);
      for (const key of Object.keys(enI18n)) {
        expect(i18n[key], `${locale} is missing ${key}`).toBeDefined();
      }
    }
  });

  /**
   * The table used to be two constants and a `getLocale()` branch, which froze nothing because it
   * was read per call - but a constant built from `m.*()` WOULD freeze at import. Reading it twice
   * under two locales is what separates the two shapes.
   */
  it('answers the locale live at the call, not the one live at import', () => {
    expect(asLocale('fr', emojiPickerI18n).searchLabel).toBe('Recherche');
    expect(asLocale('en', emojiPickerI18n).searchLabel).toBe('Search');
  });

  it('keeps the same category keys and skin-tone count in both locales', () => {
    const fr = asLocale('fr', emojiPickerI18n);
    const en = asLocale('en', emojiPickerI18n);

    expect(Object.keys(fr.categories)).toEqual(Object.keys(en.categories));
    expect(fr.skinTones).toHaveLength(en.skinTones.length);
    expect(fr.categories['food-drink']).toBe('Nourriture et boissons');
    expect(en.categories['food-drink']).toBe('Food & Drink');
  });
});

describe('recent emoji, shared between the reaction picker and the composer', () => {
  beforeEach(() => localStorage.clear());

  it('starts empty with nothing persisted', () => {
    expect(getRecentEmojis()).toEqual([]);
  });

  it('reads back what it just persisted, newest first', () => {
    persistRecentEmoji('😀');
    persistRecentEmoji('🎉');
    expect(getRecentEmojis()).toEqual(['🎉', '😀']);
  });

  it('deduplicates: re-picking an emoji moves it to the front instead of repeating it', () => {
    persistRecentEmoji('😀');
    persistRecentEmoji('🎉');
    persistRecentEmoji('😀');
    expect(getRecentEmojis()).toEqual(['😀', '🎉']);
  });

  it('caps at 12, dropping the oldest', () => {
    const emojis = ['😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆', '😉', '😊', '😋', '😎', '😍'];
    for (const e of emojis) persistRecentEmoji(e);
    const recent = getRecentEmojis();
    expect(recent).toHaveLength(12);
    expect(recent[0]).toBe('😍');
    expect(recent).not.toContain('😀'); // the 13th pick, and first, pushed out
  });

  it('answers empty rather than throwing when storage holds garbage', () => {
    localStorage.setItem('canari_recent_emojis', 'not json');
    expect(getRecentEmojis()).toEqual([]);
    localStorage.setItem('canari_recent_emojis', JSON.stringify({ not: 'an array' }));
    expect(getRecentEmojis()).toEqual([]);
  });
});
