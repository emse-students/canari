/**
 * The files a paste or a drop is carrying, read the one way that sees all of them.
 *
 * WHY THIS IS NOT `Array.from(dt.files)`. A `DataTransfer` exposes its payload twice and the two
 * lists do not agree. A drop from the file manager fills `files`. A paste of a SCREENSHOT does not:
 * Chromium and WebKit put the bitmap in `items` as a `kind: 'file'` entry and leave `files` empty,
 * which is why this codebase already had two different collectors - `ChatComposer` read `files` for
 * a drop and `items` for a paste, each correct only for its own event. One of the two had to be
 * wrong somewhere, and the pair is what this replaces.
 *
 * `items` alone is not the answer either: it is empty for a drop on some engines, and `getAsFile`
 * returns `null` for the `kind: 'string'` entries a rich drag always carries alongside. Reading
 * both and preferring `files` when it has anything keeps every case and invents no order of its
 * own.
 *
 * @param dt - the transfer from a `DragEvent.dataTransfer` or a `ClipboardEvent.clipboardData`.
 * @returns every real file in it, in the order the transfer lists them; empty when there is none.
 */
export function filesFromTransfer(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];

  const direct = Array.from(dt.files ?? []);
  if (direct.length > 0) return direct;

  return Array.from(dt.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file);
}

/**
 * Whether a transfer is carrying something a composer must refuse to INSERT.
 *
 * A composer body is Markdown: `serializeMentionEditor` keeps text, `<br>`, block boundaries and
 * mention chips, and walks THROUGH everything else. An `<img>` pasted or dropped into it therefore
 * renders on screen and is silently gone the moment it is saved - the editor showing something the
 * document cannot hold.
 *
 * It is worse than a disappointment when the image belongs to another origin. Dropping a picture
 * out of a Messenger tab hands over `text/html` naming a `blob:https://www.messenger.com/...` URL,
 * and the page that tries to render it is refused by the browser with a security error the reader
 * has no way to act on (reported 2026-09-18).
 *
 * So nothing rich is ever inserted, and this predicate is not consulted to decide THAT - a composer
 * inserts `text/plain` and nothing else, unconditionally. It exists for the one thing that is
 * genuinely a judgement: whether a transfer carrying no file was nevertheless carrying something,
 * so a caller can tell "an empty drop" from "a drop whose content was refused".
 *
 * @param dt - the transfer being examined.
 * @returns true when it carries markup or a URL that a Markdown body cannot represent.
 */
export function carriesUninsertableMarkup(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  const types = Array.from(dt.types ?? []);
  return types.includes('text/html') || types.includes('text/uri-list');
}

/**
 * The LOCAL FILE addresses a drop announces when it hands over no file - a file drop the page was
 * refused, never text to insert.
 *
 * Reported 2026-09-25 (Firefox, Nemo): dropping a file into the composer pasted its NAME. Nemo offers
 * Firefox the file only as a `file:///...` URI (`text/uri-list`) and its path as `text/plain`, so
 * `files` and `items` are both empty and the drop looked like text. A page cannot read a local file
 * from its address, so there is no file to recover here - but there is a fact to act on: an address
 * of a local file, or an absolute path, is what a file manager sends for a FILE, and inserting it is
 * the wrong reading. The caller refuses the insertion and says why instead.
 *
 * @param dt - the transfer from a `DragEvent.dataTransfer`.
 * @returns the `file:` URIs or absolute paths it carries, one per dragged file; empty otherwise.
 */
export function localFileAddressesFromTransfer(dt: DataTransfer | null | undefined): string[] {
  if (!dt) return [];
  const lines = (type: string) =>
    (dt.getData(type) ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      // RFC 2483: a `#` line in a URI list is a comment.
      .filter((line) => line && !line.startsWith('#'));

  const uris = lines('text/uri-list');
  if (uris.length > 0 && uris.every((uri) => uri.startsWith('file:'))) return uris;

  const plain = lines('text/plain');
  if (plain.length > 0 && plain.every((line) => line.startsWith('file:') || line.startsWith('/'))) {
    return plain;
  }
  return [];
}
