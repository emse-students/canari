import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { UserTagService } from '../users/user-tag.service';
import { NO_CURSUS, type CursusView, type PricingFacts } from './audience';
import { coreUrl } from '../internal/service-urls';

/**
 * What core-service's internal profile route answers with - the part read here. `cursusViews` is
 * every cursus the person is priced through (D32), already reconciled by core-service
 * (`cursusViewsOf`: the well-formed entries plus the legacy pair when no entry carries it), so
 * nothing is reconciled here. Absent from a core-service older than it.
 */
interface InternalPublicProfile {
  id: string;
  cursusViews?: CursusView[];
}

/**
 * The `code` of the 503 a profile-priced operation gets when core-service answers without
 * `cursusViews` - a core-service OLDER than this service, which only a ROLLBACK produces (a forward
 * deploy replaces core-service first; `cicd.md`). Typed so the log and the answer name the cause.
 */
export const PRICING_CORE_BEHIND = 'PRICING_CORE_BEHIND';

/**
 * Assembles the facts a price's criteria are evaluated against, once per request.
 *
 * The person is a form's submitter or a boutique buyer - the criteria do not care which, and that
 * is the point: one grid, one bucket predicate, one set of facts. A price that disagreed with
 * itself between the two surfaces would be nobody's bug to report.
 *
 * The cursus (`promo` and `formation` per entry, and the legacy columns derived from it) live in
 * core-service's `users` table, written by `findOrCreateFromOidc` (from the identity provider, at
 * every sign-in) and by the platform admin's profile edit (`ProfileEditService.applyEdit`, audited)
 * - `PATCH /api/users/me` accepts `bio` and nothing else. That is what makes them safe to price on:
 * nobody can edit themselves into a cheaper cell. Under D32 an admin adding a second cursus can move
 * that person's price, since the cheapest cursus wins. **If `UpdateUserDto` ever gains `promo`,
 * `formation` or `cursus`, every price resting on it becomes self-service.**
 *
 * They are fetched over the Docker network from `/api/internal/users/:id/public-profile`, which
 * exists, is `INTERNAL_SECRET`-gated and has no nginx location. Deliberately not obtained by
 * widening the nginx auth subrequest into carrying profile headers (a forgeable input on a money
 * decision) and deliberately not replicated into this service (a stale replica prices wrongly, and
 * silently).
 */
@Injectable()
export class PricingFactsService {
  private readonly logger = new Logger(PricingFactsService.name);

  constructor(private readonly userTagService: UserTagService) {}

  /**
   * Builds the facts for one person.
   *
   * `needProfile` is asked by the caller from its own criteria, so a grid resting only on
   * cotisation tiers or answers never calls core-service and therefore cannot be blocked by it.
   *
   * An absent `userId` is a guest - a guest submission, or the boutique of an association read
   * while logged out: no cotisation, no promo, no formation. That is an ANSWER, not a failure; a
   * guest genuinely has none of these and belongs in the "everyone else" bucket of every
   * dimension.
   */
  async build(input: {
    userId?: string;
    associationId?: string | null;
    answers?: Record<string, string[]>;
    needProfile: boolean;
  }): Promise<PricingFacts> {
    const answers = input.answers ?? {};

    const cotisationTiers =
      input.userId && input.associationId
        ? await this.userTagService.listHeldCotisationTiers(input.userId, input.associationId)
        : [];

    const cursus = await this.cursusFor(input.userId, input.needProfile);
    return { cursus, cotisationTiers, answers };
  }

  /**
   * The cotisation half of the facts for MANY associations at once, for a list judged per
   * association (`UserTagService.heldCotisationTiersByAssociation`): what `build` reads one
   * association at a time.
   */
  cotisationTiersByAssociation(
    userId: string,
    associationIds: readonly string[]
  ): Promise<Map<string, (string | null)[]>> {
    return this.userTagService.heldCotisationTiersByAssociation(userId, associationIds);
  }

  /**
   * The identity-provider half of the facts, on its own.
   *
   * Split out for a LIST: the boutique prices many products, of many associations, for one person.
   * The cotisation half differs per association and is already loaded in bulk by the caller; the
   * cursus are one person's and must be fetched ONCE, not once per product - N calls to
   * core-service to answer the same question is how a listing becomes the slowest page.
   *
   * A guest, or a caller whose criteria need no profile, gets `NO_CURSUS` without a round trip.
   */
  async cursusFor(
    userId: string | undefined,
    needProfile: boolean
  ): Promise<readonly CursusView[]> {
    if (!needProfile || !userId) return NO_CURSUS;
    return this.fetchCursus(userId);
  }

  /**
   * Fetches every cursus entry (promo and formation of each), or refuses the operation.
   *
   * Fails CLOSED and loudly. Both silent alternatives are wrong in a way nobody would notice: the
   * "everyone else" cell overcharges a student who qualified for a discount, and a guessed bucket
   * undercharges the association. A transport failure is not an answer, so it produces neither - it
   * produces a 503 saying it is us and to retry.
   *
   * A 404 IS an answer: core-service has no such user, so there is no cursus, and the submitter
   * belongs in the "everyone else" bucket. That is the one status treated as data. So is an EMPTY
   * cursus (staff, a post only): `NO_CURSUS`, one view with nothing in it.
   *
   * A 200 WITHOUT `cursusViews` is a core-service older than D32 (a rollback window): refused with
   * the typed `PRICING_CORE_BEHIND`, rather than priced as somebody with no cursus - that would
   * overcharge every student it served.
   */
  private async fetchCursus(userId: string): Promise<readonly CursusView[]> {
    const url = coreUrl(`internal/users/${encodeURIComponent(userId)}/public-profile`);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'x-internal-secret': process.env.INTERNAL_SECRET ?? '' },
      });
    } catch (e) {
      this.logger.error(
        `[PRICING] profile fetch FAILED user=${userId.slice(0, 8)} - a price depends on it, so the ` +
          `operation is refused rather than priced wrongly: ${e instanceof Error ? e.message : String(e)}`
      );
      throw new ServiceUnavailableException(
        'Cannot check your profile right now, so this cannot be priced. Please try again in a moment.'
      );
    }
    if (res.status === 404) {
      this.logger.warn(
        `[PRICING] profile MISS user=${userId.slice(0, 8)} - no such user in core-service, priced as "everyone else"`
      );
      return NO_CURSUS;
    }
    if (!res.ok) {
      this.logger.error(
        `[PRICING] profile fetch returned ${res.status} user=${userId.slice(0, 8)} - refusing rather than pricing wrongly`
      );
      throw new ServiceUnavailableException(
        'Cannot check your profile right now, so this cannot be priced. Please try again in a moment.'
      );
    }
    const profile = (await res.json()) as InternalPublicProfile;
    if (!Array.isArray(profile.cursusViews)) {
      this.logger.error(
        `[PRICING] ${PRICING_CORE_BEHIND} user=${userId.slice(0, 8)} - core-service older than the ` +
          'cursus views (a rollback window); refusing rather than pricing on nothing'
      );
      throw new ServiceUnavailableException({
        code: PRICING_CORE_BEHIND,
        message:
          'Cannot check your profile right now, so this cannot be priced. Please try again in a moment.',
      });
    }
    const cursus = profile.cursusViews.map((view) => ({
      promo: view.promo ?? null,
      formation: view.formation ?? null,
    }));
    this.logger.debug(
      `[PRICING] profile user=${userId.slice(0, 8)} cursus=` +
        (cursus.length ? cursus.map((c) => `${c.formation}:${c.promo}`).join(',') : 'none')
    );
    return cursus.length ? cursus : NO_CURSUS;
  }

  /**
   * Distinct formation values in use, with counts, for the criterion editor's picker.
   *
   * Refuses rather than returning an empty list: "this school has no formations" and "I could not
   * ask" look identical to a manager, and the first one would have them build a criterion that
   * matches nobody.
   */
  async listFormations(): Promise<{ value: string; count: number }[]> {
    const url = coreUrl('internal/users/formations');
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'x-internal-secret': process.env.INTERNAL_SECRET ?? '' },
      });
    } catch (e) {
      this.logger.error(
        `[PRICING] formations listing failed: ${e instanceof Error ? e.message : String(e)}`
      );
      throw new ServiceUnavailableException(
        'Cannot list formations right now. Try again in a moment.'
      );
    }
    if (!res.ok) {
      this.logger.error(`[PRICING] formations listing returned ${res.status}`);
      throw new ServiceUnavailableException(
        'Cannot list formations right now. Try again in a moment.'
      );
    }
    return (await res.json()) as { value: string; count: number }[];
  }
}
