import { describe, it, expect } from 'vitest';
import type { SlotUnit } from './api';
import { isInvitedUnit, unitText } from './grid';
import { m } from '$lib/paraglide/messages';

const booked = (mine: boolean, holderId?: string, holderName?: string) =>
  ({
    state: 'booked',
    booking: { id: 'b', mine, holderId, holderName },
  }) as unknown as SlotUnit;

describe('isInvitedUnit and unitText', () => {
  it("own booking: not invited, reads 'Ma reservation'", () => {
    const u = booked(true, 'me', 'Moi');
    expect(isInvitedUnit(u, 'me')).toBe(false);
    expect(unitText(u, true, 'me')).toBe(m.bookings_cell_mine());
  });

  it('invited: invited, reads the booker', () => {
    const u = booked(true, 'other', 'Louison CAMPISTRON');
    expect(isInvitedUnit(u, 'me')).toBe(true);
    expect(unitText(u, true, 'me')).toBe('Louison CAMPISTRON');
  });

  it('a viewer not known yet is never invited', () => {
    const u = booked(true, 'other', 'Louison CAMPISTRON');
    expect(isInvitedUnit(u, null)).toBe(false);
  });

  it('not mine: not invited, reads the holder', () => {
    const u = booked(false, 'other', 'Louison CAMPISTRON');
    expect(isInvitedUnit(u, 'me')).toBe(false);
    expect(unitText(u, true, 'me')).toBe('Louison CAMPISTRON');
  });

  it('a free unit is not invited', () => {
    expect(isInvitedUnit({ state: 'free' } as SlotUnit, 'me')).toBe(false);
  });
});
