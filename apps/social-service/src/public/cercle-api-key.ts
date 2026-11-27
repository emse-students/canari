import { ForbiddenException } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * THE ONE CREDENTIAL LE CERCLE PRESENTS TO CANARI: `X-Api-Key`, matched against `CERCLE_API_KEY`
 * (Le Cercle's `CANARI_API_KEY`), the gate of the read-only `cotisant-status`. Read at each call,
 * so a rotated key needs no restart, and kept out of the controller so it is tested on its own.
 *
 * Timing-safe, and CLOSED on an unset key: an empty expected value refuses everything.
 *
 * @throws ForbiddenException unless `key` matches
 */
export function assertCercleApiKey(key: string | undefined): void {
  const expected = Buffer.from(process.env.CERCLE_API_KEY ?? '');
  const received = Buffer.from(key ?? '');
  if (
    expected.length === 0 ||
    received.length !== expected.length ||
    !crypto.timingSafeEqual(expected, received)
  ) {
    throw new ForbiddenException();
  }
}
