import {
  EXAMPLE_MENTION_USER_ID,
  extractMentionUserIds,
  formatMentionToken,
  isMentionUserId,
} from './mentions';
import { formatMentionsForPreview, splitTextWithMentions } from './mentions.parse';
import { preprocessPostMarkdown } from './posts/postMarkdown';

describe('mentions', () => {
  it('formatMentionToken builds @[id]', () => {
    expect(formatMentionToken(EXAMPLE_MENTION_USER_ID)).toBe(`@[${EXAMPLE_MENTION_USER_ID}]`);
  });

  it('normalizes uppercase hex from API', () => {
    const upper = EXAMPLE_MENTION_USER_ID.toUpperCase();
    expect(formatMentionToken(upper)).toBe(`@[${EXAMPLE_MENTION_USER_ID}]`);
  });

  it('extractMentionUserIds reads tokens', () => {
    const text = `Salut ${formatMentionToken(EXAMPLE_MENTION_USER_ID)}!`;
    expect(extractMentionUserIds(text)).toEqual([EXAMPLE_MENTION_USER_ID]);
  });

  it('ignores plain @word tokens', () => {
    expect(extractMentionUserIds('Salut @alice')).toEqual([]);
  });

  it('ignores truncated or dashed ids in brackets', () => {
    expect(extractMentionUserIds('@[abc]')).toEqual([]);
    expect(
      extractMentionUserIds('@[550e8400-e29b-41d4-a716-4466554400000000000000000000000000000000]')
    ).toEqual([]);
  });

  it('isMentionUserId validates 64 hex ids', () => {
    expect(isMentionUserId(EXAMPLE_MENTION_USER_ID)).toBe(true);
    expect(isMentionUserId('Jean Dupont')).toBe(false);
    expect(isMentionUserId('abc')).toBe(false);
  });
});

describe('formatMentionsForPreview', () => {
  it('replaces @[id] with @label for previews', () => {
    const text = `Salut @[${EXAMPLE_MENTION_USER_ID}]!`;
    const out = formatMentionsForPreview(text);
    expect(out).not.toContain('@[');
    expect(out).toMatch(/^Salut @.+!$/);
  });

  it('leaves text without mentions unchanged', () => {
    expect(formatMentionsForPreview('hello world')).toBe('hello world');
  });
});

describe('splitTextWithMentions', () => {
  it('parses @[id] as mention with userId', () => {
    const parts = splitTextWithMentions(`hey @[${EXAMPLE_MENTION_USER_ID}]`);
    expect(parts.some((p) => p.type === 'mention' && p.userId === EXAMPLE_MENTION_USER_ID)).toBe(
      true
    );
  });

  it('leaves plain @word as text', () => {
    const parts = splitTextWithMentions('hey @alice');
    expect(parts.every((p) => p.type !== 'mention')).toBe(true);
  });
});

describe('preprocessPostMarkdown', () => {
  it('links @[id] to internal mention href', () => {
    const out = preprocessPostMarkdown(`Bonjour @[${EXAMPLE_MENTION_USER_ID}]`);
    expect(out).toContain(`](#mention-${EXAMPLE_MENTION_USER_ID})`);
    expect(out).not.toContain(`@[${EXAMPLE_MENTION_USER_ID}]`);
  });

  it('does not transform plain @word', () => {
    expect(preprocessPostMarkdown('Bonjour @alice')).toBe('Bonjour @alice');
  });

  it('preserves line breaks when no mentions', () => {
    expect(preprocessPostMarkdown('Bonjour\nmonde')).toBe('Bonjour  \nmonde');
  });
});
