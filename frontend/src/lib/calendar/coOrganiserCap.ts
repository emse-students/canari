/**
 * THE CAP ON CO-ORGANISERS OF ONE EVENT (D39, user, 2026-10-10): FOUR associations in total, the
 * organiser and three co-organisers. Accepted AND pending both count - a pending proposal holds its
 * seat - and a refused one holds nothing.
 *
 * Mirrors `MAX_CO_ORGANISERS` of social-service (`associations/co-organiser-cap.ts`), which refuses
 * the same overflow with the code {@link CO_ORGANISER_CAP_CODE}; the picker stops it first, so the
 * server's refusal is a safety net the form normally never reaches.
 */
export const MAX_CO_ORGANISERS = 3;

/** The organiser plus its co-organisers: what the counter and the sentences call "total". */
export const MAX_ORGANISING_ASSOCIATIONS = MAX_CO_ORGANISERS + 1;

/** The server's stable code for an overflowing co-organiser list. */
export const CO_ORGANISER_CAP_CODE = 'CALENDAR_COORGANISER_CAP';
