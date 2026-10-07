import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Logger,
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
  writeDisabledCategories,
} from '../services/notification-preferences';

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

  /** The categories this account has switched off (empty = everything on). */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/notification-preferences')
  async get(@Headers('x-user-id') userIdRaw: string): Promise<{ disabled: string[] }> {
    const userId = sanitizeQueryValue(userIdRaw, 'userId');
    const disabled = await readDisabledCategoriesStrict(this.prefRepo.manager, userId);
    return { disabled: [...disabled] };
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
