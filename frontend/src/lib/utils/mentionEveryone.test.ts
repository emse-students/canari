/**
 * `@tous` (owner, 2026-11-25): its recognition, its bubble chip and its picker row. The decision it
 * feeds is asserted against the shared contract in `conversationLevel.contract.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { mentionsEveryone } from './mentions';
import { formatMentionsForPreview, splitTextWithMentions } from './mentions.parse';
import {
  MENTION_EVERYONE_ROW_ID,
  withEveryoneRow,
} from '$lib/composables/useMentionAutocomplete.svelte';

describe('mentionsEveryone', () => {
  it.each(['@tous', '@everyone', 'rdv @Tous!', '(@EVERYONE)', 'a\n@tous'])('calls: %s', (t) => {
    expect(mentionsEveryone(t)).toBe(true);
  });
  it.each(['tous', 'mail@tous.fr', '@toustes', '@tous-les', 'x/@tous', '@@tous'])(
    'does not call: %s',
    (t) => {
      expect(mentionsEveryone(t)).toBe(false);
    }
  );
});

describe('splitTextWithMentions', () => {
  it('cuts the call out as its own part, kept as typed', () => {
    expect(splitTextWithMentions('salut @Tous, rdv')).toEqual([
      { type: 'text', value: 'salut ' },
      { type: 'everyone', value: '@Tous' },
      { type: 'text', value: ', rdv' },
    ]);
  });
  it('previews it unchanged', () => {
    expect(formatMentionsForPreview('@tous rdv')).toBe('@tous rdv');
  });
});

describe('withEveryoneRow', () => {
  const members = [
    { id: 'a', displayName: 'Ana' },
    { id: 'b', displayName: 'Bob' },
  ];
  it('comes first once a letter of it is typed, in either spelling', () => {
    expect(withEveryoneRow(members, 'to', 8)[0].id).toBe(MENTION_EVERYONE_ROW_ID);
    expect(withEveryoneRow(members, 'Ev', 8)[0].id).toBe(MENTION_EVERYONE_ROW_ID);
  });
  it('comes last on a bare @, within the limit', () => {
    const rows = withEveryoneRow(members, '', 2);
    expect(rows.map((r) => r.id)).toEqual(['a', MENTION_EVERYONE_ROW_ID]);
  });
  it('is not offered for a query that cannot be it', () => {
    expect(withEveryoneRow(members, 'an', 8)).toEqual(members);
  });
});
