/**
 * AN INITIAL IS A CHARACTER, AND A STRING INDEX IS NOT ONE.
 *
 * A group called with two hearts around its name drew a placeholder box in its avatar on
 * 2026-09-16: `GroupAvatar` carried a private `getInitials` taking `w[0]` of each word, which is a
 * UTF-16 code UNIT, so the first word yielded the lone high surrogate of an emoji. That copy is
 * gone and the component uses this module, which keeps only letters and digits and so never sees an
 * emoji at all.
 *
 * The same hazard survives one level down, which is what these cases pin: `\p{L}` matches astral
 * letters too, so `substring` and `[0]` can still halve a character AFTER the filter has run. The
 * emoji case and the astral case are therefore both here - one is the incident, the other is the
 * rule it teaches.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AVATAR_HUE_COUNT, avatarHueIndex, getInitials } from './avatar';

describe('getInitials', () => {
  it('ignores emoji entirely rather than splitting one', () => {
    // The reported name, verbatim: two hearts, the group's name, two hearts.
    const initials = getInitials('\u{1F499}\u{1F49A} 5 CD \u{1F49A}\u{1F499}');
    expect(initials).toBe('5C');
    // The real assertion: nothing that came out is half of a character.
    expect([...initials].length).toBe(initials.length);
  });

  it('never returns half of an astral letter', () => {
    // MATHEMATICAL BOLD CAPITAL A, a `\p{L}` that survives the alphanumeric filter.
    const initials = getInitials('\u{1D400}lice Dupont');
    expect([...initials].length).toBe(2);
    expect(initials.includes('�')).toBe(false);
  });

  it('takes two characters, not two code units, from a single-word name', () => {
    expect([...getInitials('\u{1D400}\u{1D401}')].length).toBe(2);
  });

  it('keeps the ordinary cases it always answered', () => {
    expect(getInitials('Victor Kalfon')).toBe('VK');
    expect(getInitials('@victor')).toBe('VI');
    expect(getInitials('victor.kalfon')).toBe('VK');
    expect(getInitials('')).toBe('?');
    expect(getInitials('!!!')).toBe('?');
  });
});

describe('avatarHueIndex', () => {
  it('is deterministic and always inside the palette', () => {
    for (const id of ['', 'u1', 'e83e8c-uuid', '\u{1F499}']) {
      const hue = avatarHueIndex(id);
      expect(hue).toBe(avatarHueIndex(id));
      expect(Number.isInteger(hue)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(AVATAR_HUE_COUNT);
    }
  });

  it('pins known ids, so a changed hash is a deliberate recolour of everyone', () => {
    expect(['alice', 'bob', 'carol', 'user-1'].map(avatarHueIndex)).toEqual([7, 4, 2, 4]);
    expect(avatarHueIndex('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(1);
  });

  it('spreads sequential ids over every hue, none starved', () => {
    const counts = Array.from({ length: AVATAR_HUE_COUNT }, () => 0);
    const n = 4000;
    for (let i = 0; i < n; i++) counts[avatarHueIndex(`user-${i}`)]++;
    const expected = n / AVATAR_HUE_COUNT;
    for (const c of counts) {
      expect(c).toBeGreaterThan(expected * 0.8);
      expect(c).toBeLessThan(expected * 1.2);
    }
  });
});

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe('avatar palette tokens', () => {
  const css = readFileSync(new URL('../../app.css', import.meta.url), 'utf8');

  it('defines both stops of every hue, each keeping white initials at >= 3:1', () => {
    for (let i = 0; i < AVATAR_HUE_COUNT; i++) {
      for (const end of ['from', 'to']) {
        const found = css.match(new RegExp(`--avatar-hue-${i}-${end}: (#[0-9a-f]{6});`));
        expect(found, `--avatar-hue-${i}-${end}`).not.toBeNull();
        const ratio = 1.05 / (luminance(found![1]) + 0.05);
        expect(ratio, `hue ${i} ${end}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
