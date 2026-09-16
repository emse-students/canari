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
});
