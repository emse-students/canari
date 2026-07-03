import { Controller, Get, Param, Query, Logger } from '@nestjs/common';
import { AssociationsService } from '../associations/associations.service';
import { Association } from '../associations/entities/association.entity';

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
  archived: boolean;
  isBDE: boolean;
  contactEmail: string | null;
  memberCount: number;
}

/** Maps a full association entity to the safe public subset. */
function toPublic(a: Association & { memberCount?: number }): PublicAssociation {
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

  constructor(private readonly associations: AssociationsService) {}

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
}
