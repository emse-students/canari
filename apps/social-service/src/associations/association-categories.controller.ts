import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { GlobalAdminOrBdeSuperAdminGuard } from './guards/global-admin-or-bde-super-admin.guard';
import { AssociationCategoriesService } from './association-categories.service';
import {
  CreateAssociationCategoryDto,
  ReorderCategoriesDto,
  UpdateAssociationCategoryDto,
} from './dto/association-category.dto';

/**
 * Manages the association thematic taxonomy used by the "Carte de la Vie Asso" poster and
 * directory. Reads are public (labels are shown throughout the app); writes are restricted to
 * global admins and BDE super-admins.
 *
 * Registered BEFORE {@link AssociationsController} in the module so its literal routes win over
 * the `/associations/:id` matcher.
 */
@Controller('associations/categories')
export class AssociationCategoriesController {
  constructor(private readonly service: AssociationCategoriesService) {}

  /** Lists categories in display order. Public. */
  @Get()
  list() {
    return this.service.list();
  }

  /** Creates a category. Global admins and BDE super-admins only. */
  @UseGuards(NginxAuthGuard, GlobalAdminOrBdeSuperAdminGuard)
  @Post()
  create(@Body() dto: CreateAssociationCategoryDto) {
    return this.service.create(dto);
  }

  /**
   * Persists a new top-to-bottom order. Declared before `:id` so `reorder` is not captured as
   * a category id. Global admins and BDE super-admins only.
   */
  @UseGuards(NginxAuthGuard, GlobalAdminOrBdeSuperAdminGuard)
  @Patch('reorder')
  reorder(@Body() dto: ReorderCategoriesDto) {
    return this.service.reorder(dto.orderedIds);
  }

  /** Updates a category's label/order. Global admins and BDE super-admins only. */
  @UseGuards(NginxAuthGuard, GlobalAdminOrBdeSuperAdminGuard)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAssociationCategoryDto) {
    return this.service.update(id, dto);
  }

  /** Deletes a category and detaches it from its associations. Admins/BDE super-admins only. */
  @UseGuards(NginxAuthGuard, GlobalAdminOrBdeSuperAdminGuard)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
