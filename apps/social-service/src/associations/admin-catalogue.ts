import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AssociationPermissionFlag } from './entities/association-member.entity';

/**
 * THE TYPED REFUSALS OF THE PLATFORM ADMINISTRATOR'S ENTITY ROUTES (`associations/admin/*`, owner
 * 2026-11-02). Classified at the throw: a client reads `code`, never the message.
 */
export const ADMIN_ASSOCIATION_ERROR = {
  /** A placement (explicit spaces, first admin) handed to `create` by anyone but a platform admin. */
  PLATFORM_ADMIN_ONLY: 'ADMIN_ASSOCIATION_PLATFORM_ADMIN_ONLY',
  /** The first admin picked names no account. */
  FIRST_ADMIN_UNKNOWN: 'ADMIN_ASSOCIATION_FIRST_ADMIN_UNKNOWN',
  /** An institution's first admin asked to manage its members: that is the platform admin's alone. */
  INSTITUTION_MEMBERS_PLATFORM_ONLY: 'ADMIN_ASSOCIATION_INSTITUTION_MEMBERS_PLATFORM_ONLY',
  /** A catalogue cursor this server did not write. */
  BAD_CURSOR: 'ADMIN_ASSOCIATION_BAD_CURSOR',
} as const;

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
 * Reads a cursor back. Anything this server did not write - truncated, edited, another shape - is a
 * typed 400, never a 500 and never a silent first page.
 */
export function decodeCatalogueCursor(cursor: string): CataloguePosition {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      typeof value[1] === 'string'
    ) {
      return { name: value[0], id: value[1] };
    }
  } catch {
    // Falls through to the typed refusal below: a cursor that does not parse is not ours.
  }
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

/**
 * AN INSTITUTION'S MEMBERS ARE MANAGED BY THE PLATFORM ADMIN ONLY (owner, 2026-11-02), so its first
 * admin may hold every right of the kind EXCEPT `MANAGE_MEMBERS`. Refused, never silently narrowed:
 * a mask the server rewrote would be a member who believes they hold a right they do not.
 */
export function assertFirstAdminAllowedForType(type: string, permissions: number): void {
  if (type !== 'institution') return;
  if ((permissions & AssociationPermissionFlag.MANAGE_MEMBERS) === 0) return;
  throw new BadRequestException({
    code: ADMIN_ASSOCIATION_ERROR.INSTITUTION_MEMBERS_PLATFORM_ONLY,
    message: "Only the platform administrator manages an institution's members.",
  });
}
