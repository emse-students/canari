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

  it('never labels a mention with the user id, however cold the name cache is', () => {
    // The id used to be passed as its own fallback, which put back the one value
    // `getUserDisplayNameSync` is careful never to return - so a cold cache rendered
    // `@3f9a1c2b...` in a chat body, a notification body, a conversation preview and, most
    // visibly, in the composer right after picking someone from the autocomplete.
    const parts = splitTextWithMentions(`hey @[${EXAMPLE_MENTION_USER_ID}]`);
    const mention = parts.find((p) => p.type === 'mention');
    expect(mention).toBeDefined();
    expect(mention && 'label' in mention && mention.label).not.toBe(EXAMPLE_MENTION_USER_ID);
  });

  it('renders the preview without leaking the id either', () => {
    // The preview is a plain string, so it cannot render an absence and takes whatever the parser
    // labelled. It is the path a conversation row and a notification body both go through.
    const out = formatMentionsForPreview(`hey @[${EXAMPLE_MENTION_USER_ID}]`);
    expect(out).not.toContain(EXAMPLE_MENTION_USER_ID);
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
