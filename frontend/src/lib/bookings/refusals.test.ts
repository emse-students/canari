import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { BookingsApiError } from './api';
import { describeBookingRefusal, ORGANISER_REFUSAL_CODES } from './refusals';

const refused = (code: string | null, status = 400, ids: string[] = []) =>
  new BookingsApiError('dev text', code, status, ids);

describe('describeBookingRefusal', () => {
  it('words every code the organiser routes answer, none with the generic line', () => {
    for (const code of ORGANISER_REFUSAL_CODES) {
      const text = describeBookingRefusal(refused(code), 'Enregistrer');
      expect(text, code).not.toBe(m.common_generic_error_label());
      expect(text, code).not.toContain('dev text');
    }
  });

  it('says how many coming bookings stand in the way (D29)', () => {
    const text = describeBookingRefusal(
      refused('bookings-inside-change', 409, ['a', 'b', 'c']),
      'Enregistrer'
    );
    expect(text).toBe(m.bookings_refusal_inside_change({ count: 3 }));
  });

  it('falls back on the status for a code it does not know, then on the generic line', () => {
    expect(describeBookingRefusal(refused('brand-new', 403), 'Enregistrer')).toBe(
      m.api_refusal_forbidden({ action: 'Enregistrer' })
    );
    expect(describeBookingRefusal(new Error('network'), 'Enregistrer')).toBe(
      m.common_generic_error_label()
    );
  });
});
