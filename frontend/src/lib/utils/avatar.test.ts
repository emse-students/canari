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
import { getInitials, generateAvatarPlaceholder } from './avatar';

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

  it('produces a placeholder whose label is the same characters', () => {
    const uri = generateAvatarPlaceholder('\u{1F499}\u{1F49A} 5 CD');
    expect(decodeURIComponent(uri)).toContain('>5C<');
  });
});
