import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  Headers,
  Logger,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ClientIpThrottlerGuard } from '../common/guards/client-ip-throttler.guard';
import * as crypto from 'crypto';
import type { Response } from 'express';
import { AssociationsService } from '../associations/associations.service';
import { Association } from '../associations/entities/association.entity';
import { ProductsService } from '../associations/products.service';
import { PosterService, type PublishedCarteResponse } from '../associations/poster.service';
import type { PublishedCarteCard, PublishedCarteUnit } from '../associations/published-carte';
import { CARTE_ERROR } from '../associations/poster-scope';
import { parsePublicSpaceParam } from '../spaces/public-space';
import { internalCoreRequestConfig } from '../internal/core-request';
import { coreUrl } from '../internal/service-urls';
import { PostPreviewService, type PostSharePreview } from '../posts/post-preview.service';

/**
 * Public projection of an association/list for the read-only showcase.
 * Deliberately omits every sensitive column (document vault key, encrypted
 * notes, payment account id, quotas, createdBy) - only fields safe for an
 * unauthenticated visitor are surfaced.
 */
export interface PublicAssociation {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  bioMarkdown: string | null;
  logoUrl: string | null;
  logoMediaId: string | null;
  color: string | null;
  type: 'association' | 'list' | 'institution';
  promo: number | null;
  parentAssociationId: string | null;
  /** Lists only: display name of the parent association, when resolved. */
  parentName: string | null;
  /** Lists only: optional second theme name. Null otherwise. */
  name2: string | null;
  /** Lists only: optional second theme logo (media-service UUID). Null otherwise. */
  logoMediaId2: string | null;
  archived: boolean;
  isBDE: boolean;
  contactEmail: string | null;
  memberCount: number;
}

/** Maps a full association entity to the safe public subset. */
function toPublic(
  a: Association & { memberCount?: number; parentName?: string | null }
): PublicAssociation {
  return {
    id: a.id,
    slug: a.slug,
    name: a.name,
    description: a.description,
    bioMarkdown: a.bioMarkdown,
    logoUrl: a.logoUrl,
    logoMediaId: a.logoMediaId,
    color: a.color,
    type: a.type,
    promo: a.promo,
    parentAssociationId: a.parentAssociationId,
    parentName: a.parentName ?? null,
    name2: a.name2,
    logoMediaId2: a.logoMediaId2,
    archived: a.archived,
    isBDE: a.isBDE,
    contactEmail: a.contactEmail,
    memberCount: a.memberCount ?? 0,
  };
}

/** A card of the published carte, with the photo address of the public roster row behind it. */
export type PublicCarteCard = PublishedCarteCard & { avatarUrl: string | null };

/** The published carte as served without an account: every card carries {@link PublicCarteCard}. */
export type PublicCarteResponse = Omit<PublishedCarteResponse, 'units'> & {
  units: (Omit<PublishedCarteUnit, 'cards'> & { cards: PublicCarteCard[] })[];
};

/** How long the member-photo relay waits on core-service. One Docker-network hop. */
const MEMBER_AVATAR_TIMEOUT_MS = 5_000;

/**
 * How long a "no photo" answer may be kept: core's avatar route caches its own absence for the
 * same ten minutes, so a photo added later shows within one such window either way.
 */
const NO_PHOTO_CACHE_CONTROL = 'public, max-age=600';

/**
 * The ONE "no photo here" answer of the member-photo relay: a bodyless 404 with one header. A row
 * on no public roster and a member with no photo get exactly this, so they cannot be told apart.
 */
function answerNoPhoto(res: Response): void {
  res.set({ 'Cache-Control': NO_PHOTO_CACHE_CONTROL });
  res.status(404).end();
}

/**
 * Unauthenticated read-only API consumed by the portail-etu showcase, and since 2026-09-20 by the
 * link previews of shared Canari URLs.
 * Reachable via the nginx `/api/public/` location, which - unlike every other
 * `/api/*` route - is NOT behind `auth_request`. Exposes associations, promo
 * lists, their public members and association-post previews; never any write.
 *
 * THE SHOWCASE IS THE CEILING (owner, 2026-11-02): nothing here may show more than
 * portail-etu.emse.fr does, apart from the single-post link preview the owner kept the same day.
 * The listing of recent posts that used to sit here was closed then. Route by route:
 * docs/wiki/anonymous-surface.md.
 */
@Controller('public')
export class PublicController {
  private readonly logger = new Logger(PublicController.name);
  private readonly cercleApiKey = process.env.CERCLE_API_KEY ?? '';

  constructor(
    private readonly associations: AssociationsService,
    private readonly products: ProductsService,
    private readonly poster: PosterService,
    private readonly postPreviews: PostPreviewService
  ) {}

  /** Throws ForbiddenException unless the header matches CERCLE_API_KEY (timing-safe). */
  private assertCercleApiKey(key: string): void {
    const expected = Buffer.from(this.cercleApiKey);
    const received = Buffer.from(key ?? '');
    if (
      expected.length === 0 ||
      received.length !== expected.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      throw new ForbiddenException();
    }
  }

  /**
   * Lists associations and/or lists. `?type=association|list` restricts; omit for both.
   *
   * `?space=<formation>:<campus>` (owner, 2026-11-08) keeps only the rows whose audience reaches the
   * space, archived ones included - which the showcase lists in its archived section
   * (`spaces/public-space.ts`). EVERY TYPE since 2026-11-14 (owner: "Filtrer comme les assos"): a
   * list or an institution that does not address the space is left out like an association.
   * Without the parameter the answer is the COMPLETE list, unchanged, because Canari's own sitemap
   * and SEO read it too - AND BECAUSE THE PORTAIL-ETU SHOWCASE DID NOT SEND IT for the directory
   * until its `v1.0.9` (measured 2026-11-14: only its carte named a space), a shim
   * `docs/wiki/legacy-compatibility.md` dates. A malformed `space` is a typed 400
   * (`PUBLIC_SPACE_INVALID`).
   */
  @Get('associations')
  async listAssociations(
    @Query('type') type?: string,
    @Query('space') rawSpace?: unknown
  ): Promise<PublicAssociation[]> {
    const space = parsePublicSpaceParam(rawSpace, 'GET public/associations');
    const filter =
      type === 'association' || type === 'list' || type === 'institution' ? type : undefined;
    this.logger.debug(
      `public listAssociations type=${filter ?? 'all'} space=${space ? `${space.formation}:${space.campus}` : 'all'}`
    );
    const rows = await this.associations.list(filter);
    if (!space) return rows.map(toPublic);
    const offered = await this.associations.offeredInSpace(space);
    return rows.filter((a) => offered.has(a.id)).map(toPublic);
  }

  /**
   * One association/list by slug, with its public members.
   *
   * With `?space=`, an entity of any type (archived or not) whose audience does not reach the space
   * answers 404, the same as an unknown slug: the showcase of a space must not render another
   * space's association, list or institution by URL. Without it, every association answers - Canari's own pages read it.
   */
  @Get('associations/slug/:slug')
  async getBySlug(@Param('slug') slug: string, @Query('space') rawSpace?: unknown) {
    const space = parsePublicSpaceParam(rawSpace, 'GET public/associations/slug');
    this.logger.debug(`public getBySlug ${slug}`);
    const a = await this.associations.findBySlug(slug);
    if (space && !(await this.associations.offeredInSpace(space)).has(a.id)) {
      this.logger.debug(
        `public getBySlug ${slug}: not offered by ${space.formation}:${space.campus} - 404`
      );
      throw new NotFoundException('Association not found');
    }
    const members = await this.associations.listMembersPublic(a.id);
    return { ...toPublic(a), members };
  }

  /** Public members of an association/list by id. */
  @Get('associations/:id/members')
  async listMembers(@Param('id') id: string) {
    this.logger.debug(`public listMembers ${id}`);
    return this.associations.listMembersPublic(id);
  }

  /**
   * The photo of one row of a public roster - the `avatarUrl` every public member carries.
   *
   * WHY A ROSTER ROW AND NOT AN ACCOUNT: the showcase draws each member's photo, and an account id
   * names the person to any system that keys on it. Keyed by the row, the photo stays exactly as
   * public as the roster that lists it - a member who leaves the association takes their row, and
   * so their photo, with them.
   *
   * Relayed from core-service's avatar route over the Docker network: the image (or a 304) with
   * its ETag and caching, a bodyless 404 for no photo, a bodyless 502 `no-store` for an upstream
   * that did not answer. EVERY ANSWER IS BODYLESS EXCEPT THE IMAGE - an `<img>` handed a JSON body
   * logs three console lines for one miss (core's `getAvatar` says why).
   *
   * NO THROTTLE, ON PURPOSE, AND THE SPEC PINS IT. The showcase hands `avatarUrl` to the visitor's
   * browser, so one visitor's page asks for every face it draws: a carte or a roster is a hundred
   * faces and more, and each revalidation (a 304) is another request. The default bucket (20 a
   * minute per address, per replica) would turn one carte render into initials. What a request
   * costs is a uuid check, a primary-key read and one internal hop; core's avatar cache, keyed by
   * account, bounds what reaches the photo provider; and the comparable public routes (core's own
   * avatar route, `/api/media/public/:id`) carry no throttle either.
   */
  @Get('members/:memberId/avatar')
  async getMemberAvatar(
    @Param('memberId') memberId: string,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response
  ): Promise<void> {
    const userId = await this.associations.publicMemberUserId(memberId);
    if (!userId) {
      answerNoPhoto(res);
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), MEMBER_AVATAR_TIMEOUT_MS);
    try {
      // The shared internal secret, as every server-to-server call to core carries it - and none
      // at all when it is unset, never an empty header (`internalCoreRequestConfig`).
      const headers: Record<string, string> = { ...internalCoreRequestConfig().headers };
      if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
      const upstream = await fetch(coreUrl(`users/${encodeURIComponent(userId)}/avatar`), {
        headers,
        signal: abort.signal,
      });
      if (upstream.status === 404) {
        // The same answer as a row on no public roster: from outside, "nobody" and "no photo" are
        // one fact, and must not be told apart by a header.
        answerNoPhoto(res);
        return;
      }
      for (const name of ['content-type', 'cache-control', 'etag']) {
        const value = upstream.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      if (upstream.status === 304) {
        res.status(304).end();
        return;
      }
      if (upstream.status !== 200) {
        // Neither a photo, an unchanged photo nor no photo: core refused or failed, and that is
        // somebody's fault, said where an operator reads it.
        this.logger.warn(
          `[PUBLIC_AVATAR] core refused ${upstream.status} for row ${memberId.slice(0, 8)}`
        );
        res.status(upstream.status).end();
        return;
      }
      const body = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Length', body.length);
      res.status(200).send(body);
    } catch (err) {
      this.logger.warn(
        `[PUBLIC_AVATAR] core-service did not answer for ${memberId.slice(0, 8)}: ${(err as Error)?.message}`
      );
      res.set({ 'Cache-Control': 'no-store' });
      res.status(502).end();
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Link previews for shared posts ───────────────────────────────────────
  //
  // THREE ROUTES, ONE PREDICATE, AND NONE OF THEM IS A SECOND FEED. `PostPreviewService` decides
  // what an association post may show to somebody with no session; these only serve what it
  // returns. A post it refuses is a 404 here, identical to a post that does not exist - the
  // refusal must not be readable, or a guessed id becomes a way to ask whether a hidden post
  // exists. See that service for why the authenticated `/api/posts/:id` cannot answer this.

  /**
   * Title, text, author and image dimensions behind a shared post link.
   *
   * Cached briefly at the edge: one link pasted into a conversation produces a burst of unfurler
   * hits on this exact path within seconds, and five minutes is short enough that an edited post
   * does not keep previewing its old text for long.
   */
  @Get('posts/:postId/preview')
  @Header('Cache-Control', 'public, max-age=300')
  async getPostPreview(@Param('postId') postId: string): Promise<PostSharePreview> {
    const preview = await this.postPreviews.getSharePreview(postId);
    if (!preview) throw new NotFoundException('Post not found');
    this.logger.debug(`public post preview ${postId}`);
    return preview;
  }

  /**
   * The post's card - its first image cropped, else its association's logo, always 1200x630 JPEG -
   * as `og:image` points at it.
   *
   * `@Res()` rather than a returned buffer because Nest would otherwise serialise the Buffer as JSON.
   * `Cache-Control: max-age=3600` lets an unfurler and a browser keep it, but NOTHING SHARED SITS IN
   * FRONT OF THIS ROUTE (canari.emse.fr has no CDN), so the service remembers the rendered card
   * itself: a bounded LRU keyed by post, `updatedAt` and logo, one render per burst
   * ({@link PostPreviewService.readShareableImage}).
   *
   * THE ONE THROTTLED PREVIEW ROUTE, because it is the only one that does work: a blob fetch from
   * media-service, an AES-GCM decrypt of up to 5 MB and a JPEG encode, for a caller with no session.
   * The throttle (20/min per IP) sits far above one unfurler's real use and bounds what a
   * cache-busting query string can make this service do - the card cache is keyed on the post, not
   * the URL, so a query string cannot defeat it. The JSON preview beside it is a database read and
   * stays unthrottled, where a burst of unfurlers is exactly what is expected.
   */
  @UseGuards(ClientIpThrottlerGuard)
  @Get('posts/:postId/preview-image')
  async getPostPreviewImage(@Param('postId') postId: string, @Res() res: Response): Promise<void> {
    const image = await this.postPreviews.readShareableImage(postId);
    if (!image) throw new NotFoundException('Post image not found');
    this.logger.debug(`public post preview image ${postId} (${image.data.length} bytes)`);
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Content-Length', image.data.length);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(image.data);
  }

  /**
   * The live "Carte de la Vie Asso" of ONE space, rendered interactively by the portail-etu showcase.
   *
   * `?space=<formation>:<campus>` names the space (`ICM:saint-etienne`): each space has at most one
   * live map since migration 147, and the showcase names its own space in its configuration - Canari
   * knows nothing of which school a showcase belongs to. 404 when that space has no live map; the
   * showcase then simply omits the map. A value naming no possible space is a typed 400
   * (`PUBLIC_SPACE_INVALID`).
   *
   * [LEGACY] With no `space`, a showcase deployed before it sent one still gets the map while EXACTLY
   * ONE map is live anywhere, logged at WARN; otherwise a typed 400 (`CARTE_PUBLIC_SPACE_REQUIRED`)
   * rather than a guess (docs/wiki/legacy-compatibility.md).
   *
   * Returns placement only - each bubble carries an `assoId` the consumer joins against
   * {@link listAssociations}, so a rename or a new logo shows up with no republish.
   *
   * Cached briefly: the payload can embed a background image, and a published map changes at most
   * a few times a year, so a short shared cache keeps the showcase cheap without making an
   * unpublish take noticeably long to appear. The query string is part of the cache key.
   */
  @Get('carte')
  @Header('Cache-Control', 'public, max-age=300')
  async getPublishedCarte(@Query('space') rawSpace?: unknown): Promise<PublicCarteResponse> {
    const space = parsePublicSpaceParam(rawSpace, 'GET public/carte');
    this.logger.debug(
      `public getPublishedCarte ${space ? `${space.formation}:${space.campus}` : '(no space)'}`
    );
    let carte: PublishedCarteResponse | null;
    if (space) {
      carte = await this.poster.getPublished(space);
      if (!carte) throw new NotFoundException('No published carte for this space');
    } else {
      carte = await this.poster.getSoleLegacyPublished();
      if (!carte) {
        throw new BadRequestException({
          code: CARTE_ERROR.PUBLIC_SPACE_REQUIRED,
          message: 'space is required: name it as <formation>:<campus>, e.g. ICM:saint-etienne',
        });
      }
    }
    // Each card's photo by its roster row, the address the public roster hands out. The card's
    // `userId` is served beside it: the showcase keys its card list on that field.
    const avatars = await this.associations.publicAvatarUrlsFor(
      carte.units.flatMap((u) =>
        u.cards.map((c) => ({ associationId: u.assoId, userId: c.userId }))
      )
    );
    return {
      ...carte,
      units: carte.units.map((u) => ({
        ...u,
        cards: u.cards.map((c) => ({
          ...c,
          avatarUrl: avatars.get(`${u.assoId}:${c.userId}`) ?? null,
        })),
      })),
    };
  }

  /**
   * Inbound Cercle -> Canari cotisant-status check (WP-COT-4). Cercle is the source of truth for
   * a user's balance; Canari is the source of truth for cotisant status, so Cercle queries this
   * live on every request rather than caching. `sub` is the caller's OIDC subject, which IS the
   * Canari userId (`findOrCreateFromOidc` uses `userinfo.sub` as the primary key), so no id-mapping
   * table is needed. Service-to-service only: gated on `X-Api-Key` matched against `CERCLE_API_KEY`
   * (this controller's other routes are intentionally unauthenticated - this one is not) and
   * throttled to guard against API-key brute-forcing.
   */
  @UseGuards(ClientIpThrottlerGuard)
  @Get('cotisant-status')
  async getCotisantStatus(
    @Query('assoSlug') assoSlug: string,
    @Query('sub') sub: string,
    @Headers('x-api-key') apiKey: string
  ) {
    this.assertCercleApiKey(apiKey);
    // Security: mitigates CodeQL alert #2478 — query params may arrive as arrays, bypassing sanitization
    if (Array.isArray(assoSlug)) {
      assoSlug = assoSlug[0];
    }
    if (Array.isArray(sub)) {
      sub = sub[0];
    }
    if (!assoSlug || !sub) {
      throw new BadRequestException('assoSlug and sub are required');
    }
    this.logger.debug(`[CERCLE] cotisant-status assoSlug=${assoSlug} sub=${sub.slice(0, 8)}`);
    return this.products.getCotisantStatusBySlug(assoSlug, sub);
  }
}
