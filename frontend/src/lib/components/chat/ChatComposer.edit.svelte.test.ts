/**
 * EDITING A MESSAGE HAPPENS IN THE CLASSIC COMPOSER, NOT IN THE BUBBLE (user, 2026-10-02:
 * *"modification des messages -> pas dans la bulle, dans le composer de message classique"*).
 *
 * While `editingText` is set the composer is an edit field: a banner names the message, Send saves
 * instead of sending, attachments and the microphone step aside, and Escape cancels. The field's own
 * text (`messageText`) is the edit - the parent loaded it and keeps the draft it replaced.
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ChatComposer from './ChatComposer.svelte';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

// The phone apps' composer has ONE "+", which typed text never folds away - the case where hiding it
// while editing is the composer's own doing and not the fold's.
vi.mock('$lib/mobile/glassChrome', () => ({ usesGlassChrome: () => true }));

// The banner slides; happy-dom rejects a cancelled animation, see the helper.
afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];
const originalMatchMedia = window.matchMedia;

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  window.matchMedia = originalMatchMedia;
});

interface Harness {
  messageText: string;
  editingText: string | null;
  onMessageChange: (v: string) => void;
  onSend: () => void;
  onConfirmEdit: () => void;
  onCancelEdit: () => void;
  onFilesSelected: () => void;
}

function mountComposer(over: Partial<Harness> = {}) {
  const calls = { send: vi.fn(), confirm: vi.fn(), cancel: vi.fn() };
  const props: Harness = $state({
    messageText: 'bonjour',
    editingText: 'bonjour',
    onMessageChange: (v: string) => {
      props.messageText = v;
    },
    onSend: calls.send,
    onConfirmEdit: calls.confirm,
    onCancelEdit: calls.cancel,
    onFilesSelected: () => {},
    ...over,
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(ChatComposer, { target, props });
  mounted.push(() => void unmount(app));
  flushSync();
  return { props, calls };
}

const editor = () => document.querySelector<HTMLElement>('[role="textbox"]')!;
const sendButton = () =>
  document.querySelector<HTMLButtonElement>(
    `button[aria-label="${m.common_save_button()}"], button[aria-label="${m.chat_send_message_label()}"]`
  )!;
const key = (name: string) => {
  editor().dispatchEvent(
    new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
  );
  flushSync();
};

describe('ChatComposer - editing a message', () => {
  it('focuses the field with the caret at the END of the loaded text', async () => {
    const { props } = mountComposer({ messageText: '', editingText: null });
    props.messageText = 'bonjour a tous';
    props.editingText = 'bonjour a tous';
    flushSync();
    await tick();
    await tick();
    expect(document.activeElement).toBe(editor());
    const sel = window.getSelection()!;
    expect(sel.rangeCount).toBe(1);
    const range = sel.getRangeAt(0);
    expect(range.collapsed).toBe(true);
    // The caret sits after the last character: nothing of the text lies beyond it.
    const tail = document.createRange();
    tail.selectNodeContents(editor());
    tail.setStart(range.endContainer, range.endOffset);
    expect(tail.toString()).toBe('');
  });

  it('names the message being edited in a banner, with a way out', () => {
    mountComposer({ editingText: 'bonjour a tous' });
    expect(document.body.textContent).toContain(m.chat_editing_message_label());
    expect(document.body.textContent).toContain('bonjour a tous');
    expect(
      document.querySelector(`button[aria-label="${m.chat_cancel_edit_label()}"]`)
    ).not.toBeNull();
  });

  it('draws no banner when nothing is being edited', () => {
    mountComposer({ editingText: null });
    expect(document.body.textContent).not.toContain(m.chat_editing_message_label());
  });

  it('labels the button Save while editing, and Send otherwise', () => {
    mountComposer();
    expect(sendButton().getAttribute('aria-label')).toBe(m.common_save_button());
    document.body.innerHTML = '';
    mountComposer({ editingText: null });
    expect(sendButton().getAttribute('aria-label')).toBe(m.chat_send_message_label());
  });

  it('cannot save an unchanged text, an empty one, but can save a changed one', () => {
    const { props } = mountComposer({ messageText: 'bonjour', editingText: 'bonjour' });
    expect(sendButton().disabled).toBe(true);
    props.messageText = '   ';
    flushSync();
    expect(sendButton().disabled).toBe(true);
    props.messageText = 'bonsoir';
    flushSync();
    expect(sendButton().disabled).toBe(false);
  });

  it('saves with the button, and sends nothing', () => {
    const { calls } = mountComposer({ messageText: 'bonsoir', editingText: 'bonjour' });
    sendButton().click();
    expect(calls.confirm).toHaveBeenCalledTimes(1);
    expect(calls.send).not.toHaveBeenCalled();
  });

  it('saves with Enter, and sends nothing', () => {
    const { calls } = mountComposer({ messageText: 'bonsoir', editingText: 'bonjour' });
    key('Enter');
    expect(calls.confirm).toHaveBeenCalledTimes(1);
    expect(calls.send).not.toHaveBeenCalled();
  });

  it('does NOT clear the field when saving: the parent hands the draft back, and a clear would wipe it', () => {
    const changes: string[] = [];
    const { calls } = mountComposer({
      messageText: 'bonsoir',
      editingText: 'bonjour',
      onMessageChange: (v) => changes.push(v),
    });
    sendButton().click();
    flushSync();
    expect(calls.confirm).toHaveBeenCalled();
    expect(changes).not.toContain('');
  });

  it('cancels with Escape and with the banner s button', () => {
    const { calls } = mountComposer();
    key('Escape');
    expect(calls.cancel).toHaveBeenCalledTimes(1);
    document
      .querySelector<HTMLButtonElement>(`button[aria-label="${m.chat_cancel_edit_label()}"]`)!
      .click();
    expect(calls.cancel).toHaveBeenCalledTimes(2);
  });

  it('puts the "+" away while a message is edited, and shows it otherwise', () => {
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    const addButton = () =>
      document.querySelector(`button[aria-label="${m.chat_composer_add_label()}"]`);

    mountComposer({ messageText: '', editingText: null });
    expect(addButton(), 'the "+" is there for an ordinary message').not.toBeNull();
    document.body.innerHTML = '';

    mountComposer({ messageText: 'bonsoir', editingText: 'bonjour' });
    expect(addButton()).toBeNull();
  });

  it('still sends an ordinary message, and clears the field after it', () => {
    const changes: string[] = [];
    const { calls } = mountComposer({
      editingText: null,
      onMessageChange: (v) => changes.push(v),
    });
    sendButton().click();
    flushSync();
    expect(calls.send).toHaveBeenCalledTimes(1);
    expect(calls.confirm).not.toHaveBeenCalled();
  });
});
