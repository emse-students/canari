import { describe, expect, it } from 'vitest';
import type { Submission } from './api';
import {
  filterCounts,
  filterOf,
  isAbandoned,
  responsesSummary,
  seatsTaken,
  visibleResponses,
} from './responsesView';

/** The measured case of 2026-11-23: a 50-seat form with 47 paid, 2 cancelled and 1 expired. */
function sub(id: string, paymentStatus: string, holdsSeat?: boolean): Submission {
  return {
    id,
    formId: 'f1',
    userId: 'u',
    firstName: null,
    lastName: null,
    email: null,
    answers: {},
    totalPaid: 500,
    paymentStatus,
    holdsSeat,
    createdAt: '2026-11-01T00:00:00Z',
  };
}

const words = { fileName: () => '' } as never;

const gala = [
  ...Array.from({ length: 47 }, (_, i) => sub(`p${i}`, 'paid', true)),
  sub('c1', 'cancelled', false),
  sub('c2', 'cancelled', false),
  sub('e1', 'expired', false),
];

describe('what "Toutes" counts', () => {
  it('counts the answers that hold a seat, never an abandoned payment', () => {
    const counts = filterCounts(gala);
    expect(counts.all).toBe(47);
    expect(counts.paid).toBe(47);
    expect(counts.abandoned).toBe(3);
  });

  it('lists the same answers as it counts, and the abandoned chip lists the rest', () => {
    expect(visibleResponses(gala, [], 'all', '', words, false)).toHaveLength(47);
    expect(visibleResponses(gala, [], 'abandoned', '', words, false).map((s) => s.id)).toEqual([
      'c1',
      'c2',
      'e1',
    ]);
  });

  it('files a pending answer past its hold as abandoned, on the server verdict alone', () => {
    const live = sub('live', 'pending', true);
    const past = sub('past', 'pending', false);
    expect(isAbandoned(live)).toBe(false);
    expect(isAbandoned(past)).toBe(true);
    expect(filterOf(past)).toBe('abandoned');
    const counts = filterCounts([live, past]);
    expect(counts.all).toBe(1);
    expect(counts.abandoned).toBe(1);
  });

  it('keeps a pending answer counted when an older server sent no verdict', () => {
    expect(isAbandoned(sub('old', 'pending'))).toBe(false);
    expect(filterCounts([sub('old', 'pending')]).all).toBe(1);
  });

  it('gives a refunded answer its own chip, out of "Toutes", and keeps paid over capacity in', () => {
    const rows = [
      sub('r', 'refunded', false),
      sub('o', 'paid_over_capacity', false),
      sub('f', 'free', true),
      sub('k', 'pending_cash', true),
    ];
    const counts = filterCounts(rows);
    expect(counts).toEqual({ all: 3, paid: 1, unpaid: 1, abandoned: 0, refunded: 1 });
  });

  it('makes the summary card say the same number', () => {
    expect(responsesSummary(gala, false).answers).toBe(47);
  });
});

describe('seatsTaken', () => {
  it('sums the seats the server flagged, plus the anonymous answers still waiting', () => {
    expect(seatsTaken(gala)).toBe(47);
    expect(seatsTaken(gala, 2)).toBe(49);
    expect(seatsTaken([])).toBe(0);
  });
});
