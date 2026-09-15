import { describe, expect, it } from 'vitest';
import { SocialApiError } from '$lib/associations/api';
import { calendarErrorMessage } from './calendarErrors';

/**
 * THE CALENDAR'S DATE REFUSALS ARE CHOSEN FROM A CODE, NEVER FROM THE SERVER'S SENTENCE.
 *
 * `endsAt must be after startsAt` reached a French reader verbatim through the deposit modal's
 * `e instanceof Error ? e.message : <fallback>`. The mapper replaces that ternary in both modals,
 * so the assertions that matter are the two ENDS of it: a code it knows becomes the right localized
 * line, and anything it does not know becomes the caller's own fallback rather than English.
 */
const RAW = 'endsAt must be after startsAt';
const fallback = () => 'FALLBACK';

describe('calendarErrorMessage', () => {
  it.each([['CALENDAR_INVALID_START'], ['CALENDAR_INVALID_END'], ['CALENDAR_END_BEFORE_START']])(
    'translates %s to a localized sentence',
    (code) => {
      const out = calendarErrorMessage(new SocialApiError(RAW, code, 400), fallback);

      expect(out).not.toBe('FALLBACK');
      expect(out).not.toContain(RAW);
      expect(out.length).toBeGreaterThan(0);
    }
  );

  it('falls back for a code nobody has translated yet, rather than showing the English', () => {
    // The half that closes the defect: translating the three known codes fixes three sentences,
    // refusing to print the server's text is what stops the fourth.
    const out = calendarErrorMessage(
      new SocialApiError(RAW, 'CALENDAR_SOMETHING_NEW', 400),
      fallback
    );

    expect(out).toBe('FALLBACK');
  });

  it('falls back for a refusal carrying no code at all, when the status says nothing either', () => {
    expect(calendarErrorMessage(new SocialApiError(RAW, null, 400), fallback)).toBe('FALLBACK');
  });

  // THE DEFECT THIS CLOSES. Depositing an event without the grant answers 403 from a guard whose
  // bare `ForbiddenException` carries NO code, so this mapper fell through to the caller's generic
  // line and a refusal the reader could act on read exactly like a server fault they could not.
  it('describes a codeless 403, which is what the deposit guard actually throws', () => {
    const out = calendarErrorMessage(
      new SocialApiError('Insufficient permissions in this association', null, 403),
      fallback
    );

    expect(out).not.toBe('FALLBACK');
    expect(out).not.toContain('Insufficient permissions');
  });

  it('gives a 403 and a 404 DIFFERENT sentences, which is the whole of the fix', () => {
    const forbidden = calendarErrorMessage(new SocialApiError(RAW, null, 403), fallback);
    const gone = calendarErrorMessage(new SocialApiError(RAW, null, 404), fallback);

    expect(forbidden).not.toBe(gone);
  });

  // THE CONTROL, AND THE PRECEDENCE. A code says more than a status, so a known code must still
  // win even when the status is one the helper next door would happily describe - otherwise this
  // change would have traded three precise sentences for one coarse one.
  it('prefers a known CODE over the status', () => {
    const byCode = calendarErrorMessage(
      new SocialApiError(RAW, 'CALENDAR_END_BEFORE_START', 403),
      fallback
    );
    const byStatus = calendarErrorMessage(new SocialApiError(RAW, null, 403), fallback);

    expect(byCode).not.toBe(byStatus);
    expect(byCode).not.toBe('FALLBACK');
  });

  // THE OTHER CONTROL: a 500 is not a refusal anybody can act on, so it must NOT acquire a
  // sentence. The caller's own generic line is the honest answer and stays.
  it('still falls back for a 500, which names nothing the reader can do', () => {
    expect(calendarErrorMessage(new SocialApiError(RAW, null, 500), fallback)).toBe('FALLBACK');
  });

  it('falls back for a plain Error, which is what a transport failure throws', () => {
    expect(calendarErrorMessage(new Error(RAW), fallback)).toBe('FALLBACK');
  });

  it('falls back for something that is not an Error at all', () => {
    expect(calendarErrorMessage('boom', fallback)).toBe('FALLBACK');
  });
});
