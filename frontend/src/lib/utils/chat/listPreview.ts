/**
 * WHICH MESSAGE A CONVERSATION'S ROW IN THE LIST SHOWS UNDER ITS NAME.
 *
 * A DEVICE NOTICE IS NEVER THE PREVIEW (owner, 2026-10-31). "X added a device" is written in every
 * 1:1 and group shared with X (`deviceNotices.svelte.ts`), all at once: when it was the preview, a
 * contact's new phone turned every row of the list into the same line, and the conversations could
 * no longer be told apart. The row shows the last message before it instead - what someone said, or
 * what changed in the conversation ("X added Y" stays, it is about this conversation) - and, when
 * the notice is all there is, the row's own empty preview.
 *
 * A member's pending join ask is not a message at all and is never the preview either: it is a line
 * at the end of its thread (`JoinRequestRow`).
 */

/** The id prefix of the device notice: one per conversation, device and key. */
export const DEVICE_ADDED_LINE_PREFIX = 'device-added:';

/** The message id of the device notice for `key` in `groupId`. */
export function deviceAddedLineId(groupId: string, key: string): string {
  return `${DEVICE_ADDED_LINE_PREFIX}${groupId}:${key}`;
}

/** Whether `id` is a device notice's ({@link deviceAddedLineId}). */
export function isDeviceAddedLine(id: string): boolean {
  return id.startsWith(DEVICE_ADDED_LINE_PREFIX);
}

/**
 * The content the list shows for a conversation: the last message that is not a device notice, or
 * `undefined` when there is none.
 */
export function previewContentOf(
  messages: readonly { id: string; content: string }[]
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isDeviceAddedLine(messages[i].id)) return messages[i].content;
  }
  return undefined;
}
