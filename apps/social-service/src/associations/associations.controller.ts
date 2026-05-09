import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  SetMetadata,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';
import { MIN_ROLE_KEY } from './guards/association-role.guard';
import { GlobalAdminOrAssociationRoleGuard } from './guards/global-admin-or-association-role.guard';
import { AssociationPermission } from './entities/association-member.entity';
import { AssociationsService } from './associations.service';
import { FollowsService } from '../follows/follows.service';
import {
  AddMemberDto,
  CreateAssociationDto,
  UpdateAssociationDto,
  UpdateMemberRoleDto,
} from './dto/association.dto';

const LOGO_UPLOAD_MB = 2;

@Controller('associations')
export class AssociationsController {
  constructor(
    private readonly service: AssociationsService,
    private readonly followsService: FollowsService
  ) {}

  // ── Public ────────────────────────────────────────────────────────────────

  @Get()
  list() {
    return this.service.list();
  }

  @Get('slug/:slug')
  findBySlug(@Param('slug') slug: string) {
    return this.service.findBySlug(slug);
  }

  @UseGuards(NginxAuthGuard)
  @Get('me/list')
  myAssociations(@Headers('x-user-id') userId: string) {
    return this.service.listByUser(userId);
  }

  @UseGuards(NginxAuthGuard)
  @Get('me/following')
  myFollowedAssociations(@Headers('x-user-id') userId: string) {
    return this.followsService.listFollowedAssociations(userId);
  }

  @Get(':id/members')
  listMembers(@Param('id') id: string) {
    return this.service.listMembers(id);
  }

  @UseGuards(NginxAuthGuard)
  @Get(':id/follow-status')
  followStatus(@Headers('x-user-id') userId: string, @Param('id') id: string) {
    return this.followsService.isFollowing(userId, id).then((following) => ({ following }));
  }

  @UseGuards(NginxAuthGuard)
  @Get(':id/manage-permission')
  async managePermission(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Param('id') id: string
  ) {
    const ok = await this.service.canPostAs(userId, id, { isGlobalAdmin: ga === 'true' });
    return { ok };
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  // ── Authenticated ─────────────────────────────────────────────────────────

  @UseGuards(NginxAuthGuard)
  @Post(':id/follow')
  followAssociation(@Headers('x-user-id') userId: string, @Param('id') id: string) {
    return this.followsService.followAssociation(userId, id);
  }

  @UseGuards(NginxAuthGuard)
  @Delete(':id/follow')
  unfollowAssociation(@Headers('x-user-id') userId: string, @Param('id') id: string) {
    return this.followsService.unfollowAssociation(userId, id);
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

  // ── Global Admin OR Association Admin ─────────────────────────────────────

  @SetMetadata(MIN_ROLE_KEY, AssociationPermission.Admin)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAssociationDto) {
    return this.service.update(id, dto);
  }

  @SetMetadata(MIN_ROLE_KEY, AssociationPermission.Admin)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: LOGO_UPLOAD_MB * 1024 * 1024 } })
  )
  @Post(':id/logo')
  uploadLogo(
    @Param('id') id: string,
    @Headers('authorization') authorization: string | undefined,
    @UploadedFile() file: { buffer: Buffer; mimetype: string; size: number } | undefined
  ) {
    if (!file?.buffer) {
      throw new BadRequestException('Missing file');
    }
    return this.service.setLogoFromUpload(
      id,
      {
        buffer: file.buffer,
        mimetype: file.mimetype,
        size: file.size,
      },
      authorization
    );
  }

  @SetMetadata(MIN_ROLE_KEY, AssociationPermission.Admin)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Delete(':id/logo')
  deleteLogo(
    @Param('id') id: string,
    @Headers('authorization') authorization: string | undefined
  ) {
    return this.service.clearStoredLogo(id, authorization);
  }

  @SetMetadata(MIN_ROLE_KEY, AssociationPermission.Admin)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Post(':id/members')
  addMember(@Param('id') id: string, @Body() dto: AddMemberDto) {
    return this.service.addMember(id, dto.userId, dto.role, dto.permission);
  }

  @SetMetadata(MIN_ROLE_KEY, AssociationPermission.Admin)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Patch(':id/members/:userId')
  updateMemberRole(
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
    @Body() dto: UpdateMemberRoleDto
  ) {
    return this.service.updateMemberRole(id, targetUserId, dto.role, dto.permission);
  }

  @SetMetadata(MIN_ROLE_KEY, AssociationPermission.Admin)
  @UseGuards(NginxAuthGuard, GlobalAdminOrAssociationRoleGuard)
  @Delete(':id/members/:userId')
  removeMember(@Param('id') id: string, @Param('userId') targetUserId: string) {
    return this.service.removeMember(id, targetUserId);
  }

  // ── Internal (called by core-service, bypass nginx auth in Docker network) ─

  @Post(':id/stripe-account')
  setStripeAccount(@Param('id') id: string, @Body() body: { stripeAccountId: string }) {
    return this.service.setStripeAccountId(id, body.stripeAccountId);
  }

  @Post(':id/stripe-complete')
  markStripeComplete(@Param('id') id: string) {
    return this.service.markStripeOnboardingComplete(id);
  }
}
