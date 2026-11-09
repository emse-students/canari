import { describe, expect, it } from 'vitest';
import {
  cotisationKey,
  cotisationModeOf,
  firstEmptyCondition,
  withCotisationMode,
} from './audience';

describe('the cotisation mode of a condition (owner, 2026-10-30: detient / ne detient pas)', () => {
  it('is decided by the stored criterion, else by the creator last pick', () => {
    expect(cotisationModeOf({ notCotisation: { anyTier: true } }, 'holds')).toBe('notHolds');
    expect(cotisationModeOf({ cotisation: { anyTier: true } }, 'notHolds')).toBe('holds');
    expect(cotisationModeOf({}, 'notHolds')).toBe('notHolds');
    expect(cotisationModeOf(null, 'holds')).toBe('holds');
  });

  it('maps each mode to its own key', () => {
    expect(cotisationKey('holds')).toBe('cotisation');
    expect(cotisationKey('notHolds')).toBe('notCotisation');
  });

  // The server refuses a condition carrying both keys, so a switch MOVES the tiers, never copies.
  it('moves the ticked tiers to the other key and keeps the other criteria', () => {
    const held = { cotisation: { variantKeys: ['bde'] }, promo: { values: [2024] } };
    expect(withCotisationMode(held, 'notHolds')).toEqual({
      notCotisation: { variantKeys: ['bde'] },
      promo: { values: [2024] },
    });
    expect(withCotisationMode(withCotisationMode(held, 'notHolds'), 'holds')).toEqual(held);
  });

  it('leaves a condition with no cotisation criterion as it is', () => {
    expect(withCotisationMode({ promo: { values: [2024] } }, 'notHolds')).toEqual({
      promo: { values: [2024] },
    });
  });

  it('does not call a negated-only condition empty', () => {
    expect(firstEmptyCondition({ notCotisation: { anyTier: true } }, [])).toBeNull();
  });
});
