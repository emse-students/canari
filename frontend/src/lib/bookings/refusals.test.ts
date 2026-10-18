import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { BookingsApiError } from './api';
import {
  BOOKER_REFUSAL_CODES,
  describeBookingRefusal,
  ORGANISER_REFUSAL_CODES,
  outcomeUnknown,
} from './refusals';

const refused = (code: string | null, status = 400, ids: string[] = []) =>
  new BookingsApiError('dev text', code, status, ids);

describe('outcomeUnknown', () => {
  it('is unknown when nobody answered, or a 5xx carried no code', () => {
    expect(outcomeUnknown(new TypeError('Failed to fetch'))).toBe(true);
    expect(outcomeUnknown(refused(null, 504))).toBe(true);
    expect(outcomeUnknown(refused(null, 500))).toBe(true);
  });

  it('is a refusal for any 4xx, a validation 400 with no code included, and any coded answer', () => {
    expect(outcomeUnknown(refused(null, 400))).toBe(false);
    expect(outcomeUnknown(refused(null, 403))).toBe(false);
    expect(outcomeUnknown(refused('slot-taken', 409))).toBe(false);
  });
});

describe('describeBookingRefusal', () => {
  it('words every code the organiser and booker routes answer, none with the generic line', () => {
    for (const code of [...ORGANISER_REFUSAL_CODES, ...BOOKER_REFUSAL_CODES]) {
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

  it('says how many coming bookings stand in the way of a block (D29)', () => {
    const text = describeBookingRefusal(
      refused('bookings-inside-block', 409, ['a', 'b']),
      'Bloquer'
    );
    expect(text).toBe(m.bookings_refusal_inside_block({ count: 2 }));
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

describe('a FILE answer refused (WP-B6)', () => {
  it('reads a purged file as the deleted word the answers show, and a lost id as "pick it again"', () => {
    expect(describeBookingRefusal(refused('file-purged', 410), 'Télécharger')).toBe(
      m.form_answer_file_deleted()
    );
    expect(describeBookingRefusal(refused('file-not-yours'), 'Réserver')).toBe(
      m.bookings_refusal_file_not_yours()
    );
    expect(describeBookingRefusal(refused('file-too-large', 413), 'Réserver')).toBe(
      m.form_file_error_size()
    );
  });
});
