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
 * @param text - The exact text to place on the clipboard.
 * @param opts.what - What is being copied; picks the confirmation and labels the log line.
 * @param opts.silent - Skip the SUCCESS toast, for a caller that confirms in a richer way. The
 *   failure toast is never skipped.
 * @returns `{ ok: true }` once written, else the typed reason it was not.
 */
export async function copyText(
  text: string,
  opts: { what: CopyKind; silent?: boolean }
): Promise<CopyResult> {
  const { what, silent = false } = opts;
  Log.d('Clipboard', `copying a ${what} (${text.length} chars)`);
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard?.writeText) {
    Log.d('Clipboard', `no clipboard in this context, a ${what} was not copied`);
    showToast(m.clipboard_copy_failed(), 'error');
    return { ok: false, reason: 'unavailable' };
  }
  try {
    await clipboard.writeText(text);
  } catch (e) {
    Log.d('Clipboard', `refused the write of a ${what}: ${String(e)}`);
    showToast(m.clipboard_copy_failed(), 'error');
    return { ok: false, reason: 'refused' };
  }
  if (!silent) showToast(CONFIRMATION[what](), 'info');
  return { ok: true };
}
