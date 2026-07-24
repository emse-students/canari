import { markdownStructureKey } from '$lib/utils/markdown/inlinePreview';
import {
  composerMarkdownPreviewEnabled,
  insertPlainTextNewline,
  renderPlainTextToMentionEditor,
  serializeMentionEditor,
  setPlainTextSelection,
  shouldRerenderComposerDom,
} from './mentionEditor';
import {
  applyPlainKeystroke,
  countUnescapedAsterisks,
  runComposerInputCycle,
  simulateComposerKeystrokes,
  composerSimInitialState,
  type ComposerSimState,
} from './composerInputSimulator';

const MD = { markdownPreview: true };

function expectedAfterEachChar(prefix: string): string[] {
  const out: string[] = [];
  for (let i = 1; i <= prefix.length; i++) out.push(prefix.slice(0, i));
  return out;
}

function assertNoAsteriskDuplication(text: string, expectedCount: number) {
  expect(countUnescapedAsterisks(text)).toBe(expectedCount);
  expect(text.match(/\*{3,}/)).toBeNull();
}

describe('markdownStructureKey / shouldRerenderComposerDom', () => {
  it('keeps structure key stable when only inner italic text changes', () => {
    expect(markdownStructureKey('*test*')).toBe(markdownStructureKey('*tests*'));
    expect(shouldRerenderComposerDom('*tests*', '*test*', MD)).toBe(true);
  });

  it('rerenders when a delimiter pair is opened or closed', () => {
    expect(shouldRerenderComposerDom('*test*', '*test', MD)).toBe(true);
    expect(shouldRerenderComposerDom('*', '', MD)).toBe(false);
    expect(shouldRerenderComposerDom('*a*', '*a', MD)).toBe(true);
  });

  it('enables styled preview only for closed spans', () => {
    expect(composerMarkdownPreviewEnabled('*open', MD)).toBe(false);
    expect(composerMarkdownPreviewEnabled('*closed*', MD)).toBe(true);
  });

  it('does not rerender plain text when only newlines change', () => {
    expect(shouldRerenderComposerDom('hello\n', 'hello', MD)).toBe(false);
    expect(shouldRerenderComposerDom('a\nb\n', 'a\nb', MD)).toBe(false);
  });

  it('does not rerender when only fenced code body text changes', () => {
    expect(shouldRerenderComposerDom('```js\na', '```js\nab', MD)).toBe(true);
    expect(shouldRerenderComposerDom('```js\na', '```js\n', MD)).toBe(true);
    expect(shouldRerenderComposerDom('```js\n', '```js', MD)).toBe(true);
  });
});

describe('styled markdown DOM', () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.remove();
  });

  it('round-trips closed italic without duplicating delimiters', () => {
    renderPlainTextToMentionEditor(root, '*test*', { markdownPreview: true });
    expect(serializeMentionEditor(root)).toBe('*test*');
  });

  it('serializes a newline between a heading block and a sibling div', () => {
    renderPlainTextToMentionEditor(root, '## Title', { markdownPreview: true });
    const div = document.createElement('div');
    div.appendChild(document.createTextNode('next'));
    root.appendChild(div);
    expect(serializeMentionEditor(root)).toBe('## Title\nnext');
  });
});

describe('simulateComposerKeystrokes (markdown preview)', () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.remove();
  });

  it('evolves *test* one key at a time without duplicating asterisks', () => {
    const keys = '*test*';
    const results = simulateComposerKeystrokes(keys, MD, root);
    const expected = expectedAfterEachChar(keys);

    expect(results.map((r) => r.value)).toEqual(expected);
    results.forEach((r, i) => {
      expect(r.serialized).toBe(r.value);
      assertNoAsteriskDuplication(r.value, countUnescapedAsterisks(expected[i]));
    });
    expect(results.at(-1)?.domRerendered).toBe(true);
  });

  it('keeps caret after closing delimiters when finishing a span', () => {
    let state: ComposerSimState = { ...composerSimInitialState };
    for (const key of '**test**') {
      ({ state } = runComposerInputCycle(root, state, key, MD));
    }
    expect(state.value).toBe('**test**');
    expect(state.cursor).toBe('**test**'.length);
  });

  it('rerenders when editing inside closed italic without duplicating delimiters', () => {
    renderPlainTextToMentionEditor(root, '*test*', { markdownPreview: true });
    const state: ComposerSimState = { value: '*test*', lastRendered: '*test*', cursor: 5 };

    const { state: afterS, domRerendered } = runComposerInputCycle(root, state, 's', MD);
    expect(domRerendered).toBe(true);
    expect(afterS.value).toBe('*tests*');
    assertNoAsteriskDuplication(afterS.value, 2);
  });

  it('evolves **bold** without extra asterisks', () => {
    const keys = '**bold**';
    const results = simulateComposerKeystrokes(keys, MD, root);
    expect(results.map((r) => r.value)).toEqual(expectedAfterEachChar(keys));
    results.forEach((r) => {
      expect(r.serialized).toBe(r.value);
      assertNoAsteriskDuplication(r.value, countUnescapedAsterisks(keys.slice(0, r.value.length)));
    });
  });

  it('handles rapid lone asterisks then closing', () => {
    const results = simulateComposerKeystrokes('***a***', MD, root);
    const last = results.at(-1)?.value ?? '';
    expect(last).toBe('***a***');
    expect(last.match(/\*{4,}/)).toBeNull();
    results.forEach((r) => expect(r.serialized).toBe(r.value));
  });

  it('types on the line after a heading when Enter inserts a newline', () => {
    let state: ComposerSimState = { ...composerSimInitialState };
    for (const key of '## Title') {
      ({ state } = runComposerInputCycle(root, state, key, MD));
    }

    renderPlainTextToMentionEditor(root, state.value, MD);
    setPlainTextSelection(root, state.value.length);
    const { text, cursor } = insertPlainTextNewline(root);
    expect(text).toBe('## Title\n');
    expect(cursor).toBe('## Title\n'.length);

    ({ state } = runComposerInputCycle(root, { value: text, lastRendered: text, cursor }, 'a', MD));
    expect(state.value).toBe('## Title\na');
    expect(state.cursor).toBe('## Title\na'.length);
  });

  it('handles backspace removing closing delimiter', () => {
    let state: ComposerSimState = { ...composerSimInitialState };
    for (const key of '*hi*') {
      ({ state } = runComposerInputCycle(root, state, key, MD));
    }
    expect(state.value).toBe('*hi*');

    ({ state } = runComposerInputCycle(root, state, 'Backspace', MD));
    expect(state.value).toBe('*hi');
    assertNoAsteriskDuplication(state.value, 1);
  });

  it('preserves escaped asterisk while typing', () => {
    const results = simulateComposerKeystrokes('\\*lit*', MD, root);
    expect(results.at(-1)?.value).toBe('\\*lit*');
    expect(results.map((r) => r.serialized).every((s, i) => s === results[i].value)).toBe(true);
  });

  it('plain composer mode never rerenders for markdown', () => {
    const results = simulateComposerKeystrokes('*x*', {}, root);
    expect(results.every((r) => !r.domRerendered)).toBe(true);
    expect(results.at(-1)?.value).toBe('*x*');
  });

  it('does not format inline markdown inside fenced code blocks', () => {
    const text = '```\n**not bold**\n```';
    renderPlainTextToMentionEditor(root, text, MD);
    expect(serializeMentionEditor(root)).toBe(text);
    expect(root.querySelector('.md-composer-bold')).toBeNull();
    expect(root.querySelector('.md-composer-fenced-code')).not.toBeNull();
  });
});

describe('applyPlainKeystroke', () => {
  it('inserts and deletes at cursor', () => {
    expect(applyPlainKeystroke('ab', 1, 'X')).toEqual({ text: 'aXb', cursor: 2 });
    expect(applyPlainKeystroke('aXb', 2, 'Backspace')).toEqual({ text: 'ab', cursor: 1 });
  });
});
