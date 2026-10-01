/**
 * A FILE INTO THE COMPOSER ON THE iPHONE (O14) - what `DOM.setFileInputFiles` does on Chromium, done
 * by the page itself, because the WebKit inspector protocol has no way to give an input a file.
 *
 * The bytes travel INSIDE the expression (base64), the page builds `File`s from them, puts them on
 * the composer's `<input type=file>` through a `DataTransfer`, and fires the `change` the app
 * listens to - exactly what WebKit does after the system picker returns, so the app's own path from
 * that event on is the one measured. What is NOT measured is the picker: a row about the PHOTOS or
 * FILES sheet itself still needs WDA. Reaching the page at all needs a BENCH build (`tauri/devtools`,
 * the only inspectable one), which is this observable's gate (docs/wiki/cross-client-ios.md).
 *
 * Pure: `chat.mjs attachFiles` reads the files and evaluates; `phone-ios-selftest.mjs` runs the
 * expression against a stub DOM.
 */

/** The content types the composer's `accept` list and the rig's fixtures use. */
const TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  pdf: 'application/pdf',
  zip: 'application/zip',
  txt: 'text/plain',
};

/** The type a picker would report for `name`, from its extension; `''` for one it would not know. */
export const contentTypeOf = (name) => TYPES[String(name).split('.').pop()?.toLowerCase() ?? ''] ?? '';

/**
 * The expression that stages `files` on the first input matching `selector` and fires `change`.
 * Answers the number of files the input now holds, or a string saying why it could not.
 *
 * @param {{ name: string, type: string, b64: string }[]} files
 * @param {string} [selector]
 */
export function fileInjectionExpression(files, selector = 'input[type=file]') {
  return `(function () {
  var input = document.querySelector(${JSON.stringify(selector)});
  if (!input) return 'no file input matches ${selector.replace(/['\\]/g, '')}';
  var dt = new DataTransfer();
  ${JSON.stringify(files)}.forEach(function (f) {
    var raw = atob(f.b64);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.type }));
  });
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return input.files.length;
})()`;
}
