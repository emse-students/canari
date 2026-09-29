import { copyText } from '$lib/utils/clipboard';

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
 * THE WRITE ITSELF IS {@link copyText}, which every copy button in the app shares - including the
 * refusal log, which is the only trace a clipboard that says no would leave. What stays here is the
 * id-shaped contract above: these call sites show a cut value and copy the whole one.
 */
export async function copyId(id: string): Promise<void> {
  await copyText(id, 'id');
}
