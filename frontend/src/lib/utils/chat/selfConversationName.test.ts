import { afterEach, describe, expect, it } from 'vitest';
import { getLocale, setLocale } from '$lib/paraglide/runtime';
import {
  matchesSelfConversationAlias,
  selfConversationMatchesQuery,
  selfConversationTitle,
} from './conversations';
import { notificationGroupName } from '$lib/utils/nativeNotification';

const ME = 'b2'.repeat(32);
const initial = getLocale();
afterEach(() => setLocale(initial, { reload: false }));

describe('the title of "Mes notes" - the own name and a localized suffix', () => {
  it.each(['fr', 'en'] as const)('ends with the suffix and names the account in %s', (locale) => {
    setLocale(locale, { reload: false });
    const title = selfConversationTitle(ME);
    expect(title.endsWith(' (Notes)')).toBe(true);
    expect(title).not.toContain('Mes notes');
    // the notification names the conversation with the same title as the row
    expect(notificationGroupName('self', '', '', null, ME)).toBe(title);
  });
});

describe('the search of "Mes notes"', () => {
  it.each(['fr', 'en'] as const)(
    'still answers to the old words in %s, accents folded',
    (locale) => {
      setLocale(locale, { reload: false });
      for (const q of ['notes', 'Mes notes', 'my notes', 'NOTE']) {
        expect(matchesSelfConversationAlias(q)).toBe(true);
        expect(selfConversationMatchesQuery('Camille DUPONT (Notes)', '', q)).toBe(true);
      }
      expect(matchesSelfConversationAlias('budget')).toBe(false);
      expect(matchesSelfConversationAlias('  ')).toBe(false);
    }
  );

  it('is found by any part of the own name, like a person', () => {
    expect(selfConversationMatchesQuery('Camille DUPONT (Notes)', '', 'camille')).toBe(true);
    expect(selfConversationMatchesQuery('Camille DUPONT (Notes)', '', 'dupont')).toBe(true);
    expect(selfConversationMatchesQuery('Camille DUPONT (Notes)', '', 'zzz')).toBe(false);
  });
});
