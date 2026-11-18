import { describe, expect, it, vi } from 'vitest';
import { Log } from '$lib/utils/Log';
import {
  formWindowInvalid,
  formWindowState,
  isClosedForm,
  opensLater,
  windowRefusalState,
} from './formWindow';

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

describe('formWindowState and isClosedForm', () => {
  const now = Date.parse('2026-11-16T12:00:00Z');
  it('reads the state the SERVER sent, never the device clock', () => {
    // The end is ahead of this device's clock (a phone behind the server), the server says closed.
    expect(isClosedForm({ closedAt: '2026-11-16T12:00:05Z', windowState: 'closed' }, now)).toBe(
      true
    );
    // The end has passed by this clock, the server says open (a reopened form read stale): the server wins.
    expect(isClosedForm({ closedAt: '2026-11-16T11:00:00Z', windowState: 'open' }, now)).toBe(
      false
    );
    expect(formWindowState({ windowState: 'not-yet' }, now)).toBe('not-yet');
  });
  it('falls back to the comparison against a server that sends none, and says so at warn, once', () => {
    const warn = vi.spyOn(Log, 'w').mockImplementation(() => {});
    expect(isClosedForm({ closedAt: '2026-11-16T11:59:59Z' }, now)).toBe(true);
    expect(isClosedForm({ closedAt: '2026-11-16T12:00:01Z' }, now)).toBe(false);
    expect(isClosedForm({ closedAt: null }, now)).toBe(false);
    expect(isClosedForm({}, now)).toBe(false);
    expect(isClosedForm(null, now)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][1])).toContain('windowState');
    warn.mockRestore();
  });
  it('is closed AT the end instant, as the server rule is (a close writes the end as now)', () => {
    expect(isClosedForm({ closedAt: '2026-11-16T12:00:00Z' }, now)).toBe(true);
    expect(isClosedForm({ closedAt: '2026-11-16T12:00:01Z' }, now)).toBe(false);
  });
});

describe('windowRefusalState', () => {
  it('turns the two typed refusals into the state they prove, and nothing else', () => {
    expect(windowRefusalState('FORM_CLOSED')).toBe('closed');
    expect(windowRefusalState('FORM_NOT_OPEN_YET')).toBe('not-yet');
    expect(windowRefusalState('FORM_FULL')).toBeNull();
    expect(windowRefusalState(null)).toBeNull();
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
  it('reads the server state when it sends one', () => {
    expect(opensLater({ windowState: 'not-yet' }, now)).toBe(true);
    expect(opensLater({ opensAt: '2030-01-01T00:00:00Z', windowState: 'open' }, now)).toBe(false);
  });
});
