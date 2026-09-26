/**
 * A LOCAL FILE THE ENGINE WITHHELD IS NOT TEXT TO INSERT (reported 2026-09-25, Firefox + Nemo).
 *
 * Nemo hands Firefox a dragged file only as its `file:///...` address and its path, so the drop
 * carries no `File` - and the editor, reading a drop without a file as text, pasted the file's NAME
 * into the message. The page cannot read a local file from its address; what it owes is to insert
 * nothing and say why.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const toasts: string[] = [];
vi.mock('$lib/stores/toast.svelte', () => ({
  showToast: (message: string) => toasts.push(message),
}));

import ChatComposer from './ChatComposer.svelte';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function editor(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[role="textbox"]');
  if (!el) throw new Error('composer editor not found');
  return el;
}

/** A drop carrying only strings, keyed by type, dispatched on `target`. */
function dropStrings(target: HTMLElement, data: Record<string, string>): void {
  const event = new MouseEvent('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      files: [],
      items: [],
      types: Object.keys(data),
      getData: (t: string) => data[t] ?? '',
    },
  });
  target.dispatchEvent(event);
  flushSync();
}

describe('ChatComposer - a drop carrying only a local file address', () => {
  beforeEach(() => {
    toasts.length = 0;
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(ChatComposer, {
      target,
      props: {
        messageText: '',
        onMessageChange: () => {},
        onSend: () => {},
        onFilesSelected: () => {},
      },
    });
    mounted.push(() => void unmount(app));
    flushSync();
  });

  it('inserts nothing into the editor and says why', () => {
    dropStrings(editor(), {
      'text/uri-list': 'file:///home/leon/affiche.pdf',
      'text/plain': '/home/leon/affiche.pdf',
    });
    expect(editor().textContent).toBe('');
    expect(toasts).toHaveLength(1);
  });

  it('still inserts ordinary dropped text', () => {
    dropStrings(editor(), { 'text/plain': 'bonjour' });
    expect(editor().textContent).toBe('bonjour');
    expect(toasts).toHaveLength(0);
  });
});
