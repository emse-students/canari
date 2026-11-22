/**
 * THE ONE OWNER OF `canari-keyboard-media`: a GIF or sticker the soft keyboard commits goes to the
 * composer that has focus, or the member is told it cannot go there - it is never dropped silently.
 *
 * The native bridges (Android `KeyboardMediaBridge.kt`, iOS `KeyboardMediaBridge.mm`) accept keyboard
 * media for the WHOLE WebView: Android advertises image MIME types on every editor, so Gboard offers
 * its GIF tab in any field. Each composer used to listen for the event on its own, which left every
 * field nobody had wired (the post composer, a poll, a caption, a message being edited) taking the
 * GIF from the keyboard and losing it. Now ONE window listener decodes the payload and routes it:
 *
 * - a registered target (`keyboardMediaTarget` action) whose element contains the focused element
 *   gets the file through its own attach path - the one a picked file takes;
 * - a target that cannot attach now (a message being edited) refuses, and so does any focused field
 *   that registered nothing: a toast says GIFs cannot be added here and one line names the surface;
 * - with no focused field, a line and NO toast: no keyboard can commit without an editor, so on
 *   Android this does not happen, and on iOS it is the app's own pasteboard write (an image copied
 *   in the app fires the same notification the bridge observes) - telling the member "GIFs cannot be
 *   added here" after they copied a picture would be a false statement. Nothing is attached either;
 *   before 2026-11-22 the chat page sent such a copy into the open conversation.
 *
 * Docs: docs/wiki/frontend/modules/chat.md#android-keyboard-media-commitcontent
 */
import { m } from '$lib/paraglide/messages';
import { showToast } from '$lib/stores/toast.svelte';
import { Log } from '$lib/utils/Log';

/** The event the native bridges dispatch on `window`. */
export const KEYBOARD_MEDIA_EVENT = 'canari-keyboard-media';

/** What the native bridge puts in the event's `detail`: the bytes as base64, with a MIME hint. */
export interface KeyboardMediaDetail {
  mime?: string;
  name?: string;
  data?: string;
}

/** A composer that may take keyboard media. */
export interface KeyboardMediaTarget {
  /** A short stable name for logs (`chat`, `post`, `comment`) - never user data. */
  surface: string;
  /** Attaches the file and answers `true`, or answers `false` when this surface cannot take it now. */
  accept: (file: File) => boolean;
}

/** How one event ended; returned so a test can read the decision without a DOM toast. */
export type KeyboardMediaOutcome = 'accepted' | 'refused' | 'no-focus' | 'unreadable';

const TAG = 'KeyboardMedia';
const targets = new Map<HTMLElement, KeyboardMediaTarget>();

/**
 * Registers `el` as a composer taking keyboard media while focus is inside it. Returns the
 * unregister function. Registering the same element again replaces its target.
 */
export function registerKeyboardMediaTarget(
  el: HTMLElement,
  target: KeyboardMediaTarget
): () => void {
  targets.set(el, target);
  return () => {
    if (targets.get(el) === target) targets.delete(el);
  };
}

/** Rebuilds a `File` from the bridge payload; `null` when it carries no readable base64. */
export function keyboardMediaFile(detail: KeyboardMediaDetail | null | undefined): File | null {
  if (!detail?.data) return null;
  try {
    const bin = atob(detail.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const mime = detail.mime || 'image/gif';
    const name = detail.name || `gif-${Date.now()}.${mime.split('/')[1] ?? 'gif'}`;
    return new File([bytes], name, { type: mime });
  } catch {
    return null;
  }
}

/** The innermost registered target containing `active`, so a nested composer wins over its host. */
function targetFor(active: Element): KeyboardMediaTarget | null {
  let best: { el: HTMLElement; target: KeyboardMediaTarget } | null = null;
  for (const [el, target] of targets) {
    if (!el.isConnected || !el.contains(active)) continue;
    if (best === null || best.el.contains(el)) best = { el, target };
  }
  return best?.target ?? null;
}

/** A focused field that registered nothing, named for the log: its declared surface, or its tag. */
function unregisteredSurface(active: Element): string {
  const declared = active.closest<HTMLElement>('[data-media-surface]')?.dataset.mediaSurface;
  return declared ?? `unregistered ${active.tagName.toLowerCase()}`;
}

/** Routes one committed payload to the focused composer, or tells the member it cannot go there. */
export function dispatchKeyboardMedia(
  detail: KeyboardMediaDetail | null | undefined,
  active: Element | null = document.activeElement
): KeyboardMediaOutcome {
  const file = keyboardMediaFile(detail);
  if (file === null) {
    Log.w(TAG, 'committed content carried no readable data');
    showToast(m.keyboard_media_unreadable());
    return 'unreadable';
  }
  const focused = active && active !== document.body ? active : null;
  if (focused === null) {
    Log.w(TAG, `not attached: no focused field (${file.type}, ${file.size} bytes)`);
    return 'no-focus';
  }
  const target = targetFor(focused);
  if (target === null) {
    Log.w(TAG, `refused on ${unregisteredSurface(focused)} (${file.type})`);
    showToast(m.keyboard_media_refused());
    return 'refused';
  }
  if (!target.accept(file)) {
    Log.w(TAG, `refused on ${target.surface} (${file.type})`);
    showToast(m.keyboard_media_refused());
    return 'refused';
  }
  Log.d(TAG, `attached to ${target.surface}: ${file.type}, ${file.size} bytes`);
  return 'accepted';
}

/** Installs the one window listener; the root layout calls it once and disposes it on teardown. */
export function installKeyboardMediaDispatcher(): () => void {
  const onEvent = (e: Event) => {
    dispatchKeyboardMedia((e as CustomEvent<KeyboardMediaDetail>).detail);
  };
  window.addEventListener(KEYBOARD_MEDIA_EVENT, onEvent);
  return () => window.removeEventListener(KEYBOARD_MEDIA_EVENT, onEvent);
}

/**
 * Svelte action: the element is a composer taking keyboard media while focus is inside it.
 * `accept` is read at dispatch time through the latest parameters, so a composer switching into
 * edit mode refuses without re-registering.
 */
export function keyboardMediaTarget(el: HTMLElement, params: KeyboardMediaTarget) {
  let current = params;
  const unregister = registerKeyboardMediaTarget(el, {
    get surface() {
      return current.surface;
    },
    accept: (file) => current.accept(file),
  });
  return {
    update(next: KeyboardMediaTarget) {
      current = next;
    },
    destroy: unregister,
  };
}
