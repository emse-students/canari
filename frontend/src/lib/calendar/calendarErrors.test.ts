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
      const out = calendarErrorMessage(new SocialApiError(RAW, code), fallback);

      expect(out).not.toBe('FALLBACK');
      expect(out).not.toContain(RAW);
      expect(out.length).toBeGreaterThan(0);
    }
  );

  it('falls back for a code nobody has translated yet, rather than showing the English', () => {
    // The half that closes the defect: translating the three known codes fixes three sentences,
    // refusing to print the server's text is what stops the fourth.
    const out = calendarErrorMessage(new SocialApiError(RAW, 'CALENDAR_SOMETHING_NEW'), fallback);

    expect(out).toBe('FALLBACK');
  });

  it('falls back for a refusal carrying no code at all', () => {
    expect(calendarErrorMessage(new SocialApiError(RAW, null), fallback)).toBe('FALLBACK');
  });

  it('falls back for a plain Error, which is what a transport failure throws', () => {
    expect(calendarErrorMessage(new Error(RAW), fallback)).toBe('FALLBACK');
  });

  it('falls back for something that is not an Error at all', () => {
    expect(calendarErrorMessage('boom', fallback)).toBe('FALLBACK');
  });
});
