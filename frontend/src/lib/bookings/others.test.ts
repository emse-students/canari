import { describe, expect, it } from 'vitest';
import { bookingOthers, othersNames, splitBookingFaces } from './others';

const person = (name: string) => ({ id: name.toLowerCase(), name });

describe('bookingOthers', () => {
  it('is the booker for an invitee, never the invitee', () => {
    expect(bookingOthers({ others: [person('Alice')] })).toEqual([person('Alice')]);
  });
  it('is the invitee for the booker', () => {
    expect(bookingOthers({ others: [person('Bob')] })).toEqual([person('Bob')]);
  });
  it('lists several, and nothing when alone or hidden', () => {
    expect(othersNames(bookingOthers({ others: [person('Alice'), person('Bob')] }))).toBe(
      'Alice, Bob'
    );
    expect(bookingOthers({ others: [] })).toEqual([]);
    expect(bookingOthers({})).toEqual([]);
  });
});

describe('splitBookingFaces', () => {
  it('caps the faces at three and counts the rest', () => {
    const five = ['A', 'B', 'C', 'D', 'E'].map(person);
    const { shown, hidden } = splitBookingFaces(five);
    expect(shown).toHaveLength(3);
    expect(hidden.map((p) => p.name)).toEqual(['D', 'E']);
    expect(splitBookingFaces(five.slice(0, 2)).hidden).toEqual([]);
  });
});
