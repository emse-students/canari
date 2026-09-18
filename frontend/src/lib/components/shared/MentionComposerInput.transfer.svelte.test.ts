/**
 * NOTHING BUT TEXT EVER ENTERS THE BODY, AND MEDIA GOES WHERE MEDIA IS KEPT.
 *
 * A composer body is Markdown. `serializeMentionEditor` keeps text, `<br>`, block boundaries and
 * mention chips, and walks THROUGH everything else - so an `<img>` the browser's default paste puts
 * in the editor renders on screen and is gone the moment the post is saved. The reader is shown
 * something the document cannot hold (user, 2026-09-18, having just dropped a picture into a post
 * body: *"ce qui n'est evidemment pas sauvegarde ... du coup ca ne devrait meme pas etre
 * possible"*).
 *
 * These tests pin the three halves of the answer: the default is refused, a file is handed to the
 * attachment owner instead, and text still arrives as text. They assert the EDITOR's own DOM rather
 * than a serialiser call, because the defect was visible on screen before anything was serialised.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MentionComposerInput from './MentionComposerInput.svelte';
import {
  COMPOSER_EMPTY_LINE_FILLER,
  stripComposerDomFillers,
} from '$lib/utils/mentions/mentionEditor';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mountEditor(props: Record<string, unknown> = {}) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(MentionComposerInput, { target, props: { value: '', ...props } });
  mounted.push(() => unmount(component));
  flushSync();
  const editor = target.querySelector<HTMLDivElement>('[contenteditable="true"]');
  if (!editor) throw new Error('no editor rendered');
  return { editor };
}

/** A transfer shaped like the browser's, so the code under test reads it the way it really would. */
function transfer(opts: { files?: File[]; data?: Record<string, string> }): DataTransfer {
  const data = opts.data ?? {};
  return {
    files: opts.files ?? [],
    items: [],
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? '',
    dropEffect: 'none',
  } as unknown as DataTransfer;
}

function dropOn(editor: HTMLElement, dt: DataTransfer) {
  const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, 'dataTransfer', { value: dt });
  editor.dispatchEvent(event);
  flushSync();
  return event;
}

function pasteOn(editor: HTMLElement, dt: DataTransfer) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: dt });
  editor.dispatchEvent(event);
  flushSync();
  return event;
}

const picture = new File([new Uint8Array([1])], 'tiramisu.png', { type: 'image/png' });

it('refuses the browser default on a drop, so an image cannot land in the body', () => {
  const { editor } = mountEditor();
  const event = dropOn(editor, transfer({ files: [picture] }));

  expect(event.defaultPrevented).toBe(true);
  expect(editor.querySelector('img')).toBeNull();
  expect(editor.textContent).toBe('');
});

it('hands a dropped file to the attachment owner instead of inserting it', () => {
  const onmedia = vi.fn();
  const { editor } = mountEditor({ onmedia });

  dropOn(editor, transfer({ files: [picture] }));

  expect(onmedia).toHaveBeenCalledTimes(1);
  expect(onmedia.mock.calls[0][0]).toEqual([picture]);
});

it('hands a pasted file over the same way', () => {
  const onmedia = vi.fn();
  const { editor } = mountEditor({ onmedia });

  const event = pasteOn(editor, transfer({ files: [picture] }));

  expect(event.defaultPrevented).toBe(true);
  expect(onmedia).toHaveBeenCalledWith([picture]);
});

/**
 * THE 2026-09-18 REPORT IN ITS OWN SHAPE. Copying a picture out of a Messenger tab puts no file on
 * the clipboard at all - only `text/html` naming `blob:https://www.messenger.com/...`, an origin
 * this page may not read. The default paste inserted that markup and the browser refused to load
 * it, which is the security error the reader saw and could do nothing about. Refusing the default
 * is what removes it: there is no file to rescue, but nothing broken is put on screen either.
 */
it('inserts nothing at all when a paste carries only foreign markup', () => {
  const onmedia = vi.fn();
  const { editor } = mountEditor({ onmedia });

  const event = pasteOn(
    editor,
    transfer({
      data: {
        'text/html':
          '<img src="blob:https://www.messenger.com/c551d2fa-39bc-4520-adb0-0bc799bc4ac3">',
      },
    })
  );

  expect(event.defaultPrevented).toBe(true);
  expect(editor.querySelector('img')).toBeNull();
  expect(editor.textContent).toBe('');
  expect(onmedia).not.toHaveBeenCalled();
});

it('still pastes text, and pastes it as text rather than as the markup around it', () => {
  const { editor } = mountEditor();

  pasteOn(
    editor,
    transfer({
      data: {
        'text/plain': 'Tiramisu',
        'text/html': '<b style="color:red">Tiramisu</b>',
      },
    })
  );

  expect(editor.textContent).toContain('Tiramisu');
  expect(editor.querySelector('b')).toBeNull();
});

/**
 * THE FILLER IS A CHARACTER THE SERIALISER IS PROMISED TO REMOVE, so it has to be THAT character.
 *
 * A caret after a trailing `<br>` anchors to the parent and types before it, so one zero-width
 * space is appended to hold it - and `stripComposerDomFillers` is what keeps it out of the sent
 * message. Shipped in that state, the literal was three mojibake characters (U+200B's own UTF-8
 * read as Latin-1), which the stripper does not match and which would therefore have travelled
 * into a post body. Comparing against the constant, rather than against "some invisible thing",
 * is what makes that visible.
 */
it('ends a trailing line break with the one filler the serialiser strips', () => {
  const { editor } = mountEditor();

  pasteOn(editor, transfer({ data: { 'text/plain': 'first\nsecond\n' } }));

  const text = editor.textContent ?? '';
  expect(text).toBe(`firstsecond${COMPOSER_EMPTY_LINE_FILLER}`);
  expect(stripComposerDomFillers(text)).toBe('firstsecond');
});
