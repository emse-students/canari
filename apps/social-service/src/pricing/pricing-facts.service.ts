import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { UserTagService } from '../users/user-tag.service';
import type { PricingFacts } from './audience';

/** What core-service's internal profile route answers with. */
interface InternalPublicProfile {
  id: string;
  displayName: string | null;
  promo: number | null;
  formation: string | null;
}

/**
 * Assembles the facts a price's criteria are evaluated against, once per request.
 *
 * The person is a form's submitter or a boutique buyer - the criteria do not care which, and that
 * is the point: one grid, one bucket predicate, one set of facts. A price that disagreed with
 * itself between the two surfaces would be nobody's bug to report.
 *
 * `promo` and `formation` live in core-service's `users` table and are written ONLY by
 * `findOrCreateFromOidc`, from the identity provider, at every sign-in - `PATCH /api/users/me`
 * accepts `bio` and nothing else. That is what makes them safe to price on: nobody can edit
 * themselves into a cheaper cell. **If `UpdateUserDto` ever gains either field, every price resting
 * on it becomes self-service.**
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
  private readonly coreUrl = process.env.USER_SERVICE_URL ?? 'http://core-service:3012';

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

    const profile = await this.profileFor(input.userId, input.needProfile);
    return { ...profile, cotisationTiers, answers };
  }

  /**
   * The identity-provider half of the facts, on its own.
   *
   * Split out for a LIST: the boutique prices many products, of many associations, for one person.
   * The cotisation half differs per association and is already loaded in bulk by the caller; the
   * promo and the formation are one person's and must be fetched ONCE, not once per product - N
   * calls to core-service to answer the same question is how a listing becomes the slowest page.
   *
   * A guest, or a caller whose criteria need no profile, gets both as null without a round trip.
   */
  async profileFor(
    userId: string | undefined,
    needProfile: boolean
  ): Promise<{ promo: number | null; formation: string | null }> {
    if (!needProfile || !userId) return { promo: null, formation: null };
    return this.fetchProfile(userId);
  }

  /**
   * Fetches promo and formation, or refuses the operation.
   *
   * Fails CLOSED and loudly. Both silent alternatives are wrong in a way nobody would notice: the
   * "everyone else" cell overcharges a student who qualified for a discount, and a guessed bucket
   * undercharges the association. A transport failure is not an answer, so it produces neither - it
   * produces a 503 saying it is us and to retry.
   *
   * A 404 IS an answer: core-service has no such user, so there is no promo and no formation, and
   * the submitter belongs in the "everyone else" bucket. That is the one status treated as data.
   */
  private async fetchProfile(
    userId: string
  ): Promise<{ promo: number | null; formation: string | null }> {
    const url = `${this.coreUrl}/api/internal/users/${encodeURIComponent(userId)}/public-profile`;
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
      return { promo: null, formation: null };
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
    this.logger.debug(
      `[PRICING] profile user=${userId.slice(0, 8)} promo=${profile.promo ?? 'null'} formation=${profile.formation ?? 'null'}`
    );
    return { promo: profile.promo ?? null, formation: profile.formation ?? null };
  }

  /**
   * Distinct formation values in use, with counts, for the criterion editor's picker.
   *
   * Refuses rather than returning an empty list: "this school has no formations" and "I could not
   * ask" look identical to a manager, and the first one would have them build a criterion that
   * matches nobody.
   */
  async listFormations(): Promise<{ value: string; count: number }[]> {
    const url = `${this.coreUrl}/api/internal/users/formations`;
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
