import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';
import { AssociationRoleGuard, MIN_ROLE_KEY } from './guards/association-role.guard';
import { AssociationPermission } from './entities/association-member.entity';
import { AssociationsService } from './associations.service';
import {
  AddMemberDto,
  CreateAssociationDto,
  UpdateAssociationDto,
  UpdateMemberRoleDto,
} from './dto/association.dto';

@Controller('associations')
export class AssociationsController {
  constructor(private readonly service: AssociationsService) {}

  // ── Public ────────────────────────────────────────────────────────────────

  @Get()
  list() {
    return this.service.list();
  }

  @Get('slug/:slug')
  findBySlug(@Param('slug') slug: string) {
    return this.service.findBySlug(slug);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Get(':id/members')
  listMembers(@Param('id') id: string) {
    return this.service.listMembers(id);
  }

  // ── Authenticated ─────────────────────────────────────────────────────────

  @UseGuards(NginxAuthGuard)
  @Get('me/list')
  myAssociations(@Headers('x-user-id') userId: string) {
    return this.service.listByUser(userId);
  }

  // ── Global Admin only ─────────────────────────────────────────────────────

  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Post()
  create(@Headers('x-user-id') userId: string, @Body() dto: CreateAssociationDto) {
    return this.service.create(dto, userId);
  }

  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  // ── Association Admin+ (settings) ─────────────────────────────────────────

  @SetMetadata(MIN_ROLE_KEY, AssociationPermission.Admin)
  @UseGuards(NginxAuthGuard, AssociationRoleGuard)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAssociationDto) {
    return this.service.update(id, dto);
  }

  // ── Member management (Global Admin only) ─────────────────────────────────

  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Post(':id/members')
  addMember(@Param('id') id: string, @Body() dto: AddMemberDto) {
    return this.service.addMember(id, dto.userId, dto.role, dto.permission);
  }

  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Patch(':id/members/:userId')
  updateMemberRole(
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
    @Body() dto: UpdateMemberRoleDto
  ) {
    return this.service.updateMemberRole(id, targetUserId, dto.role, dto.permission);
  }

  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Delete(':id/members/:userId')
  removeMember(@Param('id') id: string, @Param('userId') targetUserId: string) {
    return this.service.removeMember(id, targetUserId);
  }

  // ── Internal (called by core-service webhook) ─────────────────────────────

  @Post(':id/stripe-complete')
  markStripeComplete(@Param('id') id: string) {
    return this.service.markStripeOnboardingComplete(id);
  }
}
