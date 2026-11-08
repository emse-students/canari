import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository, type EntityManager } from 'typeorm';
import { PosterProject } from './entities/poster-project.entity';
import { PosterZone } from './entities/poster-zone.entity';
import { PosterEntry } from './entities/poster-entry.entity';
import { AssociationPermissionFlag } from './entities/association-member.entity';
import { CreatePosterProjectDto, PosterEntryDto, UpdatePosterProjectDto } from './dto/poster.dto';
import { sanitizePublishedCarte, type PublishedCarte } from './published-carte';
import {
  ALL_CARTE_SPACES_SQL,
  CARTE_ERROR,
  CARTE_SPACE_ASSOCIATIONS_SQL,
  MANAGED_CARTE_SPACES_SQL,
  type CarteCaller,
  type CarteSpaceKey,
} from './poster-scope';

/** The published map plus the metadata the showcase displays alongside it. */
export interface PublishedCarteResponse extends PublishedCarte {
  /** Author-chosen project name, e.g. "Carte 2026". */
  name: string;
  /** ISO timestamp of the last publish. */
  publishedAt: string;
}

/** A space a caller may draw maps for. */
export interface CarteSpace {
  id: string;
  formation: string;
  campus: string;
}

/**
 * Everything the editor needs about one map besides the live association data it already reads:
 * the project, its space, its zones, the switch of every association it has seen, and which
 * associations its space offers today. An id in `spaceAssociationIds` with no entry is NEW.
 */
export interface PosterProjectDetail extends PosterProject {
  space: CarteSpace | null;
  zones: PosterZone[];
  entries: PosterEntry[];
  spaceAssociationIds: string[];
}

/** The map that a publish refused, and why, for the log line that accuses it. */
type PublishRefusal = { code: string; message: string; detail: string };

/**
 * The "Carte de la Vie Asso" editor's store: layouts, their space, their zones and their switches,
 * and the one live map per space the showcase reads.
 *
 * EVERY READ AND WRITE IS SCOPED TO THE CALLER (owner, 2026-11-08): a map belongs to one space, and
 * only the managers of the BDE governing that space - or the platform admin - see it at all
 * (`poster-scope.ts`). The controller's guard is the DOOR (someone who manages some BDE); this
 * service is the reach, and an unmanaged map is a 404 here, never a 403.
 */
@Injectable()
export class PosterService {
  private readonly logger = new Logger(PosterService.name);

  constructor(
    @InjectRepository(PosterProject)
    private readonly posterRepo: Repository<PosterProject>,
    @InjectRepository(PosterZone)
    private readonly zoneRepo: Repository<PosterZone>,
    @InjectRepository(PosterEntry)
    private readonly entryRepo: Repository<PosterEntry>
  ) {}

  // ── Scope ──────────────────────────────────────────────────────────────────

  /**
   * The spaces `caller` draws maps for: every space for the platform admin, else the spaces
   * governed by an association in which they hold MANAGE_ASSO. Feeds the creation form's picker.
   */
  async listSpaces(caller: CarteCaller): Promise<CarteSpace[]> {
    const rows: CarteSpace[] = caller.isGlobalAdmin
      ? await this.posterRepo.manager.query(ALL_CARTE_SPACES_SQL)
      : await this.posterRepo.manager.query(MANAGED_CARTE_SPACES_SQL, [
          caller.userId,
          AssociationPermissionFlag.MANAGE_ASSO,
        ]);
    this.logger.debug(
      `[CARTE] spaces for ${caller.userId.slice(0, 8)}: ${rows.length}${caller.isGlobalAdmin ? ' (platform admin)' : ''}`
    );
    return rows;
  }

  /** The ids of {@link listSpaces}, or null for the platform admin, who is bounded by nothing. */
  private async managedSpaceIds(caller: CarteCaller): Promise<Set<string> | null> {
    if (caller.isGlobalAdmin) return null;
    return new Set((await this.listSpaces(caller)).map((s) => s.id));
  }

  /**
   * Loads one map the caller may touch.
   *
   * @throws NotFoundException when it does not exist, OR when it belongs to a space the caller does
   *   not manage, OR has no space and the caller is not the platform admin - the three are one
   *   answer, so a manager cannot learn that another BDE's map exists.
   */
  async get(id: string, caller: CarteCaller): Promise<PosterProject> {
    this.logger.debug(`get poster project ${id}`);
    const project = await this.posterRepo.findOne({ where: { id } });
    if (!project) throw new NotFoundException('Poster project not found');
    const managed = await this.managedSpaceIds(caller);
    if (managed && (project.spaceId === null || !managed.has(project.spaceId))) {
      this.logger.warn(
        `[CARTE] ${caller.userId.slice(0, 8)} asked for map ${id} of a space it does not manage - answered 404`
      );
      throw new NotFoundException('Poster project not found');
    }
    return project;
  }

  /** The ids of the associations a map of `spaceId` offers today (`CARTE_SPACE_ASSOCIATIONS_SQL`). */
  private async spaceAssociationIds(
    spaceId: string,
    manager: EntityManager = this.posterRepo.manager
  ): Promise<string[]> {
    const rows: { id: string }[] = await manager.query(CARTE_SPACE_ASSOCIATIONS_SQL, [spaceId]);
    return rows.map((r) => r.id);
  }

  // ── Projects ───────────────────────────────────────────────────────────────

  /**
   * The maps the caller may touch, most-recently-updated first. `publication` is left out: it can
   * carry a multi-megabyte background data URL, which the list page never renders.
   */
  async list(caller: CarteCaller): Promise<PosterProject[]> {
    const managed = await this.managedSpaceIds(caller);
    this.logger.debug(`list poster projects (${managed ? `${managed.size} spaces` : 'all'})`);
    if (managed && managed.size === 0) return [];
    return this.posterRepo.find({
      select: {
        id: true,
        name: true,
        layout: true,
        spaceId: true,
        publishedAt: true,
        publicationFingerprint: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
      },
      where: managed ? { spaceId: In([...managed]) } : undefined,
      order: { updatedAt: 'DESC' },
    });
  }

  /** One map with its space, zones, switches and the associations its space offers. */
  async detail(id: string, caller: CarteCaller): Promise<PosterProjectDetail> {
    const project = await this.get(id, caller);
    const [zones, entries, spaces, spaceAssociationIds] = await Promise.all([
      this.zoneRepo.find({
        where: { posterProjectId: id },
        order: { sortOrder: 'ASC', label: 'ASC' },
      }),
      this.entryRepo.find({ where: { posterProjectId: id } }),
      this.posterRepo.manager.query(ALL_CARTE_SPACES_SQL) as Promise<CarteSpace[]>,
      project.spaceId ? this.spaceAssociationIds(project.spaceId) : Promise.resolve([]),
    ]);
    const space = spaces.find((s) => s.id === project.spaceId) ?? null;
    const seen = new Set(entries.map((e) => e.associationId));
    const fresh = spaceAssociationIds.filter((a) => !seen.has(a)).length;
    this.logger.debug(
      `[CARTE] detail ${id}: ${zones.length} zones, ${entries.length} entries, ${spaceAssociationIds.length} of the space, ${fresh} new`
    );
    return { ...project, space, zones, entries, spaceAssociationIds };
  }

  /**
   * Creates a map for one space the caller manages, with every association of that space switched
   * ON: what the space holds at creation is what the author starts from. Only an association that
   * arrives LATER is offered switched off ("Nouvelle").
   *
   * @throws NotFoundException when the space is unknown or not one the caller manages.
   */
  async create(dto: CreatePosterProjectDto, caller: CarteCaller): Promise<PosterProject> {
    this.logger.debug(`create poster project by ${caller.userId.slice(0, 8)} in ${dto.spaceId}`);
    const spaces = await this.listSpaces(caller);
    if (!spaces.some((s) => s.id === dto.spaceId)) {
      this.logger.warn(
        `[CARTE] ${caller.userId.slice(0, 8)} tried to create a map in space ${dto.spaceId}, which it does not manage - answered 404`
      );
      throw new NotFoundException('Space not found');
    }
    return this.posterRepo.manager.transaction(async (manager) => {
      const project = await manager.getRepository(PosterProject).save(
        manager.getRepository(PosterProject).create({
          name: dto.name,
          layout: dto.layout ?? {},
          spaceId: dto.spaceId,
          createdBy: caller.userId,
        })
      );
      const ids = await this.spaceAssociationIds(dto.spaceId, manager);
      await this.seedEntries(manager, project.id, ids, () => true);
      this.logger.debug(`[CARTE] map ${project.id} created with ${ids.length} associations on`);
      return project;
    });
  }

  /**
   * Writes a switch for every association of `ids` the map has no row for, ON when `enabled` says
   * so. Rows already present are the author's choice and are never touched.
   */
  private async seedEntries(
    manager: EntityManager,
    projectId: string,
    ids: string[],
    enabled: (associationId: string) => boolean
  ): Promise<void> {
    if (ids.length === 0) return;
    await manager
      .createQueryBuilder()
      .insert()
      .into(PosterEntry)
      .values(
        ids.map((associationId) => ({
          posterProjectId: projectId,
          associationId,
          enabled: enabled(associationId),
          zoneId: null,
        }))
      )
      .orIgnore()
      .execute();
  }

  /**
   * Renames a map, replaces its layout, or attaches a map that has no space.
   *
   * ATTACHING seeds the switches the way migration 147 seeded every attached map: an association of
   * the space the saved layout placed is ON, and one it never placed gets no row, so it is offered
   * as new - a map left unattached by the migration comes back as it was, minus what is not of its
   * new space.
   *
   * @throws ConflictException `CARTE_ALREADY_ATTACHED` when the map already belongs to a space and
   *   another one is named: a map never moves between spaces.
   * @throws NotFoundException when the space is unknown or not one the caller manages.
   */
  async update(
    id: string,
    dto: UpdatePosterProjectDto,
    caller: CarteCaller
  ): Promise<PosterProject> {
    this.logger.debug(`update poster project ${id}`);
    const project = await this.get(id, caller);
    if (dto.spaceId !== undefined && dto.spaceId !== project.spaceId) {
      if (project.spaceId !== null) {
        this.logger.warn(`[CARTE] map ${id} asked to move from ${project.spaceId} - refused`);
        throw new ConflictException({
          code: CARTE_ERROR.ALREADY_ATTACHED,
          message: 'This map already belongs to a space; a map never moves between spaces.',
        });
      }
      const spaces = await this.listSpaces(caller);
      if (!spaces.some((s) => s.id === dto.spaceId)) {
        this.logger.warn(`[CARTE] map ${id} asked to attach to unmanaged space ${dto.spaceId}`);
        throw new NotFoundException('Space not found');
      }
    }
    return this.posterRepo.manager.transaction(async (manager) => {
      if (dto.name !== undefined) project.name = dto.name;
      if (dto.layout !== undefined) project.layout = dto.layout;
      const attaching = dto.spaceId !== undefined && project.spaceId === null;
      if (attaching) project.spaceId = dto.spaceId as string;
      const saved = await manager.getRepository(PosterProject).save(project);
      if (attaching) {
        const placed = layoutAssociationIds(saved.layout);
        const offered = await this.spaceAssociationIds(saved.spaceId as string, manager);
        const on = offered.filter((a) => placed.has(a));
        await this.seedEntries(manager, id, on, () => true);
        this.logger.log(
          `[CARTE] map ${id} attached to space ${saved.spaceId}: ${offered.length} associations, ${on.length} on, ${offered.length - on.length} new`
        );
      }
      return saved;
    });
  }

  /** Permanently deletes a map, its zones and its switches (foreign keys cascade). */
  async remove(id: string, caller: CarteCaller): Promise<{ ok: boolean }> {
    this.logger.debug(`remove poster project ${id}`);
    await this.get(id, caller);
    await this.posterRepo.manager.transaction(async (manager) => {
      // Explicit, so a schema built by `synchronize` (no foreign keys) ends in the same state.
      await manager.getRepository(PosterEntry).delete({ posterProjectId: id });
      await manager.getRepository(PosterZone).delete({ posterProjectId: id });
      await manager.getRepository(PosterProject).delete(id);
    });
    return { ok: true };
  }

  // ── Zones ──────────────────────────────────────────────────────────────────

  /** Adds a zone at the end of the map's list. */
  async createZone(id: string, label: string, caller: CarteCaller): Promise<PosterZone> {
    await this.get(id, caller);
    const last = await this.zoneRepo.findOne({
      where: { posterProjectId: id },
      order: { sortOrder: 'DESC' },
    });
    const zone = await this.zoneRepo.save(
      this.zoneRepo.create({
        posterProjectId: id,
        label: label.trim(),
        sortOrder: (last?.sortOrder ?? -1) + 1,
      })
    );
    this.logger.debug(`[CARTE] zone ${zone.id} added to map ${id}`);
    return zone;
  }

  /**
   * One zone of THIS map.
   *
   * @throws NotFoundException when the zone is not one of the map's - a zone id read off another
   *   map is as unknown here as one that never existed.
   */
  private async zoneOf(id: string, zoneId: string): Promise<PosterZone> {
    const zone = await this.zoneRepo.findOne({ where: { id: zoneId, posterProjectId: id } });
    if (!zone) throw new NotFoundException('Zone not found');
    return zone;
  }

  /** Renames a zone of the map. */
  async renameZone(
    id: string,
    zoneId: string,
    label: string,
    caller: CarteCaller
  ): Promise<PosterZone> {
    await this.get(id, caller);
    const zone = await this.zoneOf(id, zoneId);
    zone.label = label.trim();
    this.logger.debug(`[CARTE] zone ${zoneId} of map ${id} renamed`);
    return this.zoneRepo.save(zone);
  }

  /** Deletes a zone; its associations stay on the map, unzoned. */
  async deleteZone(id: string, zoneId: string, caller: CarteCaller): Promise<{ ok: boolean }> {
    await this.get(id, caller);
    await this.zoneOf(id, zoneId);
    await this.posterRepo.manager.transaction(async (manager) => {
      // Explicit rather than left to `ON DELETE SET NULL`, for a `synchronize` schema (no FK).
      await manager
        .getRepository(PosterEntry)
        .update({ posterProjectId: id, zoneId }, { zoneId: null });
      await manager.getRepository(PosterZone).delete({ id: zoneId, posterProjectId: id });
    });
    this.logger.debug(`[CARTE] zone ${zoneId} of map ${id} deleted`);
    return { ok: true };
  }

  /**
   * Persists the order of the map's zones, top to bottom.
   *
   * @throws BadRequestException `CARTE_ZONE_ORDER_INCOMPLETE` unless `orderedIds` names every zone of
   *   the map exactly once - a partial order would leave two zones on the same rank.
   */
  async reorderZones(id: string, orderedIds: string[], caller: CarteCaller): Promise<PosterZone[]> {
    await this.get(id, caller);
    const zones = await this.zoneRepo.find({ where: { posterProjectId: id } });
    const known = new Set(zones.map((z) => z.id));
    const named = new Set(orderedIds);
    if (
      named.size !== orderedIds.length ||
      named.size !== known.size ||
      orderedIds.some((z) => !known.has(z))
    ) {
      this.logger.warn(
        `[CARTE] reorder of map ${id} refused: ${orderedIds.length} ids for ${known.size} zones`
      );
      throw new BadRequestException({
        code: CARTE_ERROR.ZONE_ORDER_INCOMPLETE,
        message: 'orderedIds must name every zone of this map exactly once',
      });
    }
    await this.posterRepo.manager.transaction(async (manager) => {
      for (const [index, zoneId] of orderedIds.entries()) {
        await manager.getRepository(PosterZone).update({ id: zoneId }, { sortOrder: index });
      }
    });
    this.logger.debug(`[CARTE] zones of map ${id} reordered (${orderedIds.length})`);
    return this.zoneRepo.find({ where: { posterProjectId: id }, order: { sortOrder: 'ASC' } });
  }

  // ── Switches ───────────────────────────────────────────────────────────────

  /**
   * Writes the switch and/or zone of associations on the map. A missing row is created (a new
   * association becomes "seen": switched as asked, off by default); a present one changes only the
   * fields given.
   *
   * @throws ConflictException `CARTE_NOT_ATTACHED` on a map with no space: there is nothing to offer.
   * @throws BadRequestException `CARTE_ASSOCIATION_OUTSIDE_SPACE` for an association the map's space
   *   does not offer, `CARTE_ZONE_UNKNOWN` for a zone that is not the map's.
   */
  async setEntries(
    id: string,
    entries: PosterEntryDto[],
    caller: CarteCaller
  ): Promise<PosterEntry[]> {
    const project = await this.get(id, caller);
    if (project.spaceId === null) {
      throw new ConflictException({
        code: CARTE_ERROR.NOT_ATTACHED,
        message: 'Attach this map to a space before choosing its associations.',
      });
    }
    const offered = new Set(await this.spaceAssociationIds(project.spaceId));
    const outside = entries.filter((e) => !offered.has(e.associationId));
    if (outside.length > 0) {
      this.logger.warn(
        `[CARTE] switches of map ${id} refused: ${outside.length} association(s) not of space ${project.spaceId}`
      );
      throw new BadRequestException({
        code: CARTE_ERROR.ASSOCIATION_OUTSIDE_SPACE,
        message: "An association named here is not one of this map's space.",
      });
    }
    const zoneIds = new Set(
      (await this.zoneRepo.find({ where: { posterProjectId: id } })).map((z) => z.id)
    );
    if (entries.some((e) => typeof e.zoneId === 'string' && !zoneIds.has(e.zoneId))) {
      this.logger.warn(`[CARTE] switches of map ${id} refused: a zone that is not the map's`);
      throw new BadRequestException({
        code: CARTE_ERROR.ZONE_UNKNOWN,
        message: "A zone named here is not one of this map's zones.",
      });
    }
    return this.posterRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(PosterEntry);
      const existing = new Map(
        (
          await repo.find({
            where: { posterProjectId: id, associationId: In(entries.map((e) => e.associationId)) },
          })
        ).map((row) => [row.associationId, row])
      );
      const rows = entries.map((e) => {
        const row =
          existing.get(e.associationId) ??
          repo.create({
            posterProjectId: id,
            associationId: e.associationId,
            enabled: false,
            zoneId: null,
          });
        if (e.enabled !== undefined) row.enabled = e.enabled;
        if (e.zoneId !== undefined) row.zoneId = e.zoneId;
        return row;
      });
      const saved = await repo.save(rows);
      this.logger.debug(
        `[CARTE] map ${id}: ${saved.length} switch(es) written, ${entries.length - existing.size} newly seen`
      );
      return saved;
    });
  }

  // ── Publication ────────────────────────────────────────────────────────────

  /**
   * Reads the publish body: `{ carte, fingerprint }`, the only shape since `minClientVersion` 1.2.7.
   *
   * Every admitted build sends the wrapper with a SHA-256 hex fingerprint
   * (`fingerprintPublishedCarte`), so anything else - the bare document clients before 2026-09-28
   * posted, a wrapper with no fingerprint, or a malformed one - is a bug rather than an old build,
   * and is refused before anything is written: a stored junk value would later be COMPARED and
   * answer the staleness question wrongly.
   *
   * @throws BadRequestException when the body is not `{ carte, fingerprint }` with a fingerprint of
   *   64 lowercase hex characters.
   */
  private readPublishBody(body: unknown): { carte: unknown; fingerprint: string } {
    if (body === null || typeof body !== 'object' || !('carte' in body)) {
      this.logger.warn('publish refused: the body is not the { carte, fingerprint } wrapper');
      throw new BadRequestException('Publication body must be { carte, fingerprint }');
    }
    const wrapped = body as { carte: unknown; fingerprint?: unknown };
    const fp = wrapped.fingerprint;
    if (typeof fp !== 'string' || !/^[0-9a-f]{64}$/.test(fp)) {
      this.logger.warn(
        `publish refused: fingerprint ${fp === undefined ? 'absent' : 'malformed'} - every admitted client sends one`
      );
      throw new BadRequestException(
        'Publication body must be { carte, fingerprint } with a 64-character lowercase hex fingerprint'
      );
    }
    return { carte: wrapped.carte, fingerprint: fp };
  }

  /**
   * Whether every association a publication names - each unit AND each directory line - is one
   * this map SHOWS: switched on, and offered by its space today. The document is built by the
   * editor, so this is the server holding the rule rather than trusting the builder - a
   * switched-off association, or one of another space, never reaches the anonymous showcase through
   * this map, neither as a unit nor as a roster line.
   */
  private async refuseUnitsOutsideMap(
    project: PosterProject,
    publication: PublishedCarte
  ): Promise<PublishRefusal | null> {
    if (project.spaceId === null) {
      return {
        code: CARTE_ERROR.NOT_ATTACHED,
        message: 'Attach this map to a space before publishing it.',
        detail: 'no space',
      };
    }
    const offered = new Set(await this.spaceAssociationIds(project.spaceId));
    const on = new Set(
      (await this.entryRepo.find({ where: { posterProjectId: project.id, enabled: true } })).map(
        (e) => e.associationId
      )
    );
    const shown = (assoId: string) => offered.has(assoId) && on.has(assoId);
    const outside = publication.units.filter((u) => !shown(u.assoId));
    const lines = (publication.directory?.zones ?? []).flatMap((z) => z.assos);
    const outsideLines = lines.filter((a) => !shown(a.assoId));
    if (outside.length === 0 && outsideLines.length === 0) return null;
    return {
      code: CARTE_ERROR.UNIT_OUTSIDE_MAP,
      message: 'The published document names an association this map does not show.',
      detail: `${outside.length} of ${publication.units.length} units and ${outsideLines.length} of ${lines.length} directory lines off or outside the space`,
    };
  }

  /**
   * Publishes a map to the showcase, replacing the live map OF ITS SPACE only.
   *
   * The payload is validated field by field first ({@link sanitizePublishedCarte}) - it is about to
   * be served to anonymous visitors, so "the caller manages this map" is not enough - and every unit
   * must be an association the map shows ({@link refuseUnitsOutsideMap}). Unpublishing the space's
   * previous map and publishing this one happen in ONE transaction because the partial unique index
   * of migration 147 forbids two live rows for one space.
   *
   * @param id - Project to publish.
   * @param body - `{ carte, fingerprint }` (see {@link readPublishBody}).
   * @throws BadRequestException when the body is not that wrapper, the payload carries no placeable
   *   association, or a unit is not on the map (`CARTE_UNIT_OUTSIDE_MAP`).
   * @throws ConflictException `CARTE_NOT_ATTACHED` for a map with no space.
   */
  async publish(id: string, body: unknown, caller: CarteCaller): Promise<PosterProject> {
    this.logger.debug(`publish poster project ${id}`);
    const { carte, fingerprint } = this.readPublishBody(body);
    const publication = sanitizePublishedCarte(carte);
    if (!publication) {
      this.logger.warn(`publish rejected for ${id}: payload has no usable bubble`);
      throw new BadRequestException('Publication payload is empty or malformed');
    }
    const project = await this.get(id, caller);
    const refusal = await this.refuseUnitsOutsideMap(project, publication);
    if (refusal) {
      this.logger.warn(`[CARTE] publish of map ${id} refused: ${refusal.code} (${refusal.detail})`);
      const payload = { code: refusal.code, message: refusal.message };
      throw refusal.code === CARTE_ERROR.NOT_ATTACHED
        ? new ConflictException(payload)
        : new BadRequestException(payload);
    }
    const spaceId = project.spaceId as string;
    return this.posterRepo.manager.transaction(async (manager) => {
      // Two publishes in one space are SERIALISED on the space's row: without it both clear "the
      // previous live map" (none yet, or the same one) and the later insert hits the per-space
      // unique index - a 500. Under the lock the later publish sees the earlier one committed, clears
      // it, and wins: the last publish is the live one.
      await manager.query('SELECT 1 FROM spaces WHERE id = $1 FOR UPDATE', [spaceId]);
      const repo = manager.getRepository(PosterProject);
      // Clear the space's previous live map FIRST; the unique index allows one live row per space.
      // Its fingerprint goes with it: a row that is not live describes no published document.
      const replaced = await repo.update(
        { spaceId, publication: Not(IsNull()) },
        { publication: null, publishedAt: null, publicationFingerprint: null }
      );
      await repo.update(id, {
        publication: publication as unknown as Record<string, unknown>,
        publishedAt: new Date(),
        publicationFingerprint: fingerprint,
      });
      const saved = await repo.findOne({ where: { id } });
      if (!saved) throw new NotFoundException('Poster project not found');
      this.logger.log(
        `[CARTE] map ${id} live for space ${spaceId} (${publication.units.length} units, ${replaced.affected ?? 0} row(s) cleared)`
      );
      return saved;
    });
  }

  /** Takes a map offline. Idempotent: unpublishing an already-offline map is a no-op. */
  async unpublish(id: string, caller: CarteCaller): Promise<PosterProject> {
    this.logger.debug(`unpublish poster project ${id}`);
    const project = await this.get(id, caller);
    project.publication = null;
    project.publishedAt = null;
    project.publicationFingerprint = null;
    return this.posterRepo.save(project);
  }

  /** The response the showcase reads, from a live row. */
  private toPublished(project: PosterProject): PublishedCarteResponse {
    return {
      ...(project.publication as unknown as PublishedCarte),
      name: project.name,
      publishedAt: (project.publishedAt as Date).toISOString(),
    };
  }

  /**
   * The live map of one space, or null when that space has none. Read by the unauthenticated
   * `GET /api/public/carte?space=<formation>:<campus>` route the showcase polls.
   */
  async getPublished(space: CarteSpaceKey): Promise<PublishedCarteResponse | null> {
    const project = await this.posterRepo
      .createQueryBuilder('p')
      .innerJoin('spaces', 's', 's.id = p."spaceId"')
      .where('p.publication IS NOT NULL')
      .andWhere('s.formation = :formation AND s.campus = :campus', space)
      .getOne();
    if (!project?.publication || !project.publishedAt) {
      this.logger.debug(`getPublished: no map live for ${space.formation}:${space.campus}`);
      return null;
    }
    this.logger.debug(`getPublished: serving ${project.id} for ${space.formation}:${space.campus}`);
    return this.toPublished(project);
  }

  /**
   * [LEGACY] The live map for a showcase that names no space - a portail-etu deployed before it
   * sent `?space=` (docs/wiki/legacy-compatibility.md). Answered only while EXACTLY ONE map is live
   * across every space, which is the only case where "the" map still means one thing.
   *
   * Every hit is logged at WARN, the refused ones included: the line ACCUSES the caller of not naming
   * its space, whatever the answer, and the shim's removal condition is a week of its silence - a
   * refused hit left unlogged would make an old showcase invisible exactly when it is losing its
   * map. Only the ids are read to count; the one document is loaded only when it is served.
   *
   * @returns The single live map, or null when zero or several are live - the caller answers that
   *   with a typed 400 rather than picking one.
   */
  async getSoleLegacyPublished(): Promise<PublishedCarteResponse | null> {
    const live = await this.posterRepo.find({
      select: { id: true },
      where: { publication: Not(IsNull()) },
      take: 2,
    });
    const sole =
      live.length === 1 ? await this.posterRepo.findOne({ where: { id: live[0].id } }) : null;
    if (!sole?.publication || !sole.publishedAt) {
      this.logger.warn(
        `[LEGACY] GET public/carte with no space while ${live.length === 2 ? 'several maps are' : 'no map is'} live - refused`
      );
      return null;
    }
    this.logger.warn(
      `[LEGACY] GET public/carte with no space - served the only live map ${sole.id}; the showcase should send ?space=`
    );
    return this.toPublished(sole);
  }
}

/** The association ids a saved layout placed (`layout.bubbles[].assoId`), read defensively. */
export function layoutAssociationIds(
  layout: Record<string, unknown> | null | undefined
): Set<string> {
  const bubbles = layout?.bubbles;
  if (!Array.isArray(bubbles)) return new Set();
  const ids = new Set<string>();
  for (const b of bubbles) {
    const assoId = (b as { assoId?: unknown } | null)?.assoId;
    if (typeof assoId === 'string') ids.add(assoId);
  }
  return ids;
}
