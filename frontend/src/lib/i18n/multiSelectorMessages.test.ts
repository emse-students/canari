/**
 * A MESSAGE WITH TWO PLURAL SELECTORS RENDERS ITS TEXT, NEVER ITS KEY (1.7.1).
 *
 * The message-format plugin splits a match key on `", "`. A key written `"a=one b=one"` (space only,
 * or a bare comma) is read as ONE selector whose value is `"one b=one"`: no branch ever matches and
 * the compiled function returns its own name, so a toast read "post_attachments_partial". The
 * callers' tests compared the function with itself (`m.x(..)` against `m.x(..)`), which a key
 * satisfies. This file pins the key syntax in both locale files AND renders every combination.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';

type Variant = { match?: Record<string, string> };
type Entry = { selectors?: string[]; match?: Record<string, string> } | Variant[];

const LOCALES = ['fr', 'en'] as const;

function load(locale: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(import.meta.dirname, `../../../messages/${locale}.json`), 'utf8')
  );
}

/** Every `[message, match key]` of a locale whose message declares two selectors or more. */
function multiSelectorKeys(locale: string): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, raw] of Object.entries(load(locale))) {
    const entry = raw as Entry;
    const variants = Array.isArray(entry) ? entry : [entry];
    for (const v of variants) {
      const selectors = (v as { selectors?: string[] }).selectors ?? [];
      if (selectors.length < 2) continue;
      for (const key of Object.keys((v as { match?: Record<string, string> }).match ?? {})) {
        out.push([name, key]);
      }
    }
  }
  return out;
}

describe('multi-selector match keys', () => {
  for (const locale of LOCALES) {
    it(`${locale}: every key joins its selectors with ", " and names each one`, () => {
      const keys = multiSelectorKeys(locale);
      expect(keys.length).toBeGreaterThan(0);
      const bad = keys.filter(
        ([, key]) => !/^[A-Za-z]\w*=[\w*]+(, [A-Za-z]\w*=[\w*]+)+$/.test(key)
      );
      expect(bad).toEqual([]);
    });
  }
});

describe('multi-selector messages render text, not their key', () => {
  const counts = [1, 2];
  const cases: [string, (a: number, b: number, locale: 'fr' | 'en') => string][] = [
    [
      'post_attachments_partial',
      (taken, leftOut, locale) =>
        m.post_attachments_partial({ taken, leftOut, max: 10 }, { locale }),
    ],
    [
      'profile_backup_import_ok',
      (conversations, messages, locale) =>
        m.profile_backup_import_ok({ conversations, messages }, { locale }),
    ],
    [
      'profile_backup_import_ok_other_device',
      (conversations, messages, locale) =>
        m.profile_backup_import_ok_other_device({ conversations, messages }, { locale }),
    ],
    [
      'reel_sendto_delete_everywhere_skipped',
      (done, skipped, locale) =>
        m.reel_sendto_delete_everywhere_skipped({ done, skipped }, { locale }),
    ],
  ];
  for (const [name, render] of cases) {
    for (const locale of LOCALES) {
      it(`${name} (${locale}) for every plural pair`, () => {
        for (const a of counts) {
          for (const b of counts) {
            const text = render(a, b, locale);
            expect(text, `${name} ${a},${b}`).not.toBe(name);
            expect(text).toContain(String(a));
            expect(text).toContain(String(b));
          }
        }
      });
    }
  }
});
