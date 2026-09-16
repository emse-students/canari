/**
 * `insertNewlineAtCursor` MUTATES THE DOM DIRECTLY AND FIRES A REAL `input` EVENT, rather than
 * going through `syncFromPlainText` (see the method's own docblock for why: that path raced
 * against a one-way `value`/`onchange` parent and lost the caret). This file proves the
 * replacement still does what the two things that used to call the old path needed:
 *
 * 1. A plain newline lands where the caret was, and the caret ends up right after it.
 * 2. `MarkdownComposerField`'s own reason for existing - a fenced code block opened with a
 *    newline must re-render as one, immediately, because `emitEditorChange` (the same pipeline
 *    ordinary typing already uses) decides that from the result, not from a special case here.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MentionComposerInput from './MentionComposerInput.svelte';
import { MD_FENCED_CODE_CLASS } from '$lib/utils/mentions/mentionEditor';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

interface Harness {
  value: string;
  onchange: (v: string) => void;
  markdownPreview?: boolean;
}

function mountEditor(initialValue: string, markdownPreview = false) {
  const props: Harness = $state({
    value: initialValue,
    onchange: (v: string) => {
      props.value = v;
    },
    markdownPreview,
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(MentionComposerInput, { target, props }) as unknown as {
    insertNewlineAtCursor: () => void;
    setSelectionRange: (start: number, end?: number) => void;
    getEditorElement: () => HTMLElement | null;
  };
  mounted.push(() => void unmount(app));
  flushSync();
  return { app, props };
}

/** Types `text` at the current caret through a real Range + `input` event, like a keystroke would. */
function typeAtCursor(editorEl: HTMLElement, text: string) {
  const sel = window.getSelection()!;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  range.insertNode(document.createTextNode(text));
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  editorEl.dispatchEvent(new InputEvent('input', { bubbles: true }));
  flushSync();
}

/** Dispatches a real `Enter` keydown, like `MarkdownComposerField` (no `onkeydown` of its own) relies on. */
function pressEnter(editorEl: HTMLElement) {
  editorEl.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  );
  flushSync();
}

describe('MentionComposerInput.insertNewlineAtCursor', () => {
  it('inserts a real newline at the caret, with the caret anchored right after it', () => {
    const { app, props } = mountEditor('hello');
    app.setSelectionRange(5, 5);

    app.insertNewlineAtCursor();
    flushSync();

    // The filler character (`\u200B`) that anchors the caret after a trailing `<br>` is a raw-DOM
    // detail - `props.value` is what `onchange` actually reported, through `stripComposerDomFillers`.
    expect(props.value).toBe('hello\n');
    expect(app.getEditorElement()!.querySelector('br')).not.toBeNull();
  });

  it('THE REGRESSION THIS FILE EXISTS FOR: typing right after the newline lands after it, not before', () => {
    // Measured 2026-09-16: a caret placed after a trailing `<br>` with nothing following it
    // anchors to the PARENT element, not inside a text node, and the very next keystroke landed
    // BEFORE the `<br>` in Chrome - "hello" + Enter + "world" serialized as "helloworld\n"
    // instead of "hello\nworld". This is the end-to-end proof the anchor fix holds under an
    // actual subsequent edit, not just immediately after insertion.
    const { app, props } = mountEditor('hello');
    app.setSelectionRange(5, 5);
    app.insertNewlineAtCursor();
    flushSync();

    typeAtCursor(app.getEditorElement()!, 'world');

    expect(props.value).toBe('hello\nworld');
  });

  it('re-renders a fence opener as a code block the same way ordinary typing would', () => {
    const { app } = mountEditor('```js', true);
    app.setSelectionRange('```js'.length, '```js'.length);

    app.insertNewlineAtCursor();
    flushSync();

    const editorEl = app.getEditorElement()!;
    expect(editorEl.querySelector(`.${MD_FENCED_CODE_CLASS}`)).not.toBeNull();
  });

  it('a formatted line re-rendered by markdownPreview still lands the next keystroke after the break', async () => {
    // Measured 2026-09-16: `appendComposerText` (the render path `markdownPreview` re-renders
    // through, separate from `appendTextWithBreaks`) left its OWN trailing empty text node for a
    // line ending in `\n`, which doesn't anchor a caret either - same defect class as the plain
    // case above, but only reachable once the text actually contains markdown (e.g. `__test__`)
    // so the re-render path is taken at all.
    const { app, props } = mountEditor('__test__', true);
    app.setSelectionRange('__test__'.length, '__test__'.length);
    app.insertNewlineAtCursor();
    flushSync();
    // Inserting the newline itself re-renders the markdown styling (`applyDomFromPlainText`),
    // which sets `isApplyingDom` and clears it again in a queued microtask - exactly the gap a
    // real keystroke always has (a separate browser event), but two synchronous calls in a test
    // do not, so this awaits that same tick.
    await Promise.resolve();

    typeAtCursor(app.getEditorElement()!, 'world');

    expect(props.value).toBe('__test__\nworld');
  });

  it('Enter still inserts a newline when the current text has no markdown to trigger a preview', () => {
    // Measured 2026-09-16: `handleEditorKeydown` additionally gated its Enter interception on
    // `composerMarkdownPreviewEnabled(text, ...)`, a check on whether the CURRENT text already
    // looks like markdown. Plain text never does, so the gate fell through to the browser's own
    // default Enter handling for the common case - the same "helloworld" bug this file already
    // covers, just unguarded for anything without markdown syntax. `markdownPreview` (the prop)
    // alone must decide whether this component owns Enter, never the text's own content.
    const { app, props } = mountEditor('hello', true);
    app.setSelectionRange('hello'.length, 'hello'.length);

    pressEnter(app.getEditorElement()!);
    typeAtCursor(app.getEditorElement()!, 'world');

    expect(props.value).toBe('hello\nworld');
  });
});
