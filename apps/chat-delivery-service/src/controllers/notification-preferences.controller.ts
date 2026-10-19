import {
  BadRequestException,
  Body,
  Controller,
  Get,
  ForbiddenException,
  Headers,
  Logger,
  Param,
  Patch,
  Put,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { sanitizeQueryValue } from '../utils/sanitize';
import { isNotificationCategory, NOTIFICATION_CATEGORIES } from '../services/push-category';
import {
  readDisabledCategoriesStrict,
  readGroupCallPermissionsStrict,
  readGroupNotificationLevelsStrict,
  writeDisabledCategories,
  writeGroupCallsAllowed,
  writeGroupNotificationLevel,
} from '../services/notification-preferences';
import {
  GROUP_NOTIFICATION_LEVELS,
  isGroupNotificationLevel,
  isGroupUuid,
  type GroupNotificationLevel,
} from '../entities/group-member.entity';
import { cutUserId } from '../utils/log-repeat';

/**
 * The account's notification categories - what a client reads to draw the settings and to gate its
 * OWN local notifications, and what it writes when the user flips a switch. The server applies the
 * same set before sending a push (`MessagingService`), so this is the one source of truth.
 */
@Controller()
export class NotificationPreferencesController {
  private readonly logger = new Logger(NotificationPreferencesController.name);

  constructor(
    @InjectRepository(NotificationPreference)
    private readonly prefRepo: Repository<NotificationPreference>
  ) {}

  /**
   * The categories this account has switched off (empty = everything on), and every conversation it
   * made quieter than `all` (absent = `all`) - the two things a client needs to gate the
   * notifications it raises itself, in the one read it already makes at sign-in.
   */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/notification-preferences')
  async get(@Headers('x-user-id') userIdRaw: string): Promise<{
    disabled: string[];
    groupLevels: Record<string, GroupNotificationLevel>;
    groupCalls: Record<string, boolean>;
  }> {
    const userId = sanitizeQueryValue(userIdRaw, 'userId');
    const disabled = await readDisabledCategoriesStrict(this.prefRepo.manager, userId);
    const groupLevels = await readGroupNotificationLevelsStrict(this.prefRepo.manager, userId);
    const groupCalls = await readGroupCallPermissionsStrict(this.prefRepo.manager, userId);
    return { disabled: [...disabled], groupLevels, groupCalls };
  }

  /**
   * Records whether calls in ONE conversation may ring the caller (`{ allowed: boolean }`), on their
   * own membership row - the per-conversation call permission, beside the level. The ring fan-out
   * reads it (`CallsService.ringGroup`). A non-member is refused rather than told it was saved.
   */
  @UseGuards(HeaderAuthGuard)
  @Patch('mls/groups/:groupId/calls')
  async setGroupCalls(
    @Headers('x-user-id') userIdRaw: string,
    @Param('groupId') groupIdRaw: string,
    @Body() body: { allowed?: unknown }
  ): Promise<{ groupId: string; allowed: boolean }> {
    const userId = sanitizeQueryValue(userIdRaw, 'userId');
    const groupId = sanitizeQueryValue(groupIdRaw, 'groupId');
    if (!isGroupUuid(groupId)) throw new BadRequestException('groupId must be a uuid');
    const allowed = body?.allowed;
    if (typeof allowed !== 'boolean') throw new BadRequestException('allowed must be a boolean');
    const written = await writeGroupCallsAllowed(this.prefRepo.manager, groupId, userId, allowed);
    if (!written) {
      this.logger.warn(
        `[NOTIF_PREF] group calls REFUSED group=${groupId} user=${cutUserId(userId)}: not a member`
      );
      throw new ForbiddenException('Not a member of this conversation');
    }
    this.logger.log(`[NOTIF_PREF] group=${groupId} user=${cutUserId(userId)} calls=${allowed}`);
    return { groupId, allowed };
  }

  /**
   * Sets the caller's level for ONE conversation (`all` | `mentions` | `none`) - the salon's
   * `PATCH channels/:id/notification-level` for a private conversation. Stored on the caller's own
   * membership row, so a non-member is refused rather than told it was saved.
   */
  @UseGuards(HeaderAuthGuard)
  @Patch('mls/groups/:groupId/notification-level')
  async setGroupLevel(
    @Headers('x-user-id') userIdRaw: string,
    @Param('groupId') groupIdRaw: string,
    @Body() body: { level?: unknown }
  ): Promise<{ groupId: string; level: GroupNotificationLevel }> {
    const userId = sanitizeQueryValue(userIdRaw, 'userId');
    const groupId = sanitizeQueryValue(groupIdRaw, 'groupId');
    if (!isGroupUuid(groupId)) throw new BadRequestException('groupId must be a uuid');
    const level = body?.level;
    if (!isGroupNotificationLevel(level)) {
      throw new BadRequestException(`level must be one of ${GROUP_NOTIFICATION_LEVELS.join(', ')}`);
    }
    const written = await writeGroupNotificationLevel(
      this.prefRepo.manager,
      groupId,
      userId,
      level
    );
    if (!written) {
      this.logger.warn(
        `[NOTIF_PREF] group level REFUSED group=${groupId} user=${cutUserId(userId)}: not a member`
      );
      throw new ForbiddenException('Not a member of this conversation');
    }
    this.logger.log(`[NOTIF_PREF] group=${groupId} user=${cutUserId(userId)} level=${level}`);
    return { groupId, level };
  }

  /** Replaces the disabled set. Unknown ids are refused: a typo must not read as "saved". */
  @UseGuards(HeaderAuthGuard)
  @Put('mls/notification-preferences')
  async put(
    @Headers('x-user-id') userIdRaw: string,
    @Body() body: { disabled?: unknown }
  ): Promise<{ disabled: string[] }> {
    const userId = sanitizeQueryValue(userIdRaw, 'userId');
    if (!Array.isArray(body?.disabled)) {
      throw new BadRequestException('disabled must be an array of category ids');
    }
    const requested: unknown[] = body.disabled;
    const disabled = [...new Set(requested.filter(isNotificationCategory))];
    if (disabled.length !== new Set(requested).size) {
      throw new BadRequestException(
        `unknown category; expected a subset of ${NOTIFICATION_CATEGORIES.join(', ')}`
      );
    }
    await writeDisabledCategories(this.prefRepo.manager, userId, disabled);
    this.logger.log(`[NOTIF_PREF] user=${userId} disabled=[${disabled.join(',')}]`);
    return { disabled };
  }
}
