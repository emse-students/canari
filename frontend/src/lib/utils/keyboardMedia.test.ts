// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const showToast = vi.fn();
vi.mock('$lib/stores/toast.svelte', () => ({
  showToast: (...args: unknown[]) => showToast(...args),
}));

const {
  dispatchKeyboardMedia,
  installKeyboardMediaDispatcher,
  keyboardMediaTarget,
  KEYBOARD_MEDIA_EVENT,
} = await import('./keyboardMedia');
const { m } = await import('$lib/paraglide/messages');

/** A one-byte GIF payload as the native bridge sends it. */
const GIF = { mime: 'image/gif', name: 'k.gif', data: btoa('G') };

/** A composer with a focusable field inside, registered through the action the components use. */
function composer(accept: (file: File) => boolean, surface = 'post') {
  const root = document.createElement('div');
  const field = document.createElement('textarea');
  root.appendChild(field);
  document.body.appendChild(root);
  const action = keyboardMediaTarget(root, { surface, accept });
  return { root, field, action };
}

describe('the keyboard media dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
  });

  it('hands the file to the focused composer that accepts it, with no toast', () => {
    const accept = vi.fn((_f: File) => true);
    const { field } = composer(accept);
    field.focus();
    expect(dispatchKeyboardMedia(GIF)).toBe('accepted');
    expect(accept).toHaveBeenCalledTimes(1);
    const file = accept.mock.calls[0][0];
    expect(file.type).toBe('image/gif');
    expect(file.size).toBe(1);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('gives it to the composer holding focus, never to another one mounted beside it', () => {
    const other = vi.fn((_f: File) => true);
    composer(other, 'comment');
    const focused = vi.fn((_f: File) => true);
    const { field } = composer(focused, 'chat');
    field.focus();
    expect(dispatchKeyboardMedia(GIF)).toBe('accepted');
    expect(focused).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  it('a focused field that registered nothing refuses out loud', () => {
    const accept = vi.fn((_f: File) => true);
    composer(accept);
    const poll = document.createElement('input');
    poll.dataset.mediaSurface = 'poll';
    document.body.appendChild(poll);
    poll.focus();
    expect(dispatchKeyboardMedia(GIF)).toBe('refused');
    expect(accept).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(m.keyboard_media_refused());
  });

  it('a composer that cannot attach now (a message being edited) refuses out loud', () => {
    const { field } = composer(() => false, 'chat-edit');
    field.focus();
    expect(dispatchKeyboardMedia(GIF)).toBe('refused');
    expect(showToast).toHaveBeenCalledWith(m.keyboard_media_refused());
  });

  it('with nothing focused, nothing is attached and no false toast is shown', () => {
    const accept = vi.fn((_f: File) => true);
    composer(accept);
    expect(dispatchKeyboardMedia(GIF, null)).toBe('no-focus');
    expect(accept).not.toHaveBeenCalled();
    // No keyboard commits without an editor: this is iOS seeing the app's own pasteboard write.
    expect(showToast).not.toHaveBeenCalled();
  });

  it('an unreadable payload is told, never attached', () => {
    const accept = vi.fn((_f: File) => true);
    const { field } = composer(accept);
    field.focus();
    expect(dispatchKeyboardMedia({ mime: 'image/gif' })).toBe('unreadable');
    expect(accept).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(m.keyboard_media_unreadable());
  });

  it('a destroyed composer no longer takes media', () => {
    const accept = vi.fn((_f: File) => true);
    const { field, action } = composer(accept);
    action.destroy();
    field.focus();
    expect(dispatchKeyboardMedia(GIF)).toBe('refused');
    expect(accept).not.toHaveBeenCalled();
  });

  it('the installed listener routes the native event, and stops once disposed', () => {
    const accept = vi.fn((_f: File) => true);
    const { field } = composer(accept);
    field.focus();
    const dispose = installKeyboardMediaDispatcher();
    window.dispatchEvent(new CustomEvent(KEYBOARD_MEDIA_EVENT, { detail: GIF }));
    expect(accept).toHaveBeenCalledTimes(1);
    dispose();
    window.dispatchEvent(new CustomEvent(KEYBOARD_MEDIA_EVENT, { detail: GIF }));
    expect(accept).toHaveBeenCalledTimes(1);
  });
});
