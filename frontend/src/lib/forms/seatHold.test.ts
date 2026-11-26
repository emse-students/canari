import { describe, expect, it } from 'vitest';
import {
  holdCountdownText,
  holdEndsAt,
  holdSecondsLeft,
  seatHoldOffered,
  type SeatHoldOfferState,
} from './seatHold';

const base: SeatHoldOfferState = {
  maxSubmissions: 20,
  anonymous: false,
  signedIn: true,
  formFull: false,
  submitted: false,
  editing: false,
  closed: false,
  notOpenYet: false,
  maySubmit: true,
  preview: false,
  holding: false,
};

describe('seatHoldOffered', () => {
  it('is offered to a signed-in person on an open capped named form with a seat free', () => {
    expect(seatHoldOffered(base)).toBe(true);
  });

  it.each<[string, Partial<SeatHoldOfferState>]>([
    ['an uncapped form', { maxSubmissions: undefined }],
    ['a zero capacity', { maxSubmissions: 0 }],
    ['an anonymous form (a hold names its holder)', { anonymous: true }],
    ['a guest (no account to hold for)', { signedIn: false }],
    ['a full form', { formFull: true }],
    ['a person who answered', { submitted: true }],
    ['an edit', { editing: true }],
    ['a closed form', { closed: true }],
    ['a form not open yet', { notOpenYet: true }],
    ['a person the form is not open to', { maySubmit: false }],
    ['a preview', { preview: true }],
    ['a hold already live', { holding: true }],
  ])('is not offered on %s', (_label, over) => {
    expect(seatHoldOffered({ ...base, ...over })).toBe(false);
  });
});

describe('the countdown', () => {
  it('counts down from the seconds the server answered, on the clock given', () => {
    const ends = holdEndsAt(600, 1_000);
    expect(holdSecondsLeft(ends, 1_000)).toBe(600);
    expect(holdSecondsLeft(ends, 1_000 + 59_500)).toBe(541);
    expect(holdSecondsLeft(ends, 1_000 + 600_000)).toBe(0);
    expect(holdSecondsLeft(ends, 1_000 + 900_000)).toBe(0);
  });

  it('never ends before now for a negative answer', () => {
    expect(holdSecondsLeft(holdEndsAt(-5, 0), 0)).toBe(0);
  });

  it('is written m:ss', () => {
    expect(holdCountdownText(600)).toBe('10:00');
    expect(holdCountdownText(581)).toBe('9:41');
    expect(holdCountdownText(59)).toBe('0:59');
    expect(holdCountdownText(0)).toBe('0:00');
    expect(holdCountdownText(-3)).toBe('0:00');
  });
});
