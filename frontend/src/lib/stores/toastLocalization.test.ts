import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A toast is user-visible chrome, so its text must come from Paraglide. Nothing in the type system
 * says so - `showToast` takes a `string`, and a literal passes lint, `check` and CI while shipping
 * an untranslated sentence to every user in the other locale.
 *
 * That is not hypothetical: an English rationale for the Android notification permission and three
 * hardcoded French strings all reached production this way. This test reads the sources and fails
 * on the one pattern that produced every one of them.
 */

// Kept in a variable: Vite rewrites `new URL('<literal>', import.meta.url)` into an asset URL,
// which is no longer a file:// URL by the time fileURLToPath sees it.
const SRC_REL = '../..';
const SRC = fileURLToPath(new URL(SRC_REL, import.meta.url));

/** `showToast(` applied to a quoted literal, capturing its delimiter and body. */
const TOAST_LITERAL = /showToast\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

/**
 * A quoted first argument is an offence unless it is a template that interpolates a message
 * function - `` `${m.channel_poll_vote_error()} : ${detail}` `` is localized, `'Vote impossible'`
 * is not. Single and double quotes cannot interpolate at all, so they are always offences.
 */
function literalToastOffences(source: string): string[] {
  return [...source.matchAll(TOAST_LITERAL)]
    .filter(([, quote, body]) => !(quote === '`' && body.includes('m.')))
    .map(([match]) => match);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === 'paraglide' ? [] : sourceFiles(full);
    return /\.(ts|svelte)$/.test(entry) && !entry.endsWith('.test.ts') ? [full] : [];
  });
}

describe('toast localization', () => {
  it('flags an inline literal and accepts an interpolated message', () => {
    expect(literalToastOffences(`showToast('Vote impossible', 'warning')`)).toHaveLength(1);
    expect(literalToastOffences('showToast(`${m.channel_poll_vote_error()} : x`)')).toHaveLength(0);
    expect(literalToastOffences('showToast(m.call_sibling_device_busy())')).toHaveLength(0);
  });

  it('never passes an unlocalized literal to showToast', () => {
    const offenders = sourceFiles(SRC).filter(
      (f) => literalToastOffences(readFileSync(f, 'utf8')).length > 0
    );

    expect(offenders.map((f) => f.slice(SRC.length).replace(/\\/g, '/'))).toEqual([]);
  });
});
