/**
 * `@tous` (owner, 2026-11-25; aligned 2026-11-26, "comme les autres mentions"): a mention like any
 * other - the picked row writes `@[everyone]`, the word typed by hand is text. Its recognition, its
 * bubble chip and its picker row. The decision it feeds is asserted against the shared contract in
 * `conversationLevel.contract.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { MENTION_EVERYONE_TOKEN, mentionsEveryone } from './mentions';
import { formatMentionsForPreview, splitTextWithMentions } from './mentions.parse';
import { countMentionTokens } from './mentions/mentionEditor';
import {
  MENTION_EVERYONE_ROW_ID,
  withEveryoneRow,
} from '$lib/composables/useMentionAutocomplete.svelte';
import { m } from '$lib/paraglide/messages';

describe('mentionsEveryone', () => {
  it.each(['@[everyone]', 'rdv @[everyone]!', '@[EVERYONE]', 'a\n@[everyone] b'])(
    'calls: %s',
    (t) => {
      expect(mentionsEveryone(t)).toBe(true);
    }
  );
  // Typed by hand, like a member's name typed by hand: text, nobody is called.
  it.each(['@tous', 'merci @tous', '@everyone', 'tous', '@[everyon]'])('does not call: %s', (t) => {
    expect(mentionsEveryone(t)).toBe(false);
  });
});

describe('splitTextWithMentions', () => {
  it("cuts the token out as its own part, drawn in the reader's word", () => {
    expect(splitTextWithMentions(`salut ${MENTION_EVERYONE_TOKEN}, rdv`)).toEqual([
      { type: 'text', value: 'salut ' },
      { type: 'everyone', value: `@${m.mention_everyone_word()}` },
      { type: 'text', value: ', rdv' },
    ]);
  });
  it('leaves the word typed by hand as text', () => {
    expect(splitTextWithMentions('merci @tous')).toEqual([{ type: 'text', value: 'merci @tous' }]);
  });
  it('previews the token as the word, never the raw token', () => {
    expect(formatMentionsForPreview(`${MENTION_EVERYONE_TOKEN} rdv`)).toBe(
      `@${m.mention_everyone_word()} rdv`
    );
  });
});

describe('countMentionTokens', () => {
  it('counts a picked @tous as a chip, like a member', () => {
    expect(countMentionTokens(`${MENTION_EVERYONE_TOKEN} @[${'a'.repeat(64)}] @tous`)).toBe(2);
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
