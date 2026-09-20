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
import { ThrottlerGuard } from '@nestjs/throttler';
import * as crypto from 'crypto';
import type { Response } from 'express';
import { AssociationsService } from '../associations/associations.service';
import { Association } from '../associations/entities/association.entity';
import { ProductsService } from '../associations/products.service';
import { PosterService, type PublishedCarteResponse } from '../associations/poster.service';
import { PostPreviewService, type PostSharePreview } from '../posts/post-preview.service';

/**
 * Public projection of an association/list for the read-only showcase.
 * Deliberately omits every sensitive column (document vault key, encrypted
 * notes, Stripe account id, quotas, createdBy) - only fields safe for an
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
  type: 'association' | 'list';
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

/**
 * Ceiling on the shareable-post list, whatever `?limit=` asks for.
 *
 * Its one consumer is the sitemap, which caps itself at the same number
 * (`frontend/src/lib/seo/sitemap.ts`); this one exists so an anonymous caller cannot ask for the
 * whole table by widening a query parameter.
 */
const MAX_PUBLIC_POST_LIST = 500;

/**
 * Unauthenticated read-only API consumed by the portail-etu showcase, and since 2026-09-20 by the
 * link previews of shared Canari URLs.
 * Reachable via the nginx `/api/public/` location, which - unlike every other
 * `/api/*` route - is NOT behind `auth_request`. Exposes associations, promo
 * lists, their public members and association-post previews; never any write.
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

  /** Lists associations and/or lists. `?type=association|list` restricts; omit for both. */
  @Get('associations')
  async listAssociations(@Query('type') type?: string): Promise<PublicAssociation[]> {
    const filter = type === 'association' || type === 'list' ? type : undefined;
    this.logger.debug(`public listAssociations type=${filter ?? 'all'}`);
    const rows = await this.associations.list(filter);
    return rows.map(toPublic);
  }

  /** One association/list by slug, with its public members. */
  @Get('associations/slug/:slug')
  async getBySlug(@Param('slug') slug: string) {
    this.logger.debug(`public getBySlug ${slug}`);
    const a = await this.associations.findBySlug(slug);
    const members = await this.associations.listMembersPublic(a.id);
    return { ...toPublic(a), members };
  }

  /** Public members of an association/list by id. */
  @Get('associations/:id/members')
  async listMembers(@Param('id') id: string) {
    this.logger.debug(`public listMembers ${id}`);
    return this.associations.listMembersPublic(id);
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
   * The post's first image, decrypted, as `og:image` points at it.
   *
   * `@Res()` rather than a returned buffer because the content type is the stored one and Nest
   * would otherwise serialise the Buffer as JSON. Cached for an hour: unfurlers refetch this far
   * more often than they refetch the head, and the bytes only change if the post is edited.
   *
   * THE ONE THROTTLED PREVIEW ROUTE, because it is the only one that does work: a blob fetch from
   * media-service and an AES-GCM decrypt of up to 5 MB, for a caller with no session. The edge
   * cache absorbs the legitimate shape of this traffic - an unfurler fetches one `og:image` per
   * URL and remembers it for weeks - so 20/min per IP sits far above real use and still bounds
   * what a cache-busting query string can make this service do. The JSON preview beside it is a
   * database read and stays unthrottled, where a burst of unfurlers is exactly what is expected.
   */
  @UseGuards(ThrottlerGuard)
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
   * Recent shareable post ids, newest first - read by the sitemap builder and nothing else.
   *
   * It exists because `/api/posts?feed=associations` moved behind the feed gate on 2026-09-10 and
   * the sitemap has been answering `0 posts` to every crawler ever since, silently: the builder
   * treats an empty list as a short sitemap rather than a failure, by design.
   */
  @Get('posts')
  @Header('Cache-Control', 'public, max-age=300')
  async listShareablePosts(@Query('limit') limit?: string) {
    const parsed = Number.parseInt(limit ?? '', 10);
    const capped = Number.isFinite(parsed)
      ? Math.min(Math.max(parsed, 1), MAX_PUBLIC_POST_LIST)
      : MAX_PUBLIC_POST_LIST;
    const rows = await this.postPreviews.listShareable(capped);
    this.logger.debug(`public shareable posts: ${rows.length}`);
    return rows;
  }

  /**
   * The live "Carte de la Vie Asso", rendered interactively by the portail-etu showcase.
   *
   * Returns placement only - each bubble carries an `assoId` the consumer joins against
   * {@link listAssociations}, so a rename or a new logo shows up with no republish. 404 when no
   * poster is currently published; the showcase then simply omits the map.
   *
   * Cached briefly: the payload can embed a background image, and a published map changes at most
   * a few times a year, so a short shared cache keeps the showcase cheap without making an
   * unpublish take noticeably long to appear.
   */
  @Get('carte')
  @Header('Cache-Control', 'public, max-age=300')
  async getPublishedCarte(): Promise<PublishedCarteResponse> {
    this.logger.debug('public getPublishedCarte');
    const carte = await this.poster.getPublished();
    if (!carte) throw new NotFoundException('No published carte');
    return carte;
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
  @UseGuards(ThrottlerGuard)
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
