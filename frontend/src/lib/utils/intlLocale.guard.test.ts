import { describe, expect, it } from 'vitest';
import { relativeTo, sourceFiles } from '../../test/sourceTree';

/**
 * A DATE OR AN AMOUNT IS FORMATTED IN THE LANGUAGE THE APP IS READ IN, so a formatter is handed
 * `intlLocale()` and never a region tag of its own. A literal tag is invisible in French - the page
 * reads right - and wrong for every English reader, which no type and no other test sees. So the
 * sources are read: a `'xx-XX'` string given straight to an `Intl` constructor or to a
 * `toLocale...String` call fails here, wherever it is written.
 */

const SOURCES = sourceFiles({
  under: 'src',
  extensions: ['ts', 'svelte'],
  tests: 'exclude',
  skipDirs: ['proto', 'paraglide'],
}).map(({ path, text }) => ({ file: relativeTo(path, 'src'), text }));

/** An `Intl` constructor or a `toLocale...String` call whose first argument is a literal tag. */
const LITERAL_TAG = /(?:Intl\.\w+|\.toLocale\w*String)\(\s*['"`][a-z]{2}-[A-Z]{2}['"`]/g;

/**
 * The ternary `getLocale() === 'en' ? 'en-US' : 'fr-FR'` in any spelling (quotes, spacing, line
 * breaks, reversed operands or operator). No `g` flag: a global regex keeps a `lastIndex` between
 * `.test()` calls.
 */
const LOCALE_TERNARY =
  /getLocale\(\)\s*[!=]==\s*['"`][a-z]{2}['"`]\s*\?\s*['"`][a-z]{2}-[A-Z]{2}['"`]\s*:\s*['"`][a-z]{2}-[A-Z]{2}['"`]/;

describe('formatters follow the app language', () => {
  it('reads sources at all', () => {
    expect(SOURCES.length).toBeGreaterThan(500);
    expect(SOURCES.some(({ file }) => file === 'lib/utils/intlLocale.ts')).toBe(true);
  });

  /**
   * The formatters that are NOT read by a person: each one's output is parsed or compared by the
   * code, so its tag is part of the computation and must not follow the language. One entry per
   * call, with what it computes; an entry whose call is gone fails, so the list cannot outlive it.
   */
  const COMPUTED = [
    ["lib/birthdays/birthdaysToday.svelte.ts: Intl.DateTimeFormat('en-CA'", 'a YYYY-MM-DD key'],
    [
      "lib/bookings/grid.ts: Intl.DateTimeFormat('en-US'",
      'the UTC offset, read with formatToParts',
    ],
    ["lib/bookings/zonedTime.ts: Intl.DateTimeFormat('en-US'", 'wall-clock parts of a zone'],
    ["lib/utils/dates.ts: Intl.DateTimeFormat('en-US'", 'the day number of an instant in a zone'],
    ["lib/utils/mediaViewerInfo.ts: Intl.DateTimeFormat('en-US'", 'two years compared'],
  ].map(([call]) => call);

  it('no formatter is handed a literal region tag, except the computed ones named here', () => {
    const found = SOURCES.flatMap(({ file, text }) =>
      [...text.matchAll(LITERAL_TAG)].map((match) => `${file}: ${match[0]}`)
    );
    expect(found.toSorted()).toEqual(COMPUTED.toSorted());
  });

  it('no call site copies the language-to-tag ternary; intlLocale() is the one place', () => {
    const found = SOURCES.filter(
      ({ file, text }) => file !== 'lib/utils/intlLocale.ts' && LOCALE_TERNARY.test(text)
    ).map(({ file }) => file);
    expect(found).toEqual([]);
  });

  it('the ternary rule sees every spelling of it', () => {
    const forbidden = [
      "getLocale() === 'en' ? 'en-US' : 'fr-FR'",
      'getLocale()==="en"?"en-GB":"fr-FR"',
      "getLocale() === 'fr' ? 'fr-FR' : 'en-US'",
      "getLocale() !== 'en'\n  ? 'fr-FR'\n  : 'en-US'",
    ];
    for (const line of forbidden) expect(LOCALE_TERNARY.test(line)).toBe(true);
    expect(LOCALE_TERNARY.test('intlLocale()')).toBe(false);
  });

  it('the rule sees what it forbids', () => {
    const forbidden = [
      "new Intl.DateTimeFormat('fr-FR', { weekday: 'long' })",
      "new Intl.NumberFormat('fr-FR', { style: 'currency' })",
      "new Date(iso).toLocaleString('fr-FR', {})",
      'd.toLocaleDateString("en-US")',
      "d.toLocaleTimeString(\n  'fr-FR'\n)",
    ];
    for (const line of forbidden) expect(line.match(LITERAL_TAG)).not.toBeNull();
    expect('new Intl.DateTimeFormat(intlLocale(), {})'.match(LITERAL_TAG)).toBeNull();
  });
});
