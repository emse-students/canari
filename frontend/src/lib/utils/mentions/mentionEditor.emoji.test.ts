vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (userId: string) => userId,
  resolveUserDisplayName: vi.fn().mockResolvedValue(null),
}));

import {
  EMOJI_IMAGE_SELECTOR,
  getPlainTextSelection,
  needsEmojiRender,
  renderPlainTextToMentionEditor,
  serializeMentionEditor,
  setPlainTextSelection,
} from './mentionEditor';
import { EXAMPLE_MENTION_USER_ID, formatMentionToken } from '../mentions';

/**
 * THE COMPOSER DRAWS EMOJI AS NOTO'S PICTURES, AND THE TEXT IT HANDS BACK IS UNCHANGED.
 *
 * Every caller of the composer reads plain text - the send path, drafts, mentions, the markdown
 * preview - so an emoji picture is only correct if it is invisible to all of them: it serializes to
 * the emoji, it counts as the emoji's length for the caret, and the caret never lands inside it.
 */
describe('mentionEditor - emoji pictures', () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
  });

  afterEach(() => root.remove());

  const pictures = () =>
    [...root.querySelectorAll<HTMLImageElement>(EMOJI_IMAGE_SELECTOR)].map((img) => img.alt);

  it('draws emoji as pictures and serializes back to the same text', () => {
    const text = 'salut 😀 et 🇫🇷\n👍🏽 fin';
    renderPlainTextToMentionEditor(root, text);
    expect(pictures()).toEqual(['😀', '🇫🇷', '👍🏽']);
    expect(serializeMentionEditor(root)).toBe(text);
  });

  it('keeps text-presentation characters as text', () => {
    renderPlainTextToMentionEditor(root, '© 2026 #1');
    expect(pictures()).toEqual([]);
    expect(serializeMentionEditor(root)).toBe('© 2026 #1');
  });

  it('round-trips a mention and an emoji side by side', () => {
    const text = `${formatMentionToken(EXAMPLE_MENTION_USER_ID)} 🎉`;
    renderPlainTextToMentionEditor(root, text);
    expect(serializeMentionEditor(root)).toBe(text);
  });

  it('counts a picture as its emoji for the caret, and lands before or after it, never inside', () => {
    renderPlainTextToMentionEditor(root, 'a😀b');
    // '😀' is two UTF-16 units: 'a' | 😀 | 'b' -> offsets 0, 1, 3, 4.
    for (const offset of [0, 1, 3, 4]) {
      setPlainTextSelection(root, offset);
      expect(getPlainTextSelection(root).start).toBe(offset);
    }
  });

  it('puts the caret after a trailing emoji, not back at the start', () => {
    renderPlainTextToMentionEditor(root, 'ok 👍');
    setPlainTextSelection(root, 'ok 👍'.length);
    expect(getPlainTextSelection(root).start).toBe('ok 👍'.length);
  });

  it('asks for a rebuild when an emoji arrived as text, and not once it is a picture', () => {
    root.textContent = 'tape au clavier 😀';
    expect(needsEmojiRender(root)).toBe(true);
    renderPlainTextToMentionEditor(root, 'tape au clavier 😀');
    expect(needsEmojiRender(root)).toBe(false);
  });

  it('keeps emoji inside code as characters, and does not rebuild for them', () => {
    const text = 'voir `code 😀`';
    renderPlainTextToMentionEditor(root, text, { markdownPreview: true });
    expect(pictures()).toEqual([]);
    expect(needsEmojiRender(root)).toBe(false);
    expect(serializeMentionEditor(root)).toBe(text);
  });
});
