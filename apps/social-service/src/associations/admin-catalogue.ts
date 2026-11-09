import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { isUUID } from 'class-validator';

/**
 * THE TYPED REFUSALS OF THE PLATFORM ADMINISTRATOR'S ENTITY ROUTES (`associations/admin/*`, owner
 * 2026-11-02). Classified at the throw: a client reads `code`, never the message.
 */
export const ADMIN_ASSOCIATION_ERROR = {
  /** A placement (explicit spaces, first admin) handed to `create` by anyone but a platform admin. */
  PLATFORM_ADMIN_ONLY: 'ADMIN_ASSOCIATION_PLATFORM_ADMIN_ONLY',
  /** The first admin picked names no account. */
  FIRST_ADMIN_UNKNOWN: 'ADMIN_ASSOCIATION_FIRST_ADMIN_UNKNOWN',
  /**
   * An institution's member written by anyone but the platform admin, or handed `MANAGE_MEMBERS`:
   * its members are the platform admin's alone (`assertInstitutionMemberWrite`, the one rule).
   */
  INSTITUTION_MEMBERS_PLATFORM_ONLY: 'ADMIN_ASSOCIATION_INSTITUTION_MEMBERS_PLATFORM_ONLY',
  /** A catalogue cursor this server did not write. */
  BAD_CURSOR: 'ADMIN_ASSOCIATION_BAD_CURSOR',
} as const;

const logger = new Logger('AdminCatalogue');

/** The one character PostgreSQL text cannot hold, spelt by code point. */
const NUL = String.fromCharCode(0);

/** The default page of the admin catalogue: a screenful of rows, never the whole table. */
export const ADMIN_CATALOGUE_DEFAULT_LIMIT = 50;

/** The keyset position of a catalogue row: the order is `(name, id)`, so both are the key. */
export interface CataloguePosition {
  name: string;
  id: string;
}

/** The opaque `next` cursor of a page: the position of its last row. */
export function encodeCatalogueCursor(position: CataloguePosition): string {
  return Buffer.from(JSON.stringify([position.name, position.id]), 'utf8').toString('base64url');
}

/**
 * Reads a cursor back. Anything this server did not write - truncated, edited, another shape, an id
 * that is not a UUID, a name PostgreSQL cannot hold (a NUL) - is a typed 400, never a 500 from the
 * driver and never a silent first page.
 */
export function decodeCatalogueCursor(cursor: string): CataloguePosition {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      typeof value[1] === 'string' &&
      !value[0].includes(NUL) &&
      isUUID(value[1])
    ) {
      return { name: value[0], id: value[1] };
    }
  } catch {
    // Falls through to the typed refusal below: a cursor that does not parse is not ours.
  }
  logger.warn(
    `[ADMIN_CATALOGUE] cursor refused: not one this server wrote (${cursor.length} chars)`
  );
  throw new BadRequestException({
    code: ADMIN_ASSOCIATION_ERROR.BAD_CURSOR,
    message: 'This catalogue cursor is not one this server wrote.',
  });
}

/** The refusal of a placement asked for by anyone but a platform admin. */
export function platformAdminOnly(): ForbiddenException {
  return new ForbiddenException({
    code: ADMIN_ASSOCIATION_ERROR.PLATFORM_ADMIN_ONLY,
    message: 'Only a platform administrator places a new entity in its spaces.',
  });
}
