import { Log } from '$lib/utils/Log';

/**
 * Writes a value to the clipboard, for the surfaces whose whole point is that the value gets
 * pasted somewhere else - a partnership code into a shop's checkout, an id into a query.
 *
 * A BUTTON IS THE ONLY WAY TO TAKE A SHORT STRING OFF A PHONE, which is what makes this a
 * component of the feature rather than a convenience. On a coarse pointer the app inverts
 * `user-select` (see `app.css`), and even where it does not, a long press onto a six-character
 * code, a drag of two handles and a "Copy" out of the system menu is a gesture nobody completes
 * for a discount code they are reading at a till.
 *
 * A REFUSAL IS LOGGED RATHER THAN SWALLOWED, and the caller is TOLD: `writeText` rejects on a
 * document that is not focused and in any non-secure context, and a copy button that silently
 * does nothing is indistinguishable from one that worked. The boolean is what lets a call site
 * keep its confirmation honest.
 *
 * @param value - The exact text to place on the clipboard.
 * @param what - What is being copied, for the log line only.
 * @returns `true` once written, `false` when the clipboard refused.
 */
export async function copyText(value: string, what = 'value'): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch (e) {
    Log.d('Clipboard', `refused the write of a ${what}: ${String(e)}`);
    return false;
  }
}
