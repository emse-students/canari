import { ForbiddenException, Logger, ServiceUnavailableException } from '@nestjs/common';
import * as crypto from 'crypto';
import type { SpaceSelection } from './directory-query';
import type { SpacePair } from '../spaces/reader-spaces';

/**
 * THE SIGNED AGENDA URL (D40 amended 2026-10-06, docs/wiki/profiles-and-access.md).
 *
 * A calendar app sends no identity, so a subscription cannot be restricted by WHO asks. It is
 * restricted by WHAT is asked: the URL carries `sig`, an HMAC of the canonical selection (campus,
 * formation, association) under `AGENDA_SIGNING_KEY`, and the server signs ONLY selections inside
 * the signed-in reader's own spaces. The signature names no one: two readers of the same campus
 * hold the same URL, and a URL saved by a student keeps working for as long as the key does.
 * Rotating the key ends every saved URL at once - that is the revocation.
 */

/** 403 code: the selection names a campus / formation / association and carries no `sig`. */
export const AGENDA_SIGNATURE_REQUIRED = 'AGENDA_SIGNATURE_REQUIRED';
/** 403 code: `sig` is not the signature of THIS selection (tampered, or made for another one). */
export const AGENDA_SIGNATURE_INVALID = 'AGENDA_SIGNATURE_INVALID';
/** 403 code: the signed-in reader asked to sign a selection outside their own spaces. */
export const AGENDA_SELECTION_FORBIDDEN = 'AGENDA_SELECTION_FORBIDDEN';

/** What a signature covers. `from`/`to` are deliberately NOT part of it: the window is free. */
export interface SignedSelection extends SpaceSelection {
  associationId: string | null;
}

const MIN_KEY_LENGTH = 32;
const logger = new Logger('AgendaSignature');

/** One unambiguous string per selection; the format version leaves room to change it later. */
export function canonicalAgendaSelection(sel: SignedSelection): string {
  return `v1|campus=${sel.campus ?? '-'}|formation=${sel.formation ?? '-'}|association=${sel.associationId ?? '-'}`;
}

/** The key, or a 503: an unset key is a deployment fault, never "no signature needed". */
function signingKey(): string {
  const key = process.env.AGENDA_SIGNING_KEY ?? '';
  if (key.length < MIN_KEY_LENGTH) {
    logger.error(`[AGENDA_SIG] AGENDA_SIGNING_KEY is unset or shorter than ${MIN_KEY_LENGTH}`);
    throw new ServiceUnavailableException('Agenda signing is not configured');
  }
  return key;
}

/** Base64url HMAC-SHA256 of the canonical selection. */
export function signAgendaSelection(sel: SignedSelection): string {
  return crypto
    .createHmac('sha256', signingKey())
    .update(canonicalAgendaSelection(sel))
    .digest('base64url');
}

/** Constant-time check; 403 `AGENDA_SIGNATURE_REQUIRED` when absent, `..._INVALID` when wrong. */
export function assertAgendaSignature(sel: SignedSelection, sig: string | undefined): void {
  const received = sig?.trim();
  if (!received) {
    throw new ForbiddenException({
      code: AGENDA_SIGNATURE_REQUIRED,
      message: 'This agenda selection needs a signed link: subscribe again from the Canari app',
    });
  }
  const expected = Buffer.from(signAgendaSelection(sel));
  const got = Buffer.from(received);
  if (got.length !== expected.length || !crypto.timingSafeEqual(expected, got)) {
    logger.warn(`[AGENDA_SIG] refused a signature for ${canonicalAgendaSelection(sel)}`);
    throw new ForbiddenException({
      code: AGENDA_SIGNATURE_INVALID,
      message: 'The signature does not match this agenda selection',
    });
  }
}

/**
 * May a reader whose spaces are `spaces` be handed a signature for `sel`? Campus alone: their
 * campus. Formation alone: one of their formations. Both: one of their spaces. An association adds
 * no condition of its own - membership does not matter (user, 2026-10-06) and its page is public;
 * the caller checks that it exists.
 */
export function selectionWithinSpaces(sel: SpaceSelection, spaces: readonly SpacePair[]): boolean {
  if (sel.campus === null && sel.formation === null) return true;
  return spaces.some(
    (s) =>
      (sel.campus === null || s.campus === sel.campus) &&
      (sel.formation === null || s.formation === sel.formation)
  );
}
