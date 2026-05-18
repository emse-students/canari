import { describe, expect, it } from 'vitest';
import { extractMentionUserIds, formatMentionToken, isUserUuid } from './mentions';
import { splitTextWithMentions } from './mentions.parse';
import { preprocessPostMarkdown } from './posts/postMarkdown';

const USER_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('mentions', () => {
  it('formatMentionToken builds @[uuid]', () => {
    expect(formatMentionToken(USER_ID)).toBe(`@[${USER_ID}]`);
  });

  it('extractMentionUserIds reads uuid tokens', () => {
    const text = `Salut ${formatMentionToken(USER_ID)} !`;
    expect(extractMentionUserIds(text)).toEqual([USER_ID]);
  });

  it('ignores plain @word tokens', () => {
    expect(extractMentionUserIds('Salut @alice')).toEqual([]);
  });

  it('isUserUuid validates canonical ids', () => {
    expect(isUserUuid(USER_ID)).toBe(true);
    expect(isUserUuid('Jean Dupont')).toBe(false);
  });
});

describe('splitTextWithMentions', () => {
  it('parses @[uuid] as mention with userId', () => {
    const parts = splitTextWithMentions(`hey @[${USER_ID}]`);
    expect(parts.some((p) => p.type === 'mention' && p.userId === USER_ID)).toBe(true);
  });

  it('leaves plain @word as text', () => {
    const parts = splitTextWithMentions('hey @alice');
    expect(parts.every((p) => p.type !== 'mention')).toBe(true);
  });
});

describe('preprocessPostMarkdown', () => {
  it('links @[uuid] to internal mention href', () => {
    const out = preprocessPostMarkdown(`Bonjour @[${USER_ID}]`);
    expect(out).toContain(`](#mention-${USER_ID})`);
    expect(out).not.toContain(`@[${USER_ID}]`);
  });

  it('does not transform plain @word', () => {
    expect(preprocessPostMarkdown('Bonjour @alice')).toBe('Bonjour @alice');
  });

  it('preserves line breaks when no mentions', () => {
    expect(preprocessPostMarkdown('Bonjour\nmonde')).toBe('Bonjour  \nmonde');
  });
});
