import { describe, expect, it } from 'vitest';
import type { AssociationPayoutAccount, LydiaCashier } from './api';
import {
  LYDIA_CASHIER_ADD_ENABLED,
  LYDIA_RESPONSABLE_HANDOVER_ENABLED,
  addableMembers,
  handoverConfirmText,
  handoverDoneText,
  handoverHeirs,
  lydiaCashiersView,
  responsableResendText,
} from './lydiaCashiers';
import { m } from '$lib/paraglide/messages';

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
  it('the gate as shipped (ON) offers another number; off, only to resend the SMS', () => {
    const off = responsableResendText(false);
    const on = responsableResendText(true);
    expect(responsableResendText()).toEqual(on);
    expect(off.button).not.toBe(on.button);
    expect(off.hint).not.toBe(on.hint);
  });
});

describe('lydiaCashiersView', () => {
  it('ships with adding offered (1.7.1, owner 2026-11-18): Ajouter and a role change for a cashier', () => {
    expect(LYDIA_CASHIER_ADD_ENABLED).toBe(true);
    const view = lydiaCashiersView(account({ cashiers: [responsable, cashier({})] }));
    expect(view.canAdd).toBe(true);
    expect(view.rows.map((row) => [row.cashier.role, row.canChangeRole])).toEqual([
      ['responsable', false],
      ['vendeur', true],
    ]);
  });

  it('with the gate off, nothing to add and no role change', () => {
    const view = lydiaCashiersView(account({ cashiers: [responsable, cashier({})] }), false);
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

  it('a cashier who left: told on the row, never offered a role; a Responsable who left: a new one is needed', () => {
    const view = lydiaCashiersView(
      account({
        cashiers: [
          { ...responsable, departed: true },
          cashier({ departed: true }),
          cashier({ id: 'c2', userId: 'u2', departed: false }),
        ],
      }),
      true
    );
    expect(view.rows.map((row) => [row.cashier.id, row.departed, row.canChangeRole])).toEqual([
      ['r1', 'responsable', false],
      ['c1', 'cashier', false],
      ['c2', null, true],
    ]);
    // The departed cashier may still be removed by hand; the Responsable's current number never.
    expect(view.rows.map((row) => row.canRevokeCurrent)).toEqual([false, true, true]);
  });

  it('a server older than 1.7.1 (no departed field) reads as a member', () => {
    const [row] = lydiaCashiersView(account({ cashiers: [cashier({})] }), true).rows;
    expect(row.departed).toBeNull();
  });

  it('lists the Responsable first, then the others by the date they were added', () => {
    const late = cashier({ id: 'late', addedAt: '2026-10-31T12:00:00.000Z' });
    const early = cashier({ id: 'early', addedAt: '2026-10-31T09:00:00.000Z' });
    const view = lydiaCashiersView(account({ cashiers: [late, early, responsable] }));
    expect(view.rows.map((row) => row.cashier.id)).toEqual(['r1', 'early', 'late']);
  });
});

describe('lydiaCashiersView - "Transferer le role" (owner, 2026-11-19)', () => {
  const self = { userId: 'ur', globalAdmin: false };
  const admin = { userId: 'someone', globalAdmin: true };
  const treasurer = { userId: 'u1', globalAdmin: false };
  const handOver = (
    cashiers: LydiaCashier[],
    viewer: { userId: string | null; globalAdmin: boolean },
    gate = true
  ) =>
    lydiaCashiersView(account({ cashiers }), true, viewer, gate).rows.map((row) => [
      row.cashier.id,
      row.canHandOver,
    ]);

  it('ships OFF: never drawn, even to the Responsable', () => {
    expect(LYDIA_RESPONSABLE_HANDOVER_ENABLED).toBe(false);
    const [row] = lydiaCashiersView(account(), true, self).rows;
    expect(row.canHandOver).toBe(false);
  });

  it('gate on: on the Responsable row only, for the Responsable themselves or a platform admin', () => {
    const cashiers = [responsable, cashier({})];
    expect(handOver(cashiers, self)).toEqual([
      ['r1', true],
      ['c1', false],
    ]);
    expect(handOver(cashiers, admin)).toEqual([
      ['r1', true],
      ['c1', false],
    ]);
    // A payout manager who is not the Responsable: never (the server answers 403 anyway).
    expect(handOver(cashiers, treasurer)).toEqual([
      ['r1', false],
      ['c1', false],
    ]);
    expect(handOver(cashiers, { userId: null, globalAdmin: false })).toEqual([
      ['r1', false],
      ['c1', false],
    ]);
  });

  it('a Responsable whose rights Lydia has not confirmed resends first: no hand-over', () => {
    expect(handOver([{ ...responsable, state: 'unconfirmed' }], self)).toEqual([['r1', false]]);
  });

  it('a departed Responsable: a platform admin hands the role over for them', () => {
    expect(handOver([{ ...responsable, departed: true }], admin)).toEqual([['r1', true]]);
  });
});

describe('the hand-over texts', () => {
  it('the confirmation names the heir and the consequence; the admin reads which number', () => {
    expect(handoverConfirmText('Bob', '32', true)).toBe(
      m.asso_lydia_handover_confirm_self({ name: 'Bob' })
    );
    expect(handoverConfirmText('Bob', '32', false)).toBe(
      m.asso_lydia_handover_confirm_admin({ name: 'Bob', phoneEnd: '32' })
    );
    expect(handoverConfirmText('Bob', '32', false)).toContain('32');
  });

  it('done: says whether the old number still waits for its removal', () => {
    expect(handoverDoneText('Bob', true)).toBe(m.asso_lydia_handover_done({ name: 'Bob' }));
    expect(handoverDoneText('Bob', false)).toBe(
      m.asso_lydia_handover_done_old_kept({ name: 'Bob' })
    );
  });
});

describe('who each cashier form offers', () => {
  const rows = [
    { userId: 'resp' },
    { userId: 'treasurer' },
    { userId: 'plain' },
    { userId: 'manager' },
    { userId: 'manager' },
  ];
  const cashiers = [{ userId: 'resp' }, { userId: 'treasurer' }] as LydiaCashier[];

  it('the add: members who are not cashiers yet, each once', () => {
    expect(addableMembers(rows, { cashiers }).map((r) => r.userId)).toEqual(['plain', 'manager']);
  });

  it('the hand-over: payout managers other than the Responsable, a cashier PROMOTED included (owner, 2026-11-20)', () => {
    const account = { payoutManagerIds: ['resp', 'treasurer', 'manager'] };
    expect(handoverHeirs(rows, account, 'resp').map((r) => r.userId)).toEqual([
      'treasurer',
      'manager',
    ]);
  });

  it('the hand-over offers nobody when the server sent no payout managers', () => {
    expect(handoverHeirs(rows, {}, 'resp')).toEqual([]);
  });
});
