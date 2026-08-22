import { describe, expect, it } from 'vitest';
import { conversationMatchesQuery } from './conversations';

/**
 * The regression these pin is not "does includes() work" - it is WHICH NAME the sidebar compares.
 * It compared `convo.name`, the persisted `userId::peerId` key, so a DM could only ever be found by
 * its last message. SEARCH-6 caught it: current last message matched, the conversation name did not.
 */
describe('conversationMatchesQuery', () => {
  const KEY = 'a1b2c3d4e5f6::f6e5d4c3b2a1'; // what convo.name actually holds for a DM

  it('keeps every row on an empty or blank query - a filter narrows, it does not build', () => {
    expect(conversationMatchesQuery('Camille Dupont', 'salut', '')).toBe(true);
    expect(conversationMatchesQuery('Camille Dupont', 'salut', '   ')).toBe(true);
  });

  it('finds a DM by the name the row DISPLAYS - the defect SEARCH-6 caught', () => {
    expect(conversationMatchesQuery('Camille Dupont', 'salut', 'camille')).toBe(true);
    // ...and the persisted key it used to compare instead is not what the user can see.
    expect(conversationMatchesQuery(KEY, 'salut', 'camille')).toBe(false);
  });

  it('finds a row by its last-message preview', () => {
    expect(conversationMatchesQuery('Camille Dupont', 'le budget de la reunion', 'budget')).toBe(
      true
    );
  });

  it('matches on a partial name and ignores case on both sides', () => {
    expect(conversationMatchesQuery('Camille Dupont', '', 'DUP')).toBe(true);
    expect(conversationMatchesQuery('CAMILLE DUPONT', '', 'dup')).toBe(true);
  });

  it('does not match what is in neither the name nor the preview', () => {
    expect(conversationMatchesQuery('Camille Dupont', 'salut', 'zz-nonexistent')).toBe(false);
  });

  it('tolerates a row with no last message', () => {
    expect(conversationMatchesQuery('Camille Dupont', '', 'camille')).toBe(true);
    expect(conversationMatchesQuery('Camille Dupont', '', 'salut')).toBe(false);
  });

  it('trims the query, so a trailing space does not empty the list', () => {
    expect(conversationMatchesQuery('Camille Dupont', '', 'camille ')).toBe(true);
  });
});
