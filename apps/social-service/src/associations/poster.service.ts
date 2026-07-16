import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PosterProject } from './entities/poster-project.entity';
import { CreatePosterProjectDto, UpdatePosterProjectDto } from './dto/poster.dto';

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

  /** Lists all poster projects, most-recently-updated first. */
  list(): Promise<PosterProject[]> {
    this.logger.debug('list poster projects');
    return this.posterRepo.find({ order: { updatedAt: 'DESC' } });
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

  /** Permanently deletes a project. */
  async remove(id: string): Promise<{ ok: boolean }> {
    this.logger.debug(`remove poster project ${id}`);
    await this.posterRepo.delete(id);
    return { ok: true };
  }
}
