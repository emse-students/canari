import { describe, expect, it } from 'vitest';
import type { AssociationPayoutAccount, LydiaCashier } from './api';
import {
  LYDIA_CASHIER_ADD_ENABLED,
  lydiaCashiersView,
  responsableResendText,
} from './lydiaCashiers';

function cashier(overrides: Partial<LydiaCashier>): LydiaCashier {
  return {
    id: 'c1',
    userId: 'u1',
    name: 'Alice',
    role: 'vendeur',
    phoneEnd: '42',
    state: 'confirmed',
    previousPhoneEnd: null,
    addedAt: '2026-10-31T10:00:00.000Z',
    addedByName: 'Bob',
    ...overrides,
  };
}

const responsable = cashier({
  id: 'r1',
  userId: 'ur',
  name: 'Rita',
  role: 'responsable',
  addedAt: '2026-10-30T10:00:00.000Z',
});

function account(overrides: Partial<AssociationPayoutAccount> = {}): AssociationPayoutAccount {
  return {
    lydiaAccountId: 'vendor',
    lydiaDashboardUrl: null,
    lydiaOnboardingComplete: true,
    responsable: { userId: 'ur', name: 'Rita', phoneEnd: '11', confirmed: true },
    cashiers: [responsable],
    ...overrides,
  };
}

describe('responsableResendText', () => {
  it('while the gate is off, offers only to resend the SMS and never mentions another number', () => {
    const off = responsableResendText(false);
    const on = responsableResendText(true);
    expect(responsableResendText()).toEqual(off);
    expect(off.button).not.toBe(on.button);
    expect(off.hint).not.toBe(on.hint);
  });
});

describe('lydiaCashiersView', () => {
  it('ships with adding hidden: the gate stays off until a production removal is observed', () => {
    expect(LYDIA_CASHIER_ADD_ENABLED).toBe(false);
    const view = lydiaCashiersView(account({ cashiers: [responsable, cashier({})] }));
    expect(view.canAdd).toBe(false);
    expect(view.rows.every((row) => !row.canChangeRole)).toBe(true);
  });

  it('is hidden without a linked Business or without a confirmed Responsable', () => {
    expect(lydiaCashiersView(account({ lydiaAccountId: null }), true).visible).toBe(false);
    expect(lydiaCashiersView(account({ responsable: null }), true).visible).toBe(false);
    const unconfirmed = account({
      responsable: { userId: 'ur', name: 'Rita', phoneEnd: '11', confirmed: false },
    });
    expect(lydiaCashiersView(unconfirmed, true)).toEqual({
      visible: false,
      canAdd: false,
      rows: [],
    });
  });

  it('reads an older server with no cashier list as no other cashier', () => {
    const view = lydiaCashiersView(account({ cashiers: undefined }), true);
    expect(view.visible).toBe(true);
    expect(view.rows).toEqual([]);
  });

  it('with the gate on, offers Ajouter and a role change for every cashier but the Responsable', () => {
    const view = lydiaCashiersView(
      account({ cashiers: [cashier({ role: 'tresorier' }), responsable] }),
      true
    );
    expect(view.canAdd).toBe(true);
    expect(view.rows.map((row) => [row.cashier.role, row.canChangeRole])).toEqual([
      ['responsable', false],
      ['tresorier', true],
    ]);
  });

  it('never offers to remove the Responsable current number, always any other cashier', () => {
    const view = lydiaCashiersView(
      account({ cashiers: [responsable, cashier({ state: 'revoke-unconfirmed' })] }),
      false
    );
    expect(view.rows.map((row) => [row.cashier.role, row.canRevokeCurrent])).toEqual([
      ['responsable', false],
      ['vendeur', true],
    ]);
  });

  it('offers to remove an old number left by a number change, gate off or on', () => {
    const changed = { ...responsable, previousPhoneEnd: '99' };
    for (const gate of [false, true]) {
      const [row] = lydiaCashiersView(account({ cashiers: [changed] }), gate).rows;
      expect(row.canRevokePrevious).toBe(true);
      expect(row.canRevokeCurrent).toBe(false);
    }
  });

  it('lists the Responsable first, then the others by the date they were added', () => {
    const late = cashier({ id: 'late', addedAt: '2026-10-31T12:00:00.000Z' });
    const early = cashier({ id: 'early', addedAt: '2026-10-31T09:00:00.000Z' });
    const view = lydiaCashiersView(account({ cashiers: [late, early, responsable] }));
    expect(view.rows.map((row) => row.cashier.id)).toEqual(['r1', 'early', 'late']);
  });
});
