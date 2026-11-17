import { describe, expect, it } from 'vitest';
import { closedByAnswer, formWindowInvalid, isClosedForm, opensLater } from './formWindow';

describe('formWindowInvalid', () => {
  it('is false while either bound is missing', () => {
    expect(formWindowInvalid('', '')).toBe(false);
    expect(formWindowInvalid('2027-01-01T10:00', '')).toBe(false);
    expect(formWindowInvalid('', '2027-01-01T10:00')).toBe(false);
  });
  it('is false for an end after the opening', () => {
    expect(formWindowInvalid('2027-01-01T10:00', '2027-01-01T10:01')).toBe(false);
  });
  it('is true for an end equal to or before the opening', () => {
    expect(formWindowInvalid('2027-01-01T10:00', '2027-01-01T10:00')).toBe(true);
    expect(formWindowInvalid('2027-01-02T10:00', '2027-01-01T10:00')).toBe(true);
  });
});

describe('isClosedForm', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  it('is closed once its end has passed', () => {
    expect(isClosedForm({ closedAt: '2026-11-16T11:59:59Z' }, now)).toBe(true);
  });
  it('is open with no end, or an end still to come', () => {
    expect(isClosedForm({ closedAt: null }, now)).toBe(false);
    expect(isClosedForm({}, now)).toBe(false);
    expect(isClosedForm({ closedAt: '2026-11-16T12:00:01Z' }, now)).toBe(false);
    expect(isClosedForm(null, now)).toBe(false);
  });
});

describe('opensLater', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  it('is true only for an opening still to come', () => {
    expect(opensLater({ opensAt: '2026-11-16T12:00:01Z' }, now)).toBe(true);
    expect(opensLater({ opensAt: '2026-11-16T12:00:00Z' }, now)).toBe(false);
    expect(opensLater({}, now)).toBe(false);
    expect(opensLater(null, now)).toBe(false);
  });
});

describe('closedByAnswer', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  it('keeps an end the client clock already agrees has passed', () => {
    expect(closedByAnswer('2026-11-16T11:00:00Z', now)).toBe('2026-11-16T11:00:00Z');
  });
  it('pulls an end the server stamped ahead of this clock back to now, so the row reads closed', () => {
    const answered = closedByAnswer('2026-11-16T12:00:03Z', now);
    expect(answered).toBe('2026-11-16T12:00:00.000Z');
    expect(isClosedForm({ closedAt: answered }, now)).toBe(true);
  });
  it('passes null through', () => {
    expect(closedByAnswer(null, now)).toBeNull();
  });
});
