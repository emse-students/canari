import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { PosterProject } from './entities/poster-project.entity';
import { CreatePosterProjectDto, UpdatePosterProjectDto } from './dto/poster.dto';
import { sanitizePublishedCarte, type PublishedCarte } from './published-carte';

/** The published map plus the metadata the showcase displays alongside it. */
export interface PublishedCarteResponse extends PublishedCarte {
  /** Author-chosen project name, e.g. "Carte 2026". */
  name: string;
  /** ISO timestamp of the last publish. */
  publishedAt: string;
}

/**
 * CRUD for {@link PosterProject} layouts (the "Carte de la Vie Asso" editor). Layouts hold
 * positioning only; live association/member content is re-resolved by the frontend at render
 * time. Access is gated at the controller (global admins + BDE super-admins).
 */
@Injectable()
export class PosterService {
  private readonly logger = new Logger(PosterService.name);

  constructor(
    @InjectRepository(PosterProject)
    private readonly posterRepo: Repository<PosterProject>
  ) {}

  /**
   * Lists all poster projects, most-recently-updated first. `publication` is left out: it can carry
   * a multi-megabyte background data URL, which the list page never renders.
   */
  list(): Promise<PosterProject[]> {
    this.logger.debug('list poster projects');
    return this.posterRepo.find({
      select: {
        id: true,
        name: true,
        layout: true,
        publishedAt: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
      },
      order: { updatedAt: 'DESC' },
    });
  }

  /** Loads one project by id. Throws NotFoundException when absent. */
  async get(id: string): Promise<PosterProject> {
    this.logger.debug(`get poster project ${id}`);
    const project = await this.posterRepo.findOne({ where: { id } });
    if (!project) throw new NotFoundException('Poster project not found');
    return project;
  }

  /** Creates a project owned by `createdBy`. */
  create(dto: CreatePosterProjectDto, createdBy: string): Promise<PosterProject> {
    this.logger.debug(`create poster project by ${createdBy}`);
    return this.posterRepo.save(
      this.posterRepo.create({
        name: dto.name,
        layout: dto.layout ?? {},
        createdBy,
      })
    );
  }

  /** Applies a partial update (rename and/or replace the layout). */
  async update(id: string, dto: UpdatePosterProjectDto): Promise<PosterProject> {
    this.logger.debug(`update poster project ${id}`);
    const project = await this.get(id);
    if (dto.name !== undefined) project.name = dto.name;
    if (dto.layout !== undefined) project.layout = dto.layout;
    return this.posterRepo.save(project);
  }

  /** Permanently deletes a project. Also takes the public map offline when this one was live. */
  async remove(id: string): Promise<{ ok: boolean }> {
    this.logger.debug(`remove poster project ${id}`);
    await this.posterRepo.delete(id);
    return { ok: true };
  }

  /**
   * Publishes a poster to the public showcase, replacing whatever was live.
   *
   * The payload is validated field by field first ({@link sanitizePublishedCarte}) - it is about to
   * be served to anonymous visitors, so "the caller is an admin" is not enough. Unpublishing the
   * previous map and publishing this one happen in ONE transaction because the partial unique index
   * from migration 035 forbids two live rows: doing it in two statements would fail against itself.
   *
   * @param id - Project to publish.
   * @param payload - Normalized geometry document produced by the carte editor.
   * @throws BadRequestException when the payload carries no placeable association.
   */
  async publish(id: string, payload: unknown): Promise<PosterProject> {
    this.logger.debug(`publish poster project ${id}`);
    const publication = sanitizePublishedCarte(payload);
    if (!publication) {
      this.logger.warn(`publish rejected for ${id}: payload has no usable bubble`);
      throw new BadRequestException('Publication payload is empty or malformed');
    }
    await this.get(id);
    return this.posterRepo.manager.transaction(async (manager) => {
      const repo = manager.getRepository(PosterProject);
      // Clear the previous live map FIRST; the unique index allows only one non-null publication.
      await repo.update({ publication: Not(IsNull()) }, { publication: null, publishedAt: null });
      await repo.update(id, {
        publication: publication as unknown as Record<string, unknown>,
        publishedAt: new Date(),
      });
      const saved = await repo.findOne({ where: { id } });
      if (!saved) throw new NotFoundException('Poster project not found');
      return saved;
    });
  }

  /** Takes a poster offline. Idempotent: unpublishing an already-offline project is a no-op. */
  async unpublish(id: string): Promise<PosterProject> {
    this.logger.debug(`unpublish poster project ${id}`);
    const project = await this.get(id);
    project.publication = null;
    project.publishedAt = null;
    return this.posterRepo.save(project);
  }

  /**
   * The single live map, or null when nothing is published. Read by the unauthenticated
   * `/api/public/carte` route that portail-etu polls.
   */
  async getPublished(): Promise<PublishedCarteResponse | null> {
    const project = await this.posterRepo.findOne({ where: { publication: Not(IsNull()) } });
    if (!project?.publication || !project.publishedAt) {
      this.logger.debug('getPublished: no poster is live');
      return null;
    }
    this.logger.debug(`getPublished: serving ${project.id}`);
    return {
      ...(project.publication as unknown as PublishedCarte),
      name: project.name,
      publishedAt: project.publishedAt.toISOString(),
    };
  }
}
