import {
  Controller,
  Get,
  Param,
  Query,
  Headers,
  Logger,
  ForbiddenException,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import * as crypto from 'crypto';
import { AssociationsService } from '../associations/associations.service';
import { Association } from '../associations/entities/association.entity';
import { ProductsService } from '../associations/products.service';

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
 * Unauthenticated read-only API consumed by the portail-etu showcase.
 * Reachable via the nginx `/api/public/` location, which - unlike every other
 * `/api/*` route - is NOT behind `auth_request`. Exposes associations, promo
 * lists and their public members; never any write.
 */
@Controller('public')
export class PublicController {
  private readonly logger = new Logger(PublicController.name);
  private readonly cercleApiKey = process.env.CERCLE_API_KEY ?? '';

  constructor(
    private readonly associations: AssociationsService,
    private readonly products: ProductsService
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
    if (!assoSlug || !sub) {
      throw new BadRequestException('assoSlug and sub are required');
    }
    this.logger.debug(`[CERCLE] cotisant-status assoSlug=${assoSlug} sub=${sub.slice(0, 8)}`);
    return this.products.getCotisantStatusBySlug(assoSlug, sub);
  }
}
