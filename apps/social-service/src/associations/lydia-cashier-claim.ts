import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/**
 * THE ONE CLAIM OF EVERY LYDIA CASHIER OPERATION OF AN ASSOCIATION (lots 2 and 3): the
 * Responsable's step, an add, a role change, a removal and an erasure's removals. The claim is
 * `associations."lydiaResponsableStartedAt"` (migration 118) plus a random token
 * (`"lydiaCashierClaimToken"`, migration 119): it is taken in the SAME transaction that locks the
 * association row and reads the cashier rows, so what the checks read is what the operation acts
 * on; and only a release or a record carrying the token clears it, so a late caller can never
 * clear a claim another operation has taken since.
 */

/**
 * The `code` (409) of a record or release whose claim token is not the association's: the claim
 * was cleared (by a global admin) and possibly taken by another operation since. Nothing written.
 */
export const LYDIA_CASHIER_CLAIM_LOST = 'LYDIA_CASHIER_CLAIM_LOST';
/**
 * The `code` (409) of a removal whose number is no longer the one sealed on the row it names: what
 * was removed at Lydia is not recorded against another number.
 */
export const LYDIA_CASHIER_NUMBER_CHANGED = 'LYDIA_CASHIER_NUMBER_CHANGED';
/**
 * The `code` (409) of a number already held by a live cashier row of the association (its own or a
 * Responsable's other number): adding it again would REPLACE that cashier's rights at Lydia. Shared
 * by the cashier steps and the Responsable's step.
 */
export const LYDIA_CASHIER_PHONE_IN_USE = 'LYDIA_CASHIER_PHONE_IN_USE';

/** The `code` (400) of a record whose body does not say whether Lydia confirmed the rights. */
export const LYDIA_CASHIER_CONFIRMED_REQUIRED = 'LYDIA_CASHIER_CONFIRMED_REQUIRED';

/** The association row as a claim reads it, locked (`FOR UPDATE`) by the transaction. */
export interface LockedAssociation {
  vendorToken: string | null;
  claimed: boolean;
  claimToken: string | null;
}

/** Locks association `id` in `manager`'s transaction; null when it does not exist. */
export async function lockAssociation(
  manager: EntityManager,
  id: string
): Promise<LockedAssociation | null> {
  const rows: Array<{
    vendorToken: string | null;
    startedAt: Date | null;
    claimToken: string | null;
  }> = await manager.query(
    `SELECT "lydiaAccountId" AS "vendorToken", "lydiaResponsableStartedAt" AS "startedAt",
            "lydiaCashierClaimToken" AS "claimToken"
       FROM associations WHERE id = $1 FOR UPDATE`,
    [id]
  );
  if (rows.length === 0) return null;
  return {
    vendorToken: rows[0].vendorToken?.trim() || null,
    claimed: rows[0].startedAt != null,
    claimToken: rows[0].claimToken ?? null,
  };
}

/** Writes the claim and a NEW token on the association row locked by `manager`; answers the token. */
export async function writeClaim(manager: EntityManager, id: string): Promise<string> {
  const token = randomUUID();
  await manager.query(
    `UPDATE associations SET "lydiaResponsableStartedAt" = now(), "lydiaCashierClaimToken" = $2
      WHERE id = $1`,
    [id, token]
  );
  return token;
}

/**
 * Clears the claim of association `id` when, and only when, it carries `token`. Answers whether it
 * was cleared. `query` is a repository's or a transaction's.
 */
export async function clearClaim(
  query: (sql: string, params: unknown[]) => Promise<unknown>,
  id: string,
  token: string
): Promise<boolean> {
  const result = (await query(
    `UPDATE associations SET "lydiaResponsableStartedAt" = NULL, "lydiaCashierClaimToken" = NULL
      WHERE id = $1 AND "lydiaCashierClaimToken" = $2::uuid
      RETURNING id`,
    [id, token]
  )) as unknown[];
  const written = Array.isArray(result[0]) ? (result[0] as unknown[]).length : result.length;
  return written > 0;
}

/**
 * A record's `confirmed`, which must be an explicit boolean: absent (`undefined`) or anything else
 * is the typed 400 `LYDIA_CASHIER_CONFIRMED_REQUIRED`, never read as a falsy "unconfirmed".
 */
export function confirmedOf(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  throw new BadRequestException({
    code: LYDIA_CASHIER_CONFIRMED_REQUIRED,
    message:
      value === undefined
        ? 'confirmed is required (true or false)'
        : 'confirmed must be true or false',
  });
}

/** The typed 409 of a claim token that is not the association's (see `LYDIA_CASHIER_CLAIM_LOST`). */
export function claimLost(): ConflictException {
  return new ConflictException({
    code: LYDIA_CASHIER_CLAIM_LOST,
    message: 'The claim of this cashier operation was cleared meanwhile',
  });
}

/** A claim token as a body carries it: a UUID, or null. */
export function claimTokenOf(value: unknown): string | null {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())
    ? value.trim()
    : null;
}
