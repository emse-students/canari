import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import {
  offersWaitlistJoin,
  registeredOnly,
  waitingInOrder,
  waitlistPayload,
  waitlistRankText,
  waitlistFrozen,
  waitlistSettable,
} from './waitlist';

const row = (
  id: string,
  paymentStatus: string,
  waitlistOrder: string | null,
  createdAt: string
) => ({
  id,
  paymentStatus,
  waitlistOrder,
  createdAt,
});

describe('the waiting list rank', () => {
  it('says the first place in its own words, and every other by its number', () => {
    expect(waitlistRankText(1)).toBe(m.form_waitlist_rank_first());
    expect(waitlistRankText(3)).toBe(m.form_waitlist_rank({ rank: 3 }));
    expect(waitlistRankText(3)).toContain('3');
  });
});

describe('the waiting answers of a form', () => {
  const rows = [
    row('paid', 'paid', null, '2026-11-20T10:00:00Z'),
    row('third', 'waiting', '12', '2026-11-20T09:00:00Z'),
    row('first', 'waiting', '2', '2026-11-20T12:00:00Z'),
    row('second', 'waiting', '10', '2026-11-20T11:00:00Z'),
  ];

  it('lists them in arrival order, by the server order and never by the clock', () => {
    expect(waitingInOrder(rows).map((r) => r.id)).toEqual(['first', 'second', 'third']);
  });

  it('keeps the registrations apart from the line', () => {
    expect(registeredOnly(rows).map((r) => r.id)).toEqual(['paid']);
  });
});

describe('offering to join the waiting list', () => {
  const base = {
    waitlist: { open: true, rank: null },
    formFull: true,
    submitted: false,
    editing: false,
    closed: false,
    notOpenYet: false,
    maySubmit: true,
    preview: false,
  };

  it('offers it on a full form whose list is open', () => {
    expect(offersWaitlistJoin(base)).toBe(true);
  });

  it('never offers it on a form with free places, or whose list is off', () => {
    expect(offersWaitlistJoin({ ...base, formFull: false })).toBe(false);
    expect(offersWaitlistJoin({ ...base, waitlist: { open: false, rank: null } })).toBe(false);
  });

  it('never offers it to a server older than the list', () => {
    expect(offersWaitlistJoin({ ...base, waitlist: undefined })).toBe(false);
  });

  it('never offers it once answered, closed, refused or previewed', () => {
    expect(offersWaitlistJoin({ ...base, submitted: true })).toBe(false);
    expect(offersWaitlistJoin({ ...base, closed: true })).toBe(false);
    expect(offersWaitlistJoin({ ...base, maySubmit: false })).toBe(false);
    expect(offersWaitlistJoin({ ...base, preview: true })).toBe(false);
  });
});

describe('the waiting list switch in the editors', () => {
  const limited = { maxSubmissions: 20, anonymous: false, allowMultipleSubmissions: false };

  it('applies only to a limited, named, one-answer form', () => {
    expect(waitlistSettable(limited)).toBe(true);
    expect(waitlistSettable({ ...limited, maxSubmissions: undefined })).toBe(false);
    expect(waitlistSettable({ ...limited, anonymous: true })).toBe(false);
    expect(waitlistSettable({ ...limited, allowMultipleSubmissions: true })).toBe(false);
  });

  it('sends nothing to an estate that does not keep the list, and never an inapplicable yes', () => {
    expect(waitlistPayload(false, true, limited)).toEqual({});
    expect(waitlistPayload(true, true, limited)).toEqual({ waitlistEnabled: true });
    expect(waitlistPayload(true, true, { ...limited, anonymous: true })).toEqual({
      waitlistEnabled: false,
    });
    expect(waitlistPayload(true, false, limited)).toEqual({ waitlistEnabled: false });
  });
});

describe('a waiting list frozen by its payment modes', () => {
  const online = { totalPaid: 1500, paymentMethod: null };
  const cash = { totalPaid: 1500, paymentMethod: 'cash' as const };

  it('is frozen when the first in line owes by a mode the form no longer takes', () => {
    expect(waitlistFrozen({ allowOnlinePayment: false, allowCashPayment: true }, online)).toBe(
      true
    );
    expect(waitlistFrozen({ allowOnlinePayment: true, allowCashPayment: false }, cash)).toBe(true);
    // The association cannot collect online: the server freezes the line on the same reading.
    expect(waitlistFrozen({ allowOnlinePayment: true, paymentsPaused: true }, online)).toBe(true);
  });

  it('is not frozen when that mode is offered, nothing is owed, or nobody waits', () => {
    expect(waitlistFrozen({ allowOnlinePayment: true }, online)).toBe(false);
    expect(waitlistFrozen({ allowCashPayment: true, paymentsPaused: true }, cash)).toBe(false);
    expect(waitlistFrozen({}, online)).toBe(false);
    expect(waitlistFrozen({ allowCashPayment: true }, cash)).toBe(false);
    expect(
      waitlistFrozen({ allowOnlinePayment: false }, { totalPaid: 0, paymentMethod: null })
    ).toBe(false);
    expect(waitlistFrozen({ allowOnlinePayment: false }, undefined)).toBe(false);
  });
});
