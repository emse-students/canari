/**
 * THE TEST SUITE READS ITS MESSAGES FROM A SECOND COMPILE, AND THIS IS WHAT STOPS THE TWO DRIFTING.
 *
 * `vitest.config.ts` aliases `$lib/paraglide` to `.paraglide-test/` (`locale-modules`: ten files)
 * instead of `src/lib/paraglide/` (`message-modules`: ~3,300 files, which the app wants for
 * tree-shaking and which cost the suite ~70 % of its wall-clock). Same messages, same runtime, a
 * different layout - so the only ways to go wrong are the alias silently not applying, and the
 * test output being compiled from other messages than the app's. Both are asserted here.
 * See docs/wiki/test-suite-reform.md (WP-T1).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

/** Message keys the APP build exports: one `export * from './<key>.js'` per message module. */
function appKeys(): string[] {
  const index = readFileSync(resolve(root, 'src/lib/paraglide/messages/_index.js'), 'utf8');
  return [...index.matchAll(/export \* from '\.\/(.+)\.js'/g)].map((match) => match[1]).sort();
}

describe('the test-only Paraglide compile', () => {
  it('is what `$lib/paraglide` resolves to under vitest, not the app output', async () => {
    // `messages/fr.js` exists only in the `locale-modules` layout: the app output has one file
    // per message and no per-locale file, so a resolving import proves which tree the alias hit.
    // @ts-expect-error the app output (what svelte-check sees) has no such file - that is the point
    const perLocale = await import('$lib/paraglide/messages/fr.js');
    expect(Object.keys(perLocale).length).toBeGreaterThan(1000);
    expect(existsSync(resolve(root, 'src/lib/paraglide/messages/fr.js'))).toBe(false);
  });

  it('exports exactly the keys the app output exports, so the two compiles have not drifted', async () => {
    const { m } = await import('$lib/paraglide/messages');
    const testKeys = Object.keys(m).sort();
    expect(testKeys.length).toBeGreaterThan(1000);
    expect(testKeys).toEqual(appKeys());
  });

  it('carries every key of messages/fr.json and messages/en.json', async () => {
    const messages = (await import('$lib/paraglide/messages')) as Record<string, unknown>;
    for (const locale of ['fr', 'en']) {
      const file = JSON.parse(readFileSync(resolve(root, `messages/${locale}.json`), 'utf8'));
      const missing = Object.keys(file).filter((key) => key !== '$schema' && !(key in messages));
      expect(missing, `${locale}.json keys absent from the test compile`).toEqual([]);
    }
  });

  it('switches locale like the app runtime does', async () => {
    const imported = await import('$lib/paraglide/messages');
    const m = imported.m as unknown as Record<string, () => string>;
    const { setLocale, baseLocale } = await import('$lib/paraglide/runtime');
    const noInput = Object.keys(m).find((key) => {
      try {
        return typeof m[key]() === 'string';
      } catch {
        return false;
      }
    });
    expect(noInput).toBeDefined();
    const call = m[noInput!];
    setLocale('fr', { reload: false });
    const fr = call();
    setLocale('en', { reload: false });
    const en = call();
    setLocale(baseLocale, { reload: false });
    expect(typeof fr).toBe('string');
    expect(typeof en).toBe('string');
  });
});
