import { relativeTo, sourceFiles } from '../../test/sourceTree';

/**
 * A toast is user-visible chrome, so its text must come from Paraglide. Nothing in the type system
 * says so - `showToast` takes a `string`, and a literal passes lint, `check` and CI while shipping
 * an untranslated sentence to every user in the other locale.
 *
 * That is not hypothetical: an English rationale for the Android notification permission and three
 * hardcoded French strings all reached production this way. This test reads the sources and fails
 * on the one pattern that produced every one of them.
 */

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

describe('toast localization', () => {
  it('flags an inline literal and accepts an interpolated message', () => {
    expect(literalToastOffences(`showToast('Vote impossible', 'warning')`)).toHaveLength(1);
    expect(literalToastOffences('showToast(`${m.channel_poll_vote_error()} : x`)')).toHaveLength(0);
    expect(literalToastOffences('showToast(m.call_sibling_device_busy())')).toHaveLength(0);
  });

  it('never passes an unlocalized literal to showToast', () => {
    const offenders = sourceFiles({
      under: 'src',
      extensions: ['ts', 'svelte'],
      tests: 'exclude',
    }).filter(({ text }) => literalToastOffences(text).length > 0);

    expect(offenders.map(({ path }) => relativeTo(path, 'src'))).toEqual([]);
  });
});
