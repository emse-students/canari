import { m } from '$lib/paraglide/messages';
import { showToast } from '$lib/stores/toast.svelte';
import { Log } from '$lib/utils/Log';

/**
 * What is being copied. It picks the confirmation the member reads ("Lien copie", "Code copie"...)
 * and names the write in the log, so a call site states its subject once and nothing else.
 */
export type CopyKind = 'link' | 'code' | 'text' | 'id';

/**
 * How a copy ended, as a type so a caller never branches on a message:
 * - `unavailable`: there is no `navigator.clipboard` (a non-secure context, an old WebView).
 * - `refused`: `writeText` rejected (an unfocused document, a denied permission).
 */
export type CopyResult = { ok: true } | { ok: false; reason: 'unavailable' | 'refused' };

/** The confirmation each kind of copy shows. A function, so Paraglide resolves the locale at call time. */
const CONFIRMATION: Record<CopyKind, () => string> = {
  link: () => m.clipboard_copied_link(),
  code: () => m.clipboard_copied_code(),
  text: () => m.clipboard_copied_text(),
  id: () => m.clipboard_copied_id(),
};

/**
 * THE ONE CLIPBOARD WRITE OF THE APP: writes `text`, then SAYS WHAT HAPPENED with a toast.
 *
 * It exists because a tap on "Copy" whose only effect is invisible is indistinguishable from a tap
 * that did nothing (user, 2026-10-30: *"Copier le lien ... aucune confirmation visuelle"*), and
 * because every call site that wrote its own `navigator.clipboard.writeText` either showed nothing,
 * swallowed a refusal, or drew a private "Copie" state that lied when the write had been refused.
 * One helper owns the three answers: the write, the confirmation on success and the failure toast.
 *
 * THERE IS ONE BACKEND AND NO FALLBACK. The web and the Tauri WebViews (Android, iOS, desktop) all
 * expose `navigator.clipboard.writeText` in the secure contexts the app is served from, and no
 * Tauri clipboard plugin is installed. A context without it, or a write the browser refuses, is
 * reported as such and LOGGED - an `execCommand('copy')` shim would hide the context that needs
 * fixing.
 *
 * `writeText` is only honoured with a user gesture and a focused document, so call this from the
 * click handler and, where something async must come first, accept the `refused` result: the failure
 * toast then tells the member to copy by hand from the field the call site shows.
 *
 * A TEXT THAT IS STILL BEING PRODUCED IS PASSED AS A PROMISE, never awaited by the caller first.
 * WebKit (the iPhone app and Safari) honours a clipboard write only inside the tap's gesture, and
 * an `await` of a network round trip (an invite minted on the tap) ends the gesture before
 * `writeText` runs. So a promise takes the `ClipboardItem` road, called SYNCHRONOUSLY from the
 * handler: the browser keeps the gesture while the promise resolves. If the promise itself rejects,
 * that error is RETHROWN for the caller's own handling (it is not a clipboard refusal, and gets no
 * copy-failed toast).
 *
 * @param text - The exact text to place on the clipboard, or a promise of it.
 * @param opts.what - What is being copied; picks the confirmation and labels the log line.
 * @param opts.silent - Skip the SUCCESS toast, for a caller that confirms in a richer way. The
 *   failure toast is never skipped.
 * @returns `{ ok: true }` once written, else the typed reason it was not.
 * @throws whatever a promised text rejects with.
 */
export async function copyText(
  text: string | Promise<string>,
  opts: { what: CopyKind; silent?: boolean }
): Promise<CopyResult> {
  const { what, silent = false } = opts;
  const promised = typeof text !== 'string';
  Log.d('Clipboard', `copying a ${what}${promised ? ' (promised)' : ` (${text.length} chars)`}`);
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  const supported = promised
    ? !!clipboard?.write && typeof ClipboardItem !== 'undefined'
    : !!clipboard?.writeText;
  if (!clipboard || !supported) {
    Log.d('Clipboard', `no clipboard in this context, a ${what} was not copied`);
    // The caller still owns the promised text (a minted invite): surface ITS failure, not ours.
    if (promised) await text;
    showToast(m.clipboard_copy_failed(), 'error');
    return { ok: false, reason: 'unavailable' };
  }
  let sourceError: { error: unknown } | null = null;
  try {
    if (promised) {
      const blob = text.then(
        (t) => new Blob([t], { type: 'text/plain' }),
        (error: unknown) => {
          sourceError = { error };
          throw error;
        }
      );
      await clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
    } else {
      await clipboard.writeText(text);
    }
  } catch (e) {
    if (sourceError) {
      Log.d('Clipboard', `the text of a ${what} was never produced: ${String(e)}`);
      throw (sourceError as { error: unknown }).error;
    }
    Log.d('Clipboard', `refused the write of a ${what}: ${String(e)}`);
    showToast(m.clipboard_copy_failed(), 'error');
    return { ok: false, reason: 'refused' };
  }
  if (!silent) showToast(CONFIRMATION[what](), 'info');
  return { ok: true };
}
