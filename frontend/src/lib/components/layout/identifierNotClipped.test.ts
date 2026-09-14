import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { allMarkup } from '$lib/styles/markupSources';

/**
 * AN OPAQUE IDENTIFIER IS SHORTENED, NEVER TRUNCATED - and the difference is not cosmetic.
 *
 * The truncation census (see the design reference) closed with one rule that generalises past the
 * `<h1>` its sibling guard asserts: `truncate` is a LIST affordance, and it is right exactly when
 * the full value is one tap away. An id fails that test twice over.
 *
 * - **It cannot be read.** A 64-hex id wants 457px of monospace at the size these rows use; the
 *   `/admin/users` row gave it 234px at 390px, so 24 characters were simply gone - on the one page
 *   whose search box matches against that very id.
 * - **It cannot be recovered.** `truncate` is `overflow: hidden`, so the hidden half is not
 *   selectable with a pointer either, and the `title` attribute two of these sites carried does not
 *   exist on a touch screen at all.
 *
 * The answer the repository had already found, in `/admin/moderation`, is to render a SHORT prefix
 * and put the WHOLE value on the clipboard: `{id.slice(0, 8)}…` inside a button calling `copyId`.
 * It fits at every width, so nothing is ever cut, and the value an operator actually wants - the
 * one they paste into a query - is a tap away rather than unreachable. Three sites did it the other
 * way on 2026-09-14 and now do not.
 *
 * WHAT THIS ASSERTS, AND WHY IT IS NARROW. Only an element whose ENTIRE content is a single
 * identifier expression. A composite line that happens to contain an id alongside other text (a
 * device row with a version after it, say) is a different question - it is prose, it has a natural
 * reading order, and clipping its tail loses the least important part. Asserting both with one rule
 * would answer neither, which is the reason the `<h1>` guard beside this one is narrow too.
 */
const ROOT = process.cwd();

/** `truncate` and `line-clamp-N` both clip; only the direction differs. */
const CLIPS = /\b(truncate|line-clamp-\d+)\b/;

/**
 * Elements whose whole body is one `{...}` expression, paired with that element's attributes.
 * Whitespace is collapsed first so an attribute list spanning lines is still one string.
 */
function soleExpressionElements(body: string): { attrs: string; expr: string }[] {
  const flat = body.replace(/\s+/g, ' ');
  const out: { attrs: string; expr: string }[] = [];
  const element = /<(p|span|div|td|code|button|h[1-6])\b([^>]*)>\s*\{([^{}]+)\}\s*<\/\1>/g;
  let m = element.exec(flat);
  while (m !== null) {
    out.push({ attrs: m[2], expr: m[3].trim() });
    m = element.exec(flat);
  }
  return out;
}

/** `user.id`, `postId`, `row.deviceId` - an expression that names an identifier and nothing else. */
const IS_IDENTIFIER = /^[A-Za-z_$][\w.$?]*(\bid|Id|ID)$/;

describe('an opaque identifier is never clipped', () => {
  const markup = allMarkup(join(ROOT, 'src'));

  it('reads the whole markup tree, so the guard is not guarding an empty set', () => {
    expect(markup.length).toBeGreaterThan(200);
  });

  it('finds elements whose whole content is one expression', () => {
    const found = markup.flatMap(({ body }) => soleExpressionElements(body));
    expect(found.length).toBeGreaterThan(20);
  });

  it('recognises an identifier expression, and only an identifier', () => {
    expect(IS_IDENTIFIER.test('user.id')).toBe(true);
    expect(IS_IDENTIFIER.test('postId')).toBe(true);
    expect(IS_IDENTIFIER.test('row.device.deviceId')).toBe(true);
    expect(IS_IDENTIFIER.test('m.admin_users_empty()')).toBe(false);
    expect(IS_IDENTIFIER.test('user.displayName')).toBe(false);
  });

  it('no element whose whole content is an identifier carries truncate or line-clamp', () => {
    const offenders = markup.flatMap(({ file, body }) =>
      soleExpressionElements(body)
        .filter(({ attrs, expr }) => IS_IDENTIFIER.test(expr) && CLIPS.test(attrs))
        .map(({ expr }) => `${file} {${expr}}`)
    );

    expect(offenders).toEqual([]);
  });
});
