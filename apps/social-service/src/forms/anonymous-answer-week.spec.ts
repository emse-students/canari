import { anonymousAnswerWeekOf, anonymousAnswerWeekSql } from './anonymous-answer-batches';

/**
 * An anonymous answer keeps only its WEEK (owner, 2026-11-22): the SQL that writes it and the reader
 * that shows it name the same Monday 00:00. The SQL itself is proven against PostgreSQL in
 * `anonymous-answer-batches.integration.spec.ts`; this pins the read side, on fixed values.
 */
describe('anonymousAnswerWeekOf', () => {
  it('takes every day of an ISO week, Monday to Sunday, to its Monday 00:00', () => {
    // 2026-11-16 is a Monday; 2026-11-22 the Sunday that ends its week.
    for (let day = 16; day <= 22; day++) {
      expect(anonymousAnswerWeekOf(new Date(2026, 10, day, 23, 59, 59))).toEqual(
        new Date(2026, 10, 16)
      );
    }
  });

  it('keeps a week start, and crosses a year boundary', () => {
    expect(anonymousAnswerWeekOf(new Date(2026, 10, 23))).toEqual(new Date(2026, 10, 23));
    // 2027-01-01 is a Friday: its week began on Monday 2026-12-28.
    expect(anonymousAnswerWeekOf(new Date(2027, 0, 1, 12))).toEqual(new Date(2026, 11, 28));
  });
});

describe('anonymousAnswerWeekSql', () => {
  it("is PostgreSQL's ISO week truncation, on the UTC clock by default", () => {
    expect(anonymousAnswerWeekSql()).toBe("date_trunc('week', now() AT TIME ZONE 'UTC')");
    expect(anonymousAnswerWeekSql('"createdAt"')).toBe(`date_trunc('week', "createdAt")`);
  });
});
