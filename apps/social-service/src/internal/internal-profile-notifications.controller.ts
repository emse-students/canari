import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
} from '@nestjs/common';
import { PostNotificationsService } from '../posts/post-notifications.service';
import { assertInternalSecret } from './internal-secret.util';

/** The two answers an admin can give to a profile correction request (D10). */
export const PROFILE_CORRECTION_OUTCOMES = ['applied', 'refused'] as const;
type ProfileCorrectionOutcome = (typeof PROFILE_CORRECTION_OUTCOMES)[number];

/** The longest refusal note a notification row carries. */
const NOTE_MAX = 500;

/** What the notification says a person's name is: the platform, since an admin acted for it. */
const SYSTEM_ACTOR_NAME = 'Canari';

interface ProfileCorrectionBody {
  recipientId: string;
  outcome: ProfileCorrectionOutcome;
  /** The correction request this answers; the notification's `postId`, which opens `/profile`. */
  requestId: string;
  /** The admin's reason, for a refusal. Optional. */
  note?: string;
}

/**
 * Tells a person that their profile correction request was applied or refused (WP4b).
 *
 * Internal-only, like every route in this module: core-service owns the request and calls here once
 * it is answered. It reuses the notifications the app already has - the same table, the same
 * notifications page - rather than a parallel channel: the in-app row is the notification, and NO
 * system push is sent (`skipPush`), because the native push tables have no sentence for these two
 * types yet and an unknown type would only log a warning per call. The push is the follow-up.
 *
 * The actor is the platform, not the admin who answered: the person asked Canari, and an admin's
 * identity is not theirs to see. An empty `actorId` is what the client already reads as "draw
 * initials from the name".
 */
@Controller('internal/notifications')
export class InternalProfileNotificationsController {
  private readonly logger = new Logger(InternalProfileNotificationsController.name);

  constructor(private readonly notifications: PostNotificationsService) {}

  @Post('profile-correction')
  @HttpCode(200)
  async profileCorrection(
    @Headers('x-internal-secret') secret: string | undefined,
    @Body() body: ProfileCorrectionBody
  ): Promise<{ ok: true }> {
    assertInternalSecret(secret);
    if (
      !body?.recipientId ||
      !body.requestId ||
      !PROFILE_CORRECTION_OUTCOMES.includes(body.outcome)
    ) {
      this.logger.warn(
        `[PROFILE_NOTIFY] refused: malformed body (outcome=${String(body?.outcome)})`
      );
      throw new BadRequestException('recipientId, requestId and a known outcome are required');
    }
    await this.notifications.createNotification({
      recipientId: body.recipientId,
      type: `profile_correction_${body.outcome}`,
      postId: body.requestId,
      actorId: '',
      actorName: SYSTEM_ACTOR_NAME,
      text: (body.note ?? '').slice(0, NOTE_MAX),
      skipPush: true,
    });
    this.logger.log(
      `[PROFILE_NOTIFY] ${body.outcome} for ${body.recipientId.slice(0, 8)} request=${body.requestId.slice(0, 8)}`
    );
    return { ok: true };
  }
}
