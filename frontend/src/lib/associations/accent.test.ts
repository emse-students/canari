/**
 * ONE ASSOCIATION, ONE COLOUR - asserted two ways, because the defect was not a wrong colour but
 * TWO right ones.
 *
 * Thirteen sites derived this, in two families seeded differently (`name` for cards, `id` for the
 * calendar), so an association with no colour of its own was one hue on its card and another in the
 * calendar. Nothing was wrong at any single site, which is exactly why it survived: each expression
 * is obviously correct where it stands, and nobody compares thirteen of them.
 *
 * So the second half of this file is a GUARD OVER THE TREE, not a unit test. **A unit test of
 * `associationAccent` would have passed on every day the two families disagreed.** It reads `.ts`
 * as well as `.svelte`, because four of the thirteen were plain TypeScript - a markup-only sweep is
 * how the first count came back as eleven and missed the co-owner lines.
 */
import { describe, it, expect } from 'vitest';
import { withoutAnyComments } from '$lib/styles/markupSources';
import { relativeTo, sourceFiles } from '../../test/sourceTree';
import { associationAccent, associationAccentHex } from './accent';
import { generateAvatarColor } from '$lib/utils/avatar';

describe('the association accent', () => {
  it('takes the colour the association chose', () => {
    expect(associationAccent({ id: 'a1', color: '#e83e8c' })).toBe('#e83e8c');
  });

  it('falls back on the ID and not on anything that can be renamed', () => {
    // THE SEED IS THE WHOLE POINT. A name changes when a club renames itself, and the `name` family
    // gave it a new colour that day - silently, and only on half the screens.
    expect(associationAccent({ id: 'a1', color: null })).toBe(generateAvatarColor('a1'));
  });

  it('treats an empty colour as unset, which `??` did not', () => {
    // `color ?? fallback` keeps '' as a colour, and `style="background: "` is not a fallback - it is
    // a missing accent. One of the thirteen sites already spelled this correctly; twelve did not.
    expect(associationAccent({ id: 'a1', color: '' })).toBe(generateAvatarColor('a1'));
    expect(associationAccent({ id: 'a1', color: '   ' })).toBe(generateAvatarColor('a1'));
  });

  it('gives the same association the same answer whichever shape asks', () => {
    // The defect, stated directly: a card and a calendar event describing ONE association must not
    // disagree. They are different shapes carrying the same two fields under different names.
    const fromCard = associationAccentHex({ id: 'a1', color: null });
    const fromEvent = associationAccentHex({ id: 'a1', color: undefined });

    expect(fromCard).toBe(fromEvent);
    expect(fromCard).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('always returns a hex from the hex form, including when the association chose an hsl', () => {
    expect(associationAccentHex({ id: 'a1', color: 'hsl(210, 70%, 50%)' })).toMatch(
      /^#[0-9a-f]{6}$/i
    );
  });
});

describe('nothing derives it a second time', () => {
  it('leaves the association derivation to the one module that owns it', () => {
    // `generateAvatarColor` is a general utility and keeps honest users - a member's avatar in the
    // trombinoscope is seeded on a USER id and has nothing to do with an association. What is
    // forbidden is a SECOND ASSOCIATION derivation, so the guard looks for the shape rather than
    // for the function: a `generateAvatarColor` call sitting beside a `color` fallback.
    const offenders: string[] = [];

    // Hand-written source only (the shared snapshot holds no generated file): a Paraglide getter
    // cannot derive an accent.
    const files = sourceFiles({
      under: ['src/lib', 'src/routes'],
      extensions: ['ts', 'svelte'],
      tests: 'exclude',
    });
    for (const { path, text } of files) {
      const rel = relativeTo(path, 'src');
      if (rel.endsWith('associations/accent.ts')) continue; // the one that owns it
      for (const line of withoutAnyComments(text).split('\n')) {
        if (!line.includes('generateAvatarColor')) continue;
        if (/color(\?\.trim\(\))?\s*(\?\?|\|\|)/i.test(line)) {
          offenders.push(`${rel}: ${line.trim().slice(0, 100)}`);
        }
      }
    }

    expect(
      offenders,
      'An association accent is derived in associations/accent.ts and nowhere else. Two ' +
        'derivations is how one association ended up with one hue on a card and another in the ' +
        'calendar - and the second one always looks right where it stands.'
    ).toEqual([]);
  });

  it('can see the shape it forbids, so it is not passing on a pattern that matches nothing', () => {
    // A predicate never shown a positive is a predicate nobody has tested. These are the three
    // spellings that were actually in the tree.
    const forbidden = /color(\?\.trim\(\))?\s*(\?\?|\|\|)/i;

    expect(forbidden.test('const a = asso.color ?? generateAvatarColor(asso.name);')).toBe(true);
    expect(
      forbidden.test('toHex(ev.associationColor ?? generateAvatarColor(ev.associationId))')
    ).toBe(true);
    expect(forbidden.test('color: a.color?.trim() || generateAvatarColor(a.id),')).toBe(true);
    // And an honest user is not a finding.
    expect(forbidden.test('const bg = generateAvatarColor(m.userId);')).toBe(false);
  });
});
