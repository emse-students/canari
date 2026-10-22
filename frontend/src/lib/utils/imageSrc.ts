import { Log } from './Log';

/**
 * `value` when it may be used as an image source drawn from server data, `null` otherwise.
 *
 * Kept: an app-relative path (`/api/media/...`, absolutized by the caller) and an absolute `http:` or
 * `https:` URL. Dropped: every other scheme (`javascript:`, `data:`, ...), a protocol-relative
 * `//host` and any other relative form. The server holds association image URLs to the same shape on
 * write; this is the reader's half, so a value written before that rule, or by an older server, is
 * still never handed to the DOM as something other than an image URL.
 */
export function imageSrcOrNull(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (v.startsWith('/') && !v.startsWith('//')) return v;
  if (/^https?:\/\//i.test(v)) return v;
  // Info, not debug: the server refuses such a value on write, so reaching this branch means a row
  // predating that rule - a line a device reading must be able to name. The value is not printed.
  Log.i('imageSrc', `dropped an image URL that is neither a path nor http(s) (length ${v.length})`);
  return null;
}
