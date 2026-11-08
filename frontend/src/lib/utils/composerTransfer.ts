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

/**
 * The `http(s)` image addresses a drop announces when it hands over no file - a picture dragged out
 * of another web page. The browser sends the PAGE's reference to the image (`text/uri-list`, and an
 * `<img src>` inside `text/html`), never its bytes, so there is no `File` to read: the address is the
 * only thing a composer can act on, by fetching it.
 *
 * `blob:` and `data:` addresses are left out on purpose: a `blob:` URL is only readable by the
 * origin that minted it (a Messenger tab's, reported 2026-09-18), so asking for it is certain to
 * fail and the caller would learn that by failing.
 *
 * @param dt - the transfer from a `DragEvent.dataTransfer`.
 * @returns the distinct fetchable addresses, in transfer order; empty when there is none.
 */
export function webImageUrlsFromTransfer(dt: DataTransfer | null | undefined): string[] {
  if (!dt) return [];
  const found: string[] = [];
  const add = (raw: string | null | undefined) => {
    const url = (raw ?? '').trim();
    if (/^https?:\/\//i.test(url) && !found.includes(url)) found.push(url);
  };

  (dt.getData('text/uri-list') ?? '')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .forEach(add);

  const html = dt.getData('text/html') ?? '';
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('img').forEach((img) => add(img.getAttribute('src')));
  }
  return found;
}

/**
 * The drop effect to announce over a composer.
 *
 * Forcing `copy` is a defect when the source offered only `move` (`effectAllowed`): an image dragged
 * out of a web page does, and a browser REFUSES a drop whose effect the source did not allow - the
 * cursor stays the "move" arrow and `drop` never fires (the reported symptom, 2026-11-08). The
 * composer never moves anything, so `copy` when it is allowed and otherwise the first effect the
 * source does allow (`link`, then `move`).
 *
 * @param dt - the transfer of a `dragover`.
 * @returns the value to assign to `dropEffect`.
 */
export function dropEffectFor(dt: DataTransfer): 'copy' | 'link' | 'move' {
  const allowed = dt.effectAllowed;
  if (allowed === 'none' || allowed === 'uninitialized') return 'copy';
  const lower = allowed.toLowerCase();
  if (lower.includes('copy') || lower === 'all') return 'copy';
  if (lower.includes('link')) return 'link';
  return 'move';
}

/** Why an image address could not become a file; carried as a field so nobody reads the message. */
export type WebImageFailure = 'unreachable' | 'http' | 'not-image';

/** A dropped web image that could not be fetched, classified at the throw. */
export class WebImageFetchError extends Error {
  readonly reason: WebImageFailure;
  readonly url: string;
  constructor(reason: WebImageFailure, url: string) {
    super(`web image ${reason}`);
    this.name = 'WebImageFetchError';
    this.reason = reason;
    this.url = url;
  }
}

/**
 * Fetches a dropped web image as a `File`, as the browser's CORS rules allow.
 *
 * `unreachable` is what a cross-origin host that sends no CORS headers looks like (the fetch rejects
 * with an opaque `TypeError`, indistinguishable from being offline) - the caller says so rather than
 * attaching nothing in silence.
 *
 * @param url - an `http(s)` image address from `webImageUrlsFromTransfer`.
 * @param fetchImpl - injectable for tests.
 * @throws WebImageFetchError classified by `reason`.
 */
export async function fetchWebImageFile(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<File> {
  let response: Response;
  try {
    response = await fetchImpl(url, { mode: 'cors', credentials: 'omit' });
  } catch {
    throw new WebImageFetchError('unreachable', url);
  }
  if (!response.ok) throw new WebImageFetchError('http', url);
  const blob = await response.blob();
  const type = (blob.type || response.headers.get('content-type') || '').split(';')[0];
  if (!type.startsWith('image/')) throw new WebImageFetchError('not-image', url);
  let name = 'image';
  try {
    name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '') || name;
  } catch {
    // an address that does not parse keeps the generic name
  }
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += `.${type.slice('image/'.length).split('+')[0]}`;
  return new File([blob], name, { type, lastModified: Date.now() });
}
