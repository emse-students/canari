import {
  Controller,
  Get,
  Body,
  Patch,
  Put,
  Param,
  Headers,
  UseGuards,
  Query,
  Post,
  Delete,
  HttpCode,
  Res,
  ForbiddenException,
} from '@nestjs/common';
import type { Response } from 'express';
import { UsersService } from './users.service';
import { AvatarService } from './avatar.service';
import { CreateUserDto, UpdateUserDto, UpdateNotesDto, DirectoryQueryDto } from './dto/user.dto';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';

/** Controller handling user profile CRUD, search, and avatar proxy. */
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly avatarService: AvatarService
  ) {}

  /**
   * Search users by id or displayName for autocomplete.
   * Usage: GET /users/search?q=jol
   */
  @UseGuards(NginxAuthGuard)
  @Get('search')
  search(@Query('q') query: string, @Headers('x-user-id') currentUserId: string) {
    // Exclude the authenticated caller (nginx-injected identity) from results.
    return this.usersService.search(query, currentUserId);
  }

  /**
   * Paginated user directory with filters (promo, formation, association membership).
   * Usage: GET /users/directory?q=jean&promo=2024&formation=ICM
   */
  @UseGuards(NginxAuthGuard)
  @Get('directory')
  directory(@Query() query: DirectoryQueryDto, @Headers('x-user-id') userId: string) {
    return this.usersService.directory(query, userId);
  }

  /**
   * Get user avatar from external service.
   * Usage: GET /users/{id}/avatar
   */
  @Get(':id/avatar')
  async getAvatar(@Param('id') userId: string, @Res() res: Response) {
    const avatarBuffer = await this.avatarService.fetchUserAvatar(userId);
    res.set({
      'Content-Type': 'image/jpeg',
      'Content-Length': avatarBuffer.length,
      'Cache-Control': 'public, max-age=86400',
    });
    res.send(avatarBuffer);
  }

  /** Creates a new user from the provided DTO. Restricted to global admins (OIDC flow uses findOrCreateFromOidc internally). */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Post()
  create(@Body() createUserDto: CreateUserDto) {
    return this.usersService.create(createUserDto);
  }

  /** Returns the caller's private personal notepad (markdown). */
  @UseGuards(NginxAuthGuard)
  @Get('me/notes')
  async getMyNotes(@Headers('x-user-id') userId: string) {
    const notes = await this.usersService.getNotes(userId);
    return { notes };
  }

  /** Updates the caller's private personal notepad. */
  @UseGuards(NginxAuthGuard)
  @Put('me/notes')
  async setMyNotes(@Headers('x-user-id') userId: string, @Body() dto: UpdateNotesDto) {
    await this.usersService.setNotes(userId, dto.notes ?? '');
    return { ok: true };
  }

  /** Returns the public profile of the requested user, resolving "me" to the caller. */
  @UseGuards(NginxAuthGuard)
  @Get(':id')
  async findOne(@Param('id') id: string, @Headers('x-user-id') requesterId: string) {
    if (id === 'me') {
      id = requesterId;
    }
    const user = await this.usersService.findOne(id);
    return this.usersService.toPublicDto(user);
  }

  /**
   * Permanently deletes the authenticated user's account and all associated data
   * across all services (MLS keys, messages, posts, memberships, Stripe customer).
   * Returns 204 No Content on success.
   */
  @UseGuards(NginxAuthGuard)
  @Delete('me')
  @HttpCode(204)
  async deleteMe(@Headers('x-user-id') userId: string): Promise<void> {
    await this.usersService.deleteUser(userId);
  }

  /** Updates the authenticated user's profile and returns the updated public DTO. */
  @UseGuards(NginxAuthGuard)
  @Patch('me')
  async updateMe(@Headers('x-user-id') userId: string, @Body() updateUserDto: UpdateUserDto) {
    const user = await this.usersService.update(userId, updateUserDto);
    return this.usersService.toPublicDto(user);
  }

  /** Returns all users with their admin status; requires global admin. */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Get('admin/list')
  listAll() {
    return this.usersService.listAll();
  }

  /**
   * Sets or clears the global admin flag on a user; requires global admin.
   * An admin cannot revoke their *own* flag - another admin must do it. This guarantees
   * a sole admin can never lock themselves (and the platform) out, so at least one admin
   * always remains.
   */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Patch(':id/admin')
  async setAdmin(
    @Param('id') targetId: string,
    @Headers('x-user-id') callerId: string,
    @Body() body: { admin: boolean }
  ) {
    const isSelf = targetId.trim().toLowerCase() === (callerId ?? '').trim().toLowerCase();
    if (body.admin === false && isSelf) {
      throw new ForbiddenException(
        'Un administrateur ne peut pas retirer ses propres droits ; un autre administrateur doit le faire.'
      );
    }
    await this.usersService.setAdmin(targetId, body.admin);
    return { ok: true, userId: targetId, admin: body.admin };
  }
}
