import { BadRequestException } from '@nestjs/common';

/**
 * The longest voucher stored. A link voucher - the largest kind - is about 400 base64url
 * characters; the margin covers a later version without letting a member park kilobytes on a row.
 */
export const ADMISSION_VOUCHER_MAX_LENGTH = 4096;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Narrows the admission voucher a client sent with a join or an invitation (channel-encryption
 * section 25) to what may be stored: absent, or a bounded base64url string.
 *
 * The server never parses it and never verifies it. A voucher is signed by a member's device and
 * checked by members, and this service holds no device key, so the only checks worth making here are
 * the ones that keep a row sane: it is text, it is short, it is one token. What it SAYS - whom it
 * admits, who signed - is the members' to judge, and a voucher naming somebody else is refused by
 * every one of them.
 *
 * @returns the voucher to store, or `null` when none was sent.
 * @throws BadRequestException `ADMISSION_VOUCHER_INVALID` for anything else - refused, never
 *   truncated or dropped, so a client cannot believe a proof was kept that was not.
 */
export function narrowAdmissionVoucher(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (
    typeof raw !== 'string' ||
    raw.length > ADMISSION_VOUCHER_MAX_LENGTH ||
    !BASE64URL.test(raw)
  ) {
    throw new BadRequestException({
      code: 'ADMISSION_VOUCHER_INVALID',
      message: 'admissionVoucher must be a base64url string of at most 4096 characters',
    });
  }
  return raw;
}
