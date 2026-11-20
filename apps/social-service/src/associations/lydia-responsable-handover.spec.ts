import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import {
  LYDIA_RESPONSABLE_HANDOVER_CASHIER_NUMBER,
  LYDIA_RESPONSABLE_HANDOVER_ENABLED,
  LYDIA_RESPONSABLE_HANDOVER_FORBIDDEN,
  LYDIA_RESPONSABLE_HANDOVER_HEIR_NOT_PAYOUT_MANAGER,
  LYDIA_RESPONSABLE_HANDOVER_SAME_PERSON,
  handoverOutcome,
  planHandover,
  type HandoverAsk,
  type HandoverRow,
} from './lydia-responsable-handover';
import { LYDIA_CASHIER_PHONE_IN_USE } from './lydia-cashier-claim';

/**
 * THE HAND-OVER'S CHECKS AND OUTCOMES (owner, 2026-11-19), as pure functions of the rows the claim
 * locked: who may ask, to whom, with which number - and what a record does with Lydia's answer.
 * "Sealed" numbers here are the plain number behind a `sealed:` prefix; `open` refuses `broken`.
 */
const CODES = {
  noResponsable: 'NO_RESPONSABLE',
  notAMember: 'NOT_A_MEMBER',
  phoneLocked: 'PHONE_LOCKED',
};
const OLD = '+33611111111';
const NEW = '+33622222222';
/** A member holding MANAGE_PAYOUT_ACCOUNT: the only heir the hand-over accepts. */
const PAYOUT_MANAGER = { isMember: true, managesPayout: true };
const open = (sealed: string): string | null =>
  sealed === 'broken' ? null : sealed.replace(/^sealed:/, '');

const responsable = (over: Partial<HandoverRow> = {}): HandoverRow => ({
  id: 'row-resp',
  userId: 'holder',
  role: 'responsable',
  phoneSealed: `sealed:${OLD}`,
  previousPhoneSealed: null,
  confirmedAt: new Date(0),
  ...over,
});
const ask = (over: Partial<HandoverAsk> = {}): HandoverAsk => ({
  actorId: 'holder',
  globalAdmin: false,
  userId: 'heir',
  phone: NEW,
  ...over,
});

/** The typed code (and status) a plan refuses with, or 'planned'. */
function outcomeOf(rows: HandoverRow[], a: HandoverAsk, target = PAYOUT_MANAGER): unknown {
  try {
    planHandover(rows, a, target, open, CODES);
    return 'planned';
  } catch (err: unknown) {
    if (err instanceof HttpException) {
      return `${err.getStatus()} ${(err.getResponse() as { code?: string }).code ?? ''}`.trim();
    }
    throw err;
  }
}

describe('planHandover - who may hand the Responsable over, to whom, with which number', () => {
  it('the Responsable themselves, to another member with a free number: planned, not a retry', () => {
    expect(planHandover([responsable()], ask(), PAYOUT_MANAGER, open, CODES)).toEqual({
      previousResponsableId: 'row-resp',
      retry: false,
      heirCashierId: null,
    });
  });

  it('a platform admin may hand it over for them (a departed or unreachable Responsable)', () => {
    expect(outcomeOf([responsable()], ask({ actorId: 'admin', globalAdmin: true }))).toBe(
      'planned'
    );
  });

  it('a payout manager who is not the Responsable is refused (403), before any other check', () => {
    expect(
      outcomeOf([responsable()], ask({ actorId: 'treasurer' }), {
        isMember: false,
        managesPayout: false,
      })
    ).toBe(`403 ${LYDIA_RESPONSABLE_HANDOVER_FORBIDDEN}`);
  });

  it('no Responsable, or one Lydia has not confirmed: NO_RESPONSABLE (its resend confirms it first)', () => {
    expect(outcomeOf([], ask())).toBe('409 NO_RESPONSABLE');
    expect(outcomeOf([responsable({ confirmedAt: null })], ask())).toBe('409 NO_RESPONSABLE');
  });

  it('to the Responsable themselves: SAME_PERSON', () => {
    expect(outcomeOf([responsable()], ask({ userId: 'holder' }))).toBe(
      `400 ${LYDIA_RESPONSABLE_HANDOVER_SAME_PERSON}`
    );
  });

  it('to someone who is not a member: NOT_A_MEMBER', () => {
    expect(outcomeOf([responsable()], ask(), { isMember: false, managesPayout: false })).toBe(
      '400 NOT_A_MEMBER'
    );
  });

  it('to a member without MANAGE_PAYOUT_ACCOUNT: refused - they could never hand over in turn, nor leave', () => {
    expect(outcomeOf([responsable()], ask(), { isMember: true, managesPayout: false })).toBe(
      `400 ${LYDIA_RESPONSABLE_HANDOVER_HEIR_NOT_PAYOUT_MANAGER}`
    );
  });

  it('a member who already is a cashier is PROMOTED with their own number (owner, 2026-11-20)', () => {
    const tresorier: HandoverRow = {
      id: 'row-t',
      userId: 'heir',
      role: 'tresorier',
      phoneSealed: `sealed:${NEW}`,
      previousPhoneSealed: null,
      confirmedAt: new Date(0),
    };
    // Their own number is not "in use" by someone else: it is the number promoted.
    expect(planHandover([responsable(), tresorier], ask(), PAYOUT_MANAGER, open, CODES)).toEqual({
      previousResponsableId: 'row-resp',
      retry: false,
      heirCashierId: 'row-t',
    });
  });

  it('a cashier heir asked with ANOTHER number: CASHIER_NUMBER (the first would keep rights no row removes)', () => {
    const vendeur: HandoverRow = {
      id: 'row-v',
      userId: 'heir',
      role: 'vendeur',
      phoneSealed: 'sealed:+33633333333',
      previousPhoneSealed: null,
      confirmedAt: new Date(0),
    };
    expect(outcomeOf([responsable(), vendeur], ask())).toBe(
      `409 ${LYDIA_RESPONSABLE_HANDOVER_CASHIER_NUMBER}`
    );
  });

  it('a cashier heir whose own seal does not open: a 503, nothing claimed', () => {
    const broken: HandoverRow = {
      id: 'row-v',
      userId: 'heir',
      role: 'vendeur',
      phoneSealed: 'broken',
      previousPhoneSealed: null,
      confirmedAt: new Date(0),
    };
    expect(() => planHandover([responsable(), broken], ask(), PAYOUT_MANAGER, open, CODES)).toThrow(
      ServiceUnavailableException
    );
  });

  it("the Responsable's own number, or another cashier's: PHONE_IN_USE", () => {
    expect(outcomeOf([responsable()], ask({ phone: OLD }))).toBe(
      `409 ${LYDIA_CASHIER_PHONE_IN_USE}`
    );
    const other: HandoverRow = {
      id: 'row-t',
      userId: 'treasurer',
      role: 'tresorier',
      phoneSealed: `sealed:${NEW}`,
      previousPhoneSealed: null,
      confirmedAt: new Date(0),
    };
    expect(outcomeOf([responsable(), other], ask())).toBe(`409 ${LYDIA_CASHIER_PHONE_IN_USE}`);
  });

  it("another cashier's seal that does not open counts as holding the number - refused, not risked", () => {
    const broken: HandoverRow = {
      id: 'row-t',
      userId: 'treasurer',
      role: 'tresorier',
      phoneSealed: 'broken',
      previousPhoneSealed: null,
      confirmedAt: new Date(0),
    };
    expect(outcomeOf([responsable(), broken], ask())).toBe(`409 ${LYDIA_CASHIER_PHONE_IN_USE}`);
  });

  it("the Responsable's other number slot holding ANOTHER number: PHONE_LOCKED (remove it first)", () => {
    expect(outcomeOf([responsable({ previousPhoneSealed: 'sealed:+33644444444' })], ask())).toBe(
      '409 PHONE_LOCKED'
    );
  });

  it('the slot holding THIS number (an earlier hand-over Lydia did not confirm): a retry', () => {
    expect(
      planHandover(
        [responsable({ previousPhoneSealed: `sealed:${NEW}` })],
        ask(),
        PAYOUT_MANAGER,
        open,
        CODES
      )
    ).toEqual({ previousResponsableId: 'row-resp', retry: true, heirCashierId: null });
  });

  it("the Responsable's own seal that does not open: a 503, nothing claimed", () => {
    expect(() =>
      planHandover([responsable({ phoneSealed: 'broken' })], ask(), PAYOUT_MANAGER, open, CODES)
    ).toThrow(ServiceUnavailableException);
  });
});

describe('handoverOutcome - what a record does with Lydia answer', () => {
  it('confirmed, the old Responsable live, the target a member: handed over', () => {
    expect(handoverOutcome(true, true, true)).toBe('handed-over');
  });
  it('not confirmed: the old Responsable stays (unconfirmed)', () => {
    expect(handoverOutcome(true, false, true)).toBe('unconfirmed');
    expect(handoverOutcome(true, false, false)).toBe('unconfirmed');
    expect(handoverOutcome(false, false, true)).toBe('unconfirmed');
  });
  it('confirmed but the target left meanwhile: target-left (their number removed next)', () => {
    expect(handoverOutcome(true, true, false)).toBe('target-left');
  });
  it('confirmed with no old Responsable left (an erasure took it): handed over to the only holder', () => {
    expect(handoverOutcome(false, true, true)).toBe('handed-over');
  });
  it('no old Responsable left AND the target left too: target-left, confirmed or not (M4)', () => {
    expect(handoverOutcome(false, true, false)).toBe('target-left');
    expect(handoverOutcome(false, false, false)).toBe('target-left');
  });
});

describe('the owner gate', () => {
  it('ships OFF: the hand-over has never run against Lydia', () => {
    expect(LYDIA_RESPONSABLE_HANDOVER_ENABLED).toBe(false);
  });
});
