/**
 * THE DROP BADGE LEAVES WHEN THE DRAG DOES, HOWEVER IT ENDS (user, 2026-09-25: *"l'indicateur de
 * depot des fichiers reste si on annule le depot"*).
 *
 * The badge was driven by the composer panel's own `dragover` / `dragleave` / `drop`. Two endings
 * never reached it: a drop ON THE EDITOR, which stops propagation so the file is attached once and not
 * twice, and a drag that ends elsewhere - cancelled, or leaving the window - whose closing
 * `dragleave` (no `relatedTarget`) lands wherever the pointer was. Both are asserted here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
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

/** The panel carries `is-dragover` exactly while the badge is shown - one condition drives both. */
const badgeShown = () => document.querySelector('.chat-composer-panel.is-dragover') !== null;

function drag(type: string, target: EventTarget, relatedTarget: EventTarget | null = null): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget }));
  flushSync();
}

describe('ChatComposer - the drop badge', () => {
  beforeEach(() => {
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

  it('appears while a file is dragged over the composer', () => {
    drag('dragover', editor());
    expect(badgeShown()).toBe(true);
  });

  it('leaves when the file is dropped on the editor, which stops the drop propagating', () => {
    drag('dragover', editor());
    drag('drop', editor());
    expect(badgeShown()).toBe(false);
  });

  it('leaves when the drag is cancelled or leaves the window', () => {
    drag('dragover', editor());
    // The closing dragleave of a cancelled drag, fired where the pointer is, with nowhere next.
    drag('dragleave', document.body, null);
    expect(badgeShown()).toBe(false);
  });

  it('leaves when an in-page drag ends', () => {
    drag('dragover', editor());
    drag('dragend', document.body);
    expect(badgeShown()).toBe(false);
  });
});
