vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (userId: string) => userId,
  resolveUserDisplayName: vi.fn().mockResolvedValue(null),
}));

import {
  getPlainTextSelection,
  MD_FENCED_CODE_CLASS,
  needsMentionChipRender,
  renderPlainTextToMentionEditor,
  serializeMentionEditor,
  setPlainTextSelection,
} from './mentionEditor';

import { EXAMPLE_MENTION_USER_ID } from '../mentions';

describe('mentionEditor', () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.remove();
  });

  it('round-trips @[uuid] through DOM', () => {
    const text = `Salut @[${EXAMPLE_MENTION_USER_ID}]!`;
    renderPlainTextToMentionEditor(root, text);
    expect(serializeMentionEditor(root)).toBe(text);
    expect(root.querySelector('[data-mention-id]')).not.toBeNull();
  });

  it('creates a clickable mention chip element', () => {
    renderPlainTextToMentionEditor(root, `@[${EXAMPLE_MENTION_USER_ID}]`);
    const chip = root.querySelector('[data-mention-id]') as HTMLElement;
    expect(chip?.textContent).toMatch(/^@/);
    expect(chip?.dataset.mentionId).toBe(EXAMPLE_MENTION_USER_ID);
  });

  it('detects raw @[id] text that still needs chip rendering', () => {
    root.textContent = `Salut @[${EXAMPLE_MENTION_USER_ID}]!`;
    expect(needsMentionChipRender(root, `Salut @[${EXAMPLE_MENTION_USER_ID}]!`)).toBe(true);
    renderPlainTextToMentionEditor(root, `Salut @[${EXAMPLE_MENTION_USER_ID}]!`);
    expect(needsMentionChipRender(root, `Salut @[${EXAMPLE_MENTION_USER_ID}]!`)).toBe(false);
  });

  it('round-trips plain-text caret offsets across newlines', () => {
    for (const text of ['hello\n', 'hello\nworld', '\n', 'a\nb', 'line1\nline2\n']) {
      renderPlainTextToMentionEditor(root, text, { markdownPreview: true });
      for (let pos = 0; pos <= text.length; pos++) {
        setPlainTextSelection(root, pos, pos);
        expect(getPlainTextSelection(root).start, `text=${JSON.stringify(text)} pos=${pos}`).toBe(
          pos
        );
      }
    }
  });

  it('round-trips caret offsets inside an open fenced code block', () => {
    const text = '```js\nconst x = 1;\n';
    renderPlainTextToMentionEditor(root, text, { markdownPreview: true });
    for (let pos = 0; pos <= text.length; pos++) {
      setPlainTextSelection(root, pos, pos);
      expect(getPlainTextSelection(root).start, `text=${JSON.stringify(text)} pos=${pos}`).toBe(
        pos
      );
    }
  });

  it('does not add an extra break before a closing fence', () => {
    const text = '```js\ncode\n```';
    renderPlainTextToMentionEditor(root, text, { markdownPreview: true });
    expect(serializeMentionEditor(root)).toBe(text);
    const fenced = root.querySelector(`.${MD_FENCED_CODE_CLASS}`);
    expect(fenced).not.toBeNull();
    const afterFenced = fenced!.nextSibling;
    expect(afterFenced?.nodeName).not.toBe('BR');
    expect((afterFenced as HTMLElement | null)?.classList.contains('md-composer-muted')).toBe(true);
  });

  it('serializes typing on an empty fenced line without merging the previous line', () => {
    const text = '```js\np\ndd\n';
    renderPlainTextToMentionEditor(root, text, { markdownPreview: true });
    setPlainTextSelection(root, text.length, text.length);
    const sel = window.getSelection();
    expect(sel?.rangeCount).toBeGreaterThan(0);
    const range = sel!.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode('L'));
    range.collapse(false);
    sel!.removeAllRanges();
    sel!.addRange(range);
    expect(serializeMentionEditor(root)).toBe('```js\np\ndd\nL');
  });
});
