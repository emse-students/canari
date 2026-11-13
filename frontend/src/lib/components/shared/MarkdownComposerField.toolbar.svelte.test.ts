// @vitest-environment happy-dom
/**
 * The field's DEFAULT toolbar is still the icon-only block that heads the editor: the labelled-chip
 * layout is opt-in (`chipClass`), reserved for the post composer's pinned bar.
 */
import { it, expect, afterEach, describe } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import MarkdownComposerField from './MarkdownComposerField.svelte';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

it('renders the icon-only default toolbar above the editor', () => {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(MarkdownComposerField, { target, props: { value: '' } });
  mounted.push(() => unmount(component));
  flushSync();

  const buttons = Array.from(target.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button'));
  expect(buttons).toHaveLength(8);
  for (const b of buttons) {
    expect(b.textContent?.trim()).toBe('');
    expect(b.className).not.toContain('rounded-full');
  }
});

describe('Ctrl+Z over a toolbar action', () => {
  function setup(value: string) {
    const target = document.createElement('div');
    document.body.appendChild(target);
    const state = $state({ value });
    const component = mount(MarkdownComposerField, {
      target,
      props: {
        get value() {
          return state.value;
        },
        set value(v: string) {
          state.value = v;
        },
      },
    });
    mounted.push(() => unmount(component));
    flushSync();
    const editor = target.querySelector<HTMLElement>('[contenteditable]')!;
    return { state, component, editor };
  }
  const press = (editor: HTMLElement, init: KeyboardEventInit) => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    editor.dispatchEvent(e);
    return e;
  };
  const settle = async () => {
    await tick();
    await tick();
    flushSync();
  };

  it('restores the text, and redo reapplies it', async () => {
    const { state, component, editor } = setup('hello world');
    editor.focus();
    const range = document.createRange();
    range.setStart(editor.firstChild!, 0);
    range.setEnd(editor.firstChild!, 5);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    await component.format('bold');
    await settle();
    expect(state.value).toBe('**hello** world');

    const undo = press(editor, { key: 'z', ctrlKey: true });
    await settle();
    expect(undo.defaultPrevented).toBe(true);
    expect(state.value).toBe('hello world');

    const redo = press(editor, { key: 'z', ctrlKey: true, shiftKey: true });
    await settle();
    expect(redo.defaultPrevented).toBe(true);
    expect(state.value).toBe('**hello** world');
  });

  it('leaves the key to the browser when nothing was formatted', () => {
    const { state, editor } = setup('plain');
    const none = press(editor, { key: 'z', ctrlKey: true });
    expect(none.defaultPrevented).toBe(false);
    expect(state.value).toBe('plain');
  });

  it('leaves the key to the browser for a word typed after the action', async () => {
    const { state, component, editor } = setup('hello world');
    editor.focus();
    const range = document.createRange();
    range.setStart(editor.firstChild!, 0);
    range.setEnd(editor.firstChild!, 5);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await component.format('bold');
    await settle();
    state.value = '**hello** world typed';
    flushSync();
    const undo = press(editor, { key: 'z', ctrlKey: true });
    expect(undo.defaultPrevented).toBe(false);
    expect(state.value).toBe('**hello** world typed');
  });
});
