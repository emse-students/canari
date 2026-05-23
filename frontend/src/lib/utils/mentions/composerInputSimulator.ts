import {
  needsMentionChipRender,
  renderPlainTextToMentionEditor,
  serializeMentionEditor,
  setPlainTextSelection,
  shouldRerenderComposerDom,
  composerMarkdownPreviewEnabled,
  type MentionEditorRenderOptions,
} from './mentionEditor';

export type ComposerSimState = {
  value: string;
  lastRendered: string;
  cursor: number;
};

export type ComposerKeystrokeResult = {
  key: string;
  value: string;
  serialized: string;
  domRerendered: boolean;
};

const INITIAL: ComposerSimState = { value: '', lastRendered: '', cursor: 0 };

/** Applies a single character or `Backspace` to plain text at the caret. */
export function applyPlainKeystroke(
  text: string,
  cursor: number,
  key: string
): { text: string; cursor: number } {
  if (key === 'Backspace') {
    if (cursor <= 0) return { text, cursor: 0 };
    return { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 };
  }
  return { text: text.slice(0, cursor) + key + text.slice(cursor), cursor: cursor + 1 };
}

/** Inserts or deletes in the live DOM at a plain-text offset (simulates browser input without `input` events). */
export function mutateDomAtPlainOffset(root: HTMLElement, cursor: number, key: string): number {
  if (key === 'Backspace') {
    if (cursor <= 0) return 0;
    setPlainTextSelection(root, cursor - 1, cursor);
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return Math.max(0, cursor - 1);
    const range = sel.getRangeAt(0);
    range.deleteContents();
    return cursor - 1;
  }

  setPlainTextSelection(root, cursor, cursor);
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return cursor + key.length;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(key);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  return cursor + key.length;
}

/**
 * One composer input cycle (same decisions as `MentionComposerInput.emitEditorChange`).
 * When the DOM is not rebuilt, mutates the contenteditable like the browser would.
 */
export function runComposerInputCycle(
  root: HTMLElement,
  state: ComposerSimState,
  key: string,
  options: MentionEditorRenderOptions = {}
): { state: ComposerSimState; domRerendered: boolean } {
  const { text, cursor } = applyPlainKeystroke(state.value, state.cursor, key);
  const needsMentions = needsMentionChipRender(root, text);
  const needsDom = needsMentions || shouldRerenderComposerDom(text, state.lastRendered, options);

  let nextCursor: number;
  if (needsDom) {
    renderPlainTextToMentionEditor(root, text, {
      markdownPreview: composerMarkdownPreviewEnabled(text, options),
    });
    nextCursor = cursor;
    setPlainTextSelection(root, nextCursor, nextCursor);
  } else {
    nextCursor = mutateDomAtPlainOffset(root, state.cursor, key);
  }

  const serialized = serializeMentionEditor(root);
  return {
    domRerendered: needsDom,
    state: {
      value: serialized,
      lastRendered: text,
      cursor: nextCursor,
    },
  };
}

/**
 * Simulates typing a sequence of keys and returns a snapshot after each keystroke.
 */
export function simulateComposerKeystrokes(
  keys: string,
  options: MentionEditorRenderOptions = {},
  root?: HTMLElement
): ComposerKeystrokeResult[] {
  const el = root ?? document.createElement('div');
  const owned = !root;
  if (owned) {
    el.contentEditable = 'true';
    document.body.appendChild(el);
  }

  renderPlainTextToMentionEditor(el, '', options);
  let state = { ...INITIAL };
  const results: ComposerKeystrokeResult[] = [];

  for (const key of keys) {
    const { state: next, domRerendered } = runComposerInputCycle(el, state, key, options);
    results.push({
      key,
      value: next.value,
      serialized: serializeMentionEditor(el),
      domRerendered,
    });
    state = next;
  }

  if (owned) el.remove();
  return results;
}

/** Counts non-escaped `*` in plain text (for duplicate-asterisk assertions). */
export function countUnescapedAsterisks(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '*' && (i === 0 || text[i - 1] !== '\\')) count++;
  }
  return count;
}

export { INITIAL as composerSimInitialState };
