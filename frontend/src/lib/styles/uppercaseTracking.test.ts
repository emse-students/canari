/**
 * SENTENCE CASE, AND NO LETTER-SPACING ON TEXT, OR THIS FAILS.
 *
 * The audit of 2026-11-09 counted 132 `uppercase` and 166 `tracking-*` in the components: every
 * small section label, badge and table header was shouted in capitals with a 0.05-0.1em gap
 * between its letters ("SAINT-ETIENNE" on a profile chip, "APPAREILS" over a settings list). The
 * reference (Facebook and Messenger, see `docs/wiki/frontend/design-reference.md`) sets such labels
 * in sentence case at their weight and colour: the hierarchy comes from size and weight, never
 * from capitals. Nothing reported the drift - `bun run check` and `oxlint` are silent on a class
 * name - so this is the same instrument as `iconButtonScale.test.ts` aimed at the typography.
 *
 * WHAT IS COUNTED: the Tailwind utilities `uppercase` (any variant) and `tracking-wide`,
 * `tracking-wider`, `tracking-widest`, in markup with its comments removed. `first-letter:uppercase`
 * is NOT counted: it capitalises the first letter of a French weekday or month, which
 * `Intl.DateTimeFormat` returns in lower case. `tracking-tight` on page titles belongs to the
 * heading scale, and an arbitrary `tracking-[0.3em]` is the digit spacing of a PIN field.
 *
 * THE ALLOWLIST IS BY FILE AND BY COUNT so it cannot go stale in either direction: a new use in an
 * allowed file fails, and so does an entry whose uses have gone.
 */
import { describe, it, expect } from 'vitest';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { allMarkup, withoutComments } from './markupSources';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A transformed or letter-spaced class token, `first-letter:` excluded. */
const TOKEN =
  /(?<![\w:-])(?:(?!first-letter:)[a-z-]+:)?(?:uppercase|tracking-(?:wide|wider|widest))(?![\w-])/g;

/**
 * THE SAME TWO FACTS WRITTEN AS CSS: `text-transform: uppercase`, and a POSITIVE `letter-spacing` of
 * 0.05em or more (the audit's threshold: below that the gap is optical kerning, not a "label"
 * style). Read in every `.css` file and in the `<style>` of every `.svelte` file, because
 * `.chat-sticky-date-indicator` in `app.css` shouted "LUNDI 9 NOVEMBRE" over a thread whose inline
 * separator is sentence case, and no utility-class scan could see it.
 */
const CSS_TOKEN =
  /text-transform\s*:\s*uppercase|letter-spacing\s*:\s*\+?(?:0?\.(?:0[5-9]|[1-9]\d*)|[1-9]\d*(?:\.\d+)?)(?:em|rem|px)/g;

/** Every `.css` file under `dir`, recursively (generated Paraglide modules hold none). */
function cssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) cssFiles(full, out);
    else if (entry.name.endsWith('.css')) out.push(full);
  }
  return out;
}

const ALLOWED: Record<string, { count: number; why: string }> = {
  'lib/components/posts/CreatePostForm.svelte': {
    count: 1,
    why: 'the file-type badge of an attachment ("pdf", "zip") is an abbreviation read as a code, as a file manager shows it',
  },
  'lib/components/posts/EditPostForm.svelte': {
    count: 1,
    why: 'the same file-type badge as in the composer',
  },
  'lib/components/posts/PostCodeBlock.svelte': {
    count: 2,
    why: 'the language tag of a code block ("js", "sql") is an abbreviation read as a code, as every code editor shows it',
  },
  'lib/components/settings/SettingsPreferencesSection.svelte': {
    count: 1,
    why: 'the locale codes "fr" / "en" of the language switch are abbreviations, written as FR / EN everywhere',
  },
};

describe('uppercase and letter-spacing', () => {
  const found = new Map<string, number>();
  for (const { file, body } of allMarkup(src)) {
    const n = (body.match(TOKEN) ?? []).length;
    if (n > 0) found.set(file.split(sep).join('/'), n);
  }

  // The wordmark (`CanariBrand`) sets no letter-spacing or capitals, so it needs no entry here.
  for (const file of cssFiles(src)) {
    const n = (withoutComments(readFileSync(file, 'utf8')).match(CSS_TOKEN) ?? []).length;
    if (n > 0)
      found.set(
        file
          .slice(src.length + 1)
          .split(sep)
          .join('/'),
        n
      );
  }
  for (const { file, body } of allMarkup(src)) {
    const n = (body.match(CSS_TOKEN) ?? []).length;
    if (n > 0)
      found.set(file.split(sep).join('/'), (found.get(file.split(sep).join('/')) ?? 0) + n);
  }

  it('no component sets text in capitals or spaces its letters outside the allowlist', () => {
    const offenders = [...found].filter(([f]) => !(f in ALLOWED)).map(([f, n]) => `${f} (${n})`);
    expect(offenders, 'use sentence case; see the audit item M3').toEqual([]);
  });

  it('every allowlist entry still matches its exact count', () => {
    const stale = Object.entries(ALLOWED)
      .filter(([f, { count }]) => found.get(f) !== count)
      .map(([f, { count }]) => `${f}: expected ${count}, found ${found.get(f) ?? 0}`);
    expect(stale).toEqual([]);
  });
});
