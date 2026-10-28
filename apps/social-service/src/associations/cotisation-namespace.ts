import { ConflictException, Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { cotisationStem, cotisationStemsCollide } from './cotisation-tag.util';

/** Refusal code of `assertCotisationStemFree`: a 409 carrying `{ code, message }`. */
export const COTISATION_TAG_COLLISION = 'COTISATION_TAG_COLLISION';

/** The `code` of the 409 a tier retag gets when a holder already holds a tag of the new name. */
export const TIER_TAG_NAME_TAKEN = 'TIER_TAG_NAME_TAKEN';

const logger = new Logger('CotisationNamespace');

/**
 * Every cotisation stem of every association but `associationId` (all of them when null): each
 * slug, and `<slug>-<variantKey>` for each named membership tier.
 */
async function otherAssociationStems(
  manager: EntityManager,
  associationId: string | null
): Promise<string[]> {
  const others: { slug: string; variantKey: string | null }[] = await manager.query(
    `SELECT a.slug, p."variantKey"
       FROM associations a
       LEFT JOIN association_products p
         ON p."associationId" = a.id AND p.type = 'membership' AND p."variantKey" IS NOT NULL
      WHERE $1::uuid IS NULL OR a.id <> $1::uuid`,
    [associationId]
  );
  return others.flatMap((o) => [
    o.slug,
    ...(o.variantKey ? [cotisationStem(o.slug, o.variantKey)] : []),
  ]);
}

/**
 * Reads the other associations' stems ONCE and answers, for each candidate stem, whether it
 * collides with one (`cotisationStemsCollide`) - the comparison `assertCotisationStemFree` makes,
 * offered as a predicate so a DERIVED tier key can step past a collision instead of being refused
 * for a key nobody typed (`ProductsService.saveTierWithDerivedKey`). It holds no lock, for the
 * reason `assertCotisationStemFree` gives.
 */
export async function stemCollidesElsewhere(
  manager: EntityManager,
  associationId: string
): Promise<(stem: string) => boolean> {
  const stems = await otherAssociationStems(manager, associationId);
  logger.debug(
    `[COTISATION] ${stems.length} other stem(s) read for a derived key of assoc=${associationId.slice(0, 8)}`
  );
  return (stem) => {
    const clash = stems.some((other) => cotisationStemsCollide(stem, other));
    if (clash) logger.debug(`[COTISATION] derived stem "${stem}" collides elsewhere, skipped`);
    return clash;
  };
}

/**
 * Whether an error is the refusal `assertCotisationStemFree` throws, read from its typed `code` -
 * so a caller that can cure the collision (a DERIVED slug walking to its next suffix) tells it apart
 * from every other 409 without reading a message.
 */
export function isCotisationStemCollision(err: unknown): boolean {
  if (!(err instanceof ConflictException)) return false;
  const body = err.getResponse();
  return typeof body === 'object' && (body as { code?: unknown }).code === COTISATION_TAG_COLLISION;
}

/**
 * Refuses (409 `COTISATION_TAG_COLLISION`) a cotisation stem (`cotisationStem`) that could derive
 * the same tag name as a stem of ANOTHER association: its slug (the base tier, whether or not it
 * has cotisations enabled yet, since it may enable them later) or `<slug>-<variantKey>` for each of
 * its membership tiers. One association's tag names are then never another's, whatever their modes.
 *
 * Called by every path that brings a new stem into existence: an association's creation (its
 * slug), a tier's creation and a tier's retag (its key). `associationId` is the association the
 * stem belongs to (null while it is being created), whose own stems are not compared.
 *
 * It holds NO lock, deliberately: the two stems it compares belong to two DIFFERENT associations,
 * and no lock of the existing order (association -> buyer -> checkout row -> `user_tags`) spans two
 * associations, so taking one would serialise nothing that matters here. Two creations racing on
 * colliding stems within one instant can both pass; what bounds that case is not this check but the
 * grants and reads behind it - a grant never renews a row another association issued
 * (`TagHeldByAnotherIssuerError`), and every tier read counts only its own association's rows - so
 * a collision can refuse a grant, never let one association's row stand for the other's tier.
 */
export async function assertCotisationStemFree(
  manager: EntityManager,
  associationId: string | null,
  stem: string
): Promise<void> {
  const clash = (await otherAssociationStems(manager, associationId)).find((other) =>
    cotisationStemsCollide(stem, other)
  );
  logger.debug(
    `[COTISATION] stem "${stem}" for assoc=${associationId?.slice(0, 8) ?? 'new'}: ${clash ? 'collides' : 'free'}`
  );
  if (clash === undefined) return;
  logger.warn(
    `[COTISATION] stem "${stem}" refused for assoc=${associationId?.slice(0, 8) ?? 'new'}: ` +
      `its tag names can coincide with another association's`
  );
  throw new ConflictException({
    code: COTISATION_TAG_COLLISION,
    message: "This name would make the cotisation's tags coincide with another association's",
  });
}
