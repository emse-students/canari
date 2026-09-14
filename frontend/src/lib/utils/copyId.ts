import { Log } from '$lib/utils/Log';

/**
 * Copies an opaque identifier to the clipboard, for the admin surfaces that display one.
 *
 * AN ID IS SHOWN SHORTENED AND COPIED WHOLE, which is why this exists rather than a `title`
 * attribute or a `truncate`. A 64-hex id is not readable at any width a phone has, and the value an
 * operator wants from it is never "read it" - it is "paste it into the search box next to it, or
 * into a query". So the two needs are answered separately: the render is cut to a length that
 * always fits (see the call sites), and the FULL value goes to the clipboard on a tap.
 *
 * Truncating instead answers neither. `truncate` leaves the hidden half unreadable AND unselectable
 * by pointer, and a `title` tooltip does not exist on a touch screen at all.
 *
 * A REFUSAL IS LOGGED RATHER THAN SWALLOWED. `writeText` rejects on a document that is not focused
 * and in any non-secure context, and a copy button that silently does nothing is indistinguishable
 * from one that worked - so the one line this leaves is the only trace there would be.
 */
export async function copyId(id: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(id);
  } catch (e) {
    Log.d('CopyId', `clipboard refused the write: ${String(e)}`);
  }
}
