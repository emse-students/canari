/**
 * A PICKED FILE'S BYTES ARE READ AT THE PICK, AND A FILE WITH NONE IS REFUSED THERE (P1 of 1.8.1).
 *
 * WHY. On Android the composer's pickers are `<input type="file">`, and the `File` the WebView hands
 * back is a VIEW of a `content://` URI owned by another app (the gallery, the photo picker, a cloud
 * provider) - not bytes. The composer staged that view and read it only at the Send tap, after the
 * picker's round trip through the background, and a member's every in-app pick was then queued with
 * ZERO bytes (`payload read ... (0 file bytes)`) and retried until withdrawn - while the share sheet,
 * whose files `IncomingShare.kt` copies at once, sent the same day. A view whose provider reports no
 * length, streams nothing, or no longer grants the read resolves `arrayBuffer()` EMPTY rather than
 * throwing, so nothing between the pick and the upload could tell.
 *
 * WHAT. {@link ownPickedFile} reads the file whole, once, at the pick, and hands back a `File`
 * backed by THOSE bytes - so what is staged, compressed, queued and uploaded is what was read, and
 * nothing downstream depends on another app's grant any more. A read that throws or yields no byte is
 * a {@link PickedFileUnreadableError}, typed at the throw: the composer says so (Paraglide) and never
 * stages it, so it can never be queued.
 *
 * See docs/wiki/frontend/modules/chat.md#a-picked-file-is-read-at-the-pick.
 */

/** Why a picked file was refused: its read threw, or it gave back no byte. */
export type PickedFileUnreadableReason = 'unreadable' | 'empty';

/**
 * A picked (or about-to-be-queued) file holds no readable byte on this device. Permanent for THIS
 * `File`: reading it again answers the same, so it is refused, said, and never queued.
 */
export class PickedFileUnreadableError extends Error {
  constructor(
    readonly reason: PickedFileUnreadableReason,
    /** What the picker REPORTED (`File.size`), which a content view may state wrongly. */
    readonly reportedSize: number,
    cause?: unknown
  ) {
    super(
      reason === 'empty'
        ? `the picked file holds no bytes (reported ${reportedSize})`
        : `the picked file could not be read (reported ${reportedSize})`,
      { cause }
    );
    this.name = 'PickedFileUnreadableError';
  }
}

/**
 * Reads `file` whole and returns a `File` backed by the bytes read, with the same name, type and
 * date.
 *
 * @throws {PickedFileUnreadableError} when the read throws (`unreadable`) or returns no byte
 *         (`empty`).
 */
export async function ownPickedFile(file: File): Promise<File> {
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch (e) {
    throw new PickedFileUnreadableError('unreadable', file.size, e);
  }
  if (bytes.byteLength === 0) throw new PickedFileUnreadableError('empty', file.size);
  return new File([bytes], file.name, { type: file.type, lastModified: file.lastModified });
}
