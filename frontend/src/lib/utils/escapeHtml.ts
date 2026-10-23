/**
 * Escapes a value for use inside a double-quoted HTML attribute, or as text between tags.
 *
 * Load-bearing wherever markup is built as a string - the SEO head, and the export sheets set as
 * `innerHTML` - because what they interpolate arrives from the API: post text, association names,
 * image URLs. `"` alone would be enough to leave the attribute, and `<` to leave the tag, so both
 * are escaped along with `&` (first, or it would double-encode the entities added after it), `'` and
 * `` ` `` (some attribute parsers accept them as delimiters).
 */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}
