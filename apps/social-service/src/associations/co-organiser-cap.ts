import { BadRequestException } from '@nestjs/common';

/**
 * THE CAP ON CO-ORGANISERS OF ONE EVENT (D39, decided by the user on 2026-10-10): FOUR associations
 * in total, the organiser and three co-organisers.
 *
 * The count is the co-organisers ACCEPTED plus those PENDING: a pending proposal is a seat that is
 * being held, and a cap counting only the accepted ones would let a form ask for twenty. A refused
 * one holds nothing and is not counted. The picker enforces the same number
 * (`frontend/src/lib/calendar/coOrganiserCap.ts`) so the server's refusal is a safety net the form
 * normally never reaches.
 */
export const MAX_CO_ORGANISERS = 3;

/** The stable code the client maps to its own sentence. */
export const CO_ORGANISER_CAP_CODE = 'CALENDAR_COORGANISER_CAP';

/** The refusal of a list that would hold more than {@link MAX_CO_ORGANISERS} co-organisers. */
export function coOrganiserCapRefusal(count: number): BadRequestException {
  return new BadRequestException({
    code: CO_ORGANISER_CAP_CODE,
    message: `An event has at most ${MAX_CO_ORGANISERS} co-organisers (asked for ${count}).`,
  });
}

/** Throws the cap refusal when `count` co-organisers (accepted + pending, organiser excluded) exceed the cap. */
export function assertWithinCoOrganiserCap(count: number): void {
  if (count > MAX_CO_ORGANISERS) throw coOrganiserCapRefusal(count);
}
