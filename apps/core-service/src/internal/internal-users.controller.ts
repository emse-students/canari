import { Controller, Get, Headers, Logger, NotFoundException, Param } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { assertInternalSecret } from './internal-secret.util';
import { User } from '../users/entities/user.entity';
import { cursusViewsOf, type Campus, type CursusView, type Post } from '../users/miconnect-profile';
import { cursusEntriesSql, WELL_FORMED_ENTRY_SQL } from '../users/cursus-filter';
import { isInReviewCohort } from '../review-cohort';
import { RouteParams } from '../common/route-params';

/**
 * The minimum a `/profile/:id` share needs to render a preview, plus what social-service prices on.
 *
 * `cursusViews` is every cursus social-service evaluates a price grid, a question's condition and a
 * form's audience through (D32 - two cursus pay the most favourable price), built by
 * `cursusViewsOf`: the well-formed entries plus the legacy pair when no entry carries it, so
 * social-service reconciles nothing. `promo`/`formation` are the legacy columns, kept for the readers
 * that still take them.
 */
export interface InternalPublicProfile {
  id: string;
  displayName: string | null;
  promo: number | null;
  formation: string | null;
  cursusViews: CursusView[];
}

/**
 * What a form may join to an answer from the respondent's account (forms, "the respondent's account
 * fields", owner 2026-11-16): read by social-service AT SUBMIT TIME and stored with the answer as a
 * snapshot. Every field is the identity provider's (D9: edited by an admin only), so a respondent
 * cannot type a cheaper or another identity here. `cursusViews` is built by `cursusViewsOf`, the
 * one reconciliation pricing also reads; `posts` is what tells staff (D2, D27: the former
 * "Personnel de l'ecole" claim became an EMSE post), so no new claim is read.
 */
export interface InternalRespondentIdentity {
  firstName: string | null;
  lastName: string | null;
  campus: Campus | null;
  posts: Post[];
  cursusViews: CursusView[];
}

/**
 * The typed `code` of the 404 for an unknown account, so social-service tells it from the 404 an
 * OLDER core-service answers for a route it does not have (a rollback window): the first is an
 * answer, the second is not.
 */
export const RESPONDENT_UNKNOWN = 'RESPONDENT_UNKNOWN';

/**
 * Session-free display-name lookup, called by the web SSR process when it renders the Open Graph
 * head of `/profile/:id`.
 *
 * `GET /api/users/:id` is behind `NginxAuthGuard` and returns the whole user row; an unfurler has
 * no session, and the head needs a name, a promo and nothing more. Deliberately narrower than
 * `/api/external/profile/:sub`, which aggregates the bio and the association history for Sky and
 * is keyed on a different credential (`EXTERNAL_API_KEY`) - handing that key to the renderer would
 * widen its reach for no gain.
 *
 * NOT reachable through nginx: `/api/internal` has no location, so this is Docker-network only,
 * and gated on INTERNAL_SECRET on top of that.
 */
@RouteParams({ id: 'opaque' })
@Controller('internal')
export class InternalUsersController {
  private readonly logger = new Logger(InternalUsersController.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>
  ) {}

  /**
   * Distinct formation values in use, with how many users carry each - read from EVERY well-formed
   * cursus entry AND the legacy `formation` column (D32, the same union as `cursusViewsOf`), so a
   * formation followed only as a second cursus is offered, a person the backfill has not reached
   * still counts, and a person counts once per formation however many places name it.
   *
   * Called by social-service to populate a form's "filtrer par formation" picker. It offers what
   * is IN USE, a subset of `FORMATIONS` since a cursus may name nothing else (D4), so a manager is
   * not offered a formation nobody carries; what a criterion may NAME is the full list, enforced by
   * social-service where the form is saved. The counts are there so a manager can see a criterion
   * reaches 3 people before building a price around it.
   *
   * Aggregate only: no id, no name, nothing about any individual.
   */
  @Get('users/formations')
  async formations(
    @Headers('x-internal-secret') secret?: string
  ): Promise<{ value: string; count: number }[]> {
    assertInternalSecret(secret);
    const rows: { value: string; count: string }[] = await this.userRepo.query(FORMATIONS_SQL);
    this.logger.debug(`internal formations listing rows=${rows.length}`);
    return rows.map((r) => ({ value: r.value, count: Number(r.count) }));
  }

  /** Display identity for a user id, for the shared-link preview. */
  @Get('users/:id/public-profile')
  async publicProfile(
    @Param('id') id: string,
    @Headers('x-internal-secret') secret?: string
  ): Promise<InternalPublicProfile> {
    assertInternalSecret(secret);
    // A review account has no public identity (review-cohort.ts): the shared-link preview is served
    // to whoever opens `/profile/<id>`, signed in or not, so it never names one - the same 404 as
    // an unknown id.
    if (isInReviewCohort(id)) {
      this.logger.debug(`internal public-profile withheld id=${id.slice(0, 8)}: review cohort`);
      throw new NotFoundException();
    }
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) {
      this.logger.debug(`internal public-profile miss id=${id.slice(0, 8)}`);
      throw new NotFoundException();
    }
    return {
      id: user.id,
      displayName: user.displayName ?? null,
      promo: user.promo ?? null,
      formation: user.formation ?? null,
      cursusViews: cursusViewsOf(user),
    };
  }

  /**
   * The account fields a form may join to an answer ({@link InternalRespondentIdentity}), read by
   * social-service when a member submits. A review account is answered like any account: the form
   * it answers is its own cohort's (`assertReviewerReachesAssociation` runs before this is asked).
   */
  @Get('users/:id/respondent-identity')
  async respondentIdentity(
    @Param('id') id: string,
    @Headers('x-internal-secret') secret?: string
  ): Promise<InternalRespondentIdentity> {
    assertInternalSecret(secret);
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) {
      this.logger.warn(`internal respondent-identity miss id=${id.slice(0, 8)}`);
      throw new NotFoundException({ code: RESPONDENT_UNKNOWN, message: 'No such account.' });
    }
    // No id here (review, 2026-11-21): only a form submit calls this route, so a line naming
    // the account would pair it, within the second, with the access log's submit URL - on an
    // ANONYMOUS form that would name who answered. The miss above stays: it is the accusation.
    this.logger.debug('internal respondent-identity read');
    return {
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      campus: user.campus ?? null,
      posts: Array.isArray(user.posts) ? user.posts : [],
      cursusViews: cursusViewsOf(user),
    };
  }
}

/**
 * Every formation named by a well-formed cursus entry or by the legacy `formation` column, and how
 * many DISTINCT people name it; the most used first, then by name so equal counts list in a stable
 * order. A `cursus` that is not a list (a JSON null, an object) contributes no entry instead of
 * failing the query for everyone (`cursusEntriesSql`).
 */
export const FORMATIONS_SQL = `
  SELECT named.value AS value, COUNT(DISTINCT named.id) AS count
  FROM (
    SELECT u.id, entry->>'formation' AS value
    FROM users u
    CROSS JOIN LATERAL ${cursusEntriesSql('u.cursus')} AS entry
    WHERE ${WELL_FORMED_ENTRY_SQL}
    UNION ALL
    SELECT u.id, u.formation AS value FROM users u
  ) AS named
  WHERE COALESCE(named.value, '') <> ''
  GROUP BY named.value
  ORDER BY COUNT(DISTINCT named.id) DESC, named.value ASC`;
