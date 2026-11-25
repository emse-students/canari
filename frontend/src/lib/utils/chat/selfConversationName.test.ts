import { afterEach, describe, expect, it } from 'vitest';
import { getLocale, setLocale } from '$lib/paraglide/runtime';
import {
  matchesSelfConversationAlias,
  selfConversationMatchesQuery,
  selfConversationTitle,
} from './conversations';
import { missingPeerNameIds, shareCandidates } from '$lib/sharing/shareDestinations';
import { notificationGroupName } from '$lib/utils/nativeNotification';

const ME = 'b2'.repeat(32);
const initial = getLocale();
afterEach(() => setLocale(initial, { reload: false }));

describe('the title of "Mes notes" - the own name and a localized suffix', () => {
  it.each(['fr', 'en'] as const)('ends with the suffix and names the account in %s', (locale) => {
    setLocale(locale, { reload: false });
    const title = selfConversationTitle('Camille DUPONT');
    expect(title).toBe('Camille DUPONT (Notes)');
    expect(title.endsWith(' (Notes)')).toBe(true);
    expect(title).not.toContain('Mes notes');
    // the notification names the conversation with the same shape as the row
    expect(notificationGroupName('self', '', '', null, ME).endsWith(' (Notes)')).toBe(true);
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

describe('the pickers title "Mes notes" with the own name once it arrives', () => {
  const convo = { id: 'g-self', name: '', conversationType: 'self', lifecycle: 'active' } as never;
  const input = (peerNames: Record<string, string>) => ({
    conversations: [['k', convo]] as [string, never][],
    currentUserId: ME,
    workspaces: [],
    peerNames,
    query: 'zoe',
    order: 'recent' as const,
  });

  it('asks for the own name like a peer, and the late answer makes the row findable', () => {
    expect(missingPeerNameIds([['k', convo]], ME)).toEqual([ME]);
    expect(shareCandidates(input({}))).toEqual([]);
    const rows = shareCandidates(input({ [ME]: 'Zoe MARTIN' }));
    expect(rows.map((r) => r.label)).toEqual(['Zoe MARTIN (Notes)']);
  });
});
