import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AssociationCategory } from './entities/association-category.entity';
import { Association } from './entities/association.entity';
import {
  CreateAssociationCategoryDto,
  UpdateAssociationCategoryDto,
} from './dto/association-category.dto';

/**
 * Manages the {@link AssociationCategory} taxonomy used to group associations on the
 * "Carte de la Vie Asso" poster. Categories are ordered data (not a hardcoded enum) so admins
 * can add / rename / reorder zones without a deploy.
 */
@Injectable()
export class AssociationCategoriesService {
  private readonly logger = new Logger(AssociationCategoriesService.name);

  constructor(
    @InjectRepository(AssociationCategory)
    private readonly categoryRepo: Repository<AssociationCategory>,
    @InjectRepository(Association)
    private readonly assoRepo: Repository<Association>
  ) {}

  /** Lists every category in display order (sortOrder ASC, then label ASC). */
  list(): Promise<AssociationCategory[]> {
    this.logger.debug('list categories');
    return this.categoryRepo.find({ order: { sortOrder: 'ASC', label: 'ASC' } });
  }

  /** Creates a category. Throws ConflictException when the slug is already taken. */
  async create(dto: CreateAssociationCategoryDto): Promise<AssociationCategory> {
    this.logger.debug(`create category slug=${dto.slug}`);
    const existing = await this.categoryRepo.findOne({ where: { slug: dto.slug } });
    if (existing) {
      throw new ConflictException('A category with this slug already exists');
    }
    return this.categoryRepo.save(
      this.categoryRepo.create({
        label: dto.label,
        slug: dto.slug,
        sortOrder: dto.sortOrder ?? 0,
      })
    );
  }

  /** Applies a partial update (the slug is immutable). Throws NotFoundException when absent. */
  async update(id: string, dto: UpdateAssociationCategoryDto): Promise<AssociationCategory> {
    this.logger.debug(`update category ${id}`);
    const category = await this.categoryRepo.findOne({ where: { id } });
    if (!category) throw new NotFoundException('Category not found');
    if (dto.label !== undefined) category.label = dto.label;
    if (dto.sortOrder !== undefined) category.sortOrder = dto.sortOrder;
    return this.categoryRepo.save(category);
  }

  /**
   * Deletes a category and detaches it from every association that referenced it
   * (categoryId -> null), keeping the loose reference column consistent.
   */
  async remove(id: string): Promise<{ ok: boolean }> {
    this.logger.debug(`remove category ${id}`);
    await this.assoRepo.update({ categoryId: id }, { categoryId: null });
    await this.categoryRepo.delete(id);
    return { ok: true };
  }

  /**
   * Persists a new top-to-bottom order. Ids absent from `orderedIds` keep their previous
   * sortOrder (they simply sort after the reordered ones).
   */
  async reorder(orderedIds: string[]): Promise<AssociationCategory[]> {
    this.logger.debug(`reorder ${orderedIds.length} categories`);
    await Promise.all(
      orderedIds.map((id, index) => this.categoryRepo.update(id, { sortOrder: index }))
    );
    return this.list();
  }
}
