/**
 * An `attachment` `Content-Disposition` for a file name that may hold any character: an ASCII
 * `filename=` for old clients (accents stripped, everything else outside `[A-Za-z0-9_- ]` dropped,
 * spaces as `_`) and the real name as RFC 5987 `filename*=UTF-8''...`, which every current browser
 * prefers. A name whose ASCII form is empty falls back to `asciiStem` plus the extension.
 *
 * One implementation for the XLSX export and a form answer's file: a header built twice is a
 * header that escapes differently twice.
 */
export function contentDisposition(name: string, asciiStem: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot).replace(/[^a-zA-Z0-9.]/g, '') : '';
  const ascii = stem
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9_\- ]/g, '')
    .trim()
    .replace(/\s+/g, '_');
  // `encodeURIComponent` leaves `'()*` alone, and `'` is the delimiter of the RFC 5987 value.
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${ascii || asciiStem}${ext}"; filename*=UTF-8''${encoded}`;
}
