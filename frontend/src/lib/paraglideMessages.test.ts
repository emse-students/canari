import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * Guardrail on the two translation files, because NOTHING else looks at their contents.
 *
 * `paraglide-js compile` reads them and is happy with anything well-formed; `svelte-check` types
 * the generated call sites, not the sentences. So a French plural spelled `(s)` and a key present
 * in one locale only both ship silently, and both did.
 *
 * WHY `(s)` IS A DEFECT AND NOT A STYLE. The message format supports real plural variants - a
 * `local x = count: plural` declaration and one pattern per CLDR category - and until 2026-09-09 no
 * message in this repository used it, so 26 counters read "1 fichier(s) en attente". The parenthesis
 * is also WRONG rather than merely ugly in French, where the two categories do not split where
 * English's do: `one` covers 0 and 1, so "0 fichier" is singular and "(s)" mis-states it either way.
 *
 * Gender is not number and is not fixable this way - nothing in the app knows a reader's gender - so
 * `invite(e)` is caught by the same rule and answered by rewriting the sentence not to ask.
 */
const here = dirname(fileURLToPath(import.meta.url));
const MESSAGES_DIR = resolve(here, '../../messages');
const LOCALES = ['fr', 'en'] as const;

/**
 * `(s)`, `(e)`, `(es)`, `(x)`, `(ies)` - the shapes a lazy plural or gender takes in both locales.
 * Deliberately narrow: it must not fire on ordinary parenthesised prose.
 */
const LAZY_SUFFIX = /\((s|e|es|x|ies)\)/;

/**
 * Keys where the parenthesis is not a plural.
 *
 * `admin_status_col_ttl` is a table header reading `TTL (s)`: the `(s)` is the UNIT, seconds. An
 * allowlist and not a looser pattern, so the next exception has to be argued for rather than
 * absorbed.
 */
const NOT_A_PLURAL = new Set(['admin_status_col_ttl']);

type Pattern = string;
type ComplexMessage = { match?: Record<string, Pattern> };
type MessageValue = Pattern | ComplexMessage[];

function load(locale: string): Record<string, MessageValue> {
  const raw = readFileSync(resolve(MESSAGES_DIR, `${locale}.json`), 'utf8');
  return JSON.parse(raw) as Record<string, MessageValue>;
}

/** Every literal pattern a message can render, flat - a simple string, or each variant of a complex one. */
function patternsOf(value: MessageValue): Pattern[] {
  if (typeof value === 'string') return [value];
  return value.flatMap((variant) => Object.values(variant.match ?? {}));
}

describe('the translation files', () => {
  for (const locale of LOCALES) {
    it(`${locale}: spells plurals as variants, never as "(s)"`, () => {
      const offenders = Object.entries(load(locale))
        .filter(([key]) => key !== '$schema' && !NOT_A_PLURAL.has(key))
        .filter(([, value]) => patternsOf(value).some((p) => LAZY_SUFFIX.test(p)))
        .map(([key]) => key);

      // Named rather than counted: the failure has to say which key to go and fix.
      expect(offenders).toEqual([]);
    });
  }

  it('carries the same keys in both locales', () => {
    // A key in one file only compiles fine and renders its own NAME to the reader of the other
    // locale - `paraglide` falls back to the key string, not to the base locale.
    const [fr, en] = LOCALES.map((l) => new Set(Object.keys(load(l))));
    expect({
      missingFromEn: [...fr].filter((k) => !en.has(k)),
      missingFromFr: [...en].filter((k) => !fr.has(k)),
    }).toEqual({ missingFromEn: [], missingFromFr: [] });
  });

  it('gives every variant of a message the same input variables, so no branch drops one', () => {
    // A counter whose `other` branch forgot `{count}` renders "messages non lus" with no number,
    // and only in the plural - the branch a developer testing with one item never sees.
    const wrong: string[] = [];
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(load(locale))) {
        const patterns = patternsOf(value);
        if (patterns.length < 2) continue;
        const vars = patterns.map((p) =>
          [...p.matchAll(/\{(\w+)\}/g)]
            .map((m) => m[1])
            .sort()
            .join(',')
        );
        if (new Set(vars).size > 1) wrong.push(`${locale}:${key}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
