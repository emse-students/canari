import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  Logger,
  Post,
  Headers,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { MailAlertThrottlerGuard } from '../guards/mail-alert-throttler.guard';
import { UserThrottlerGuard } from '../guards/user-throttler.guard';
import {
  MailAlertRefusal,
  MailAlertService,
  type MailAlertHookOutcome,
  type MailAlertState,
} from '../services/mail-alert.service';
import {
  isMailAlertToken,
  MAIL_ALERT_SECRET_HEADER,
  mailAlertSecretMatches,
} from '../utils/mail-alert';
import { sanitizeQueryValue } from '../utils/sanitize';

/** Alerts one token may trigger per minute: far above one person's mail, far below a flood. */
export const MAIL_ALERT_LIMIT_PER_MINUTE = 30;

/** The device ids this service stores are client-drawn strings; refuse anything absurd. */
function deviceIdOf(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 128) {
    throw new BadRequestException('deviceId must be a non-empty string');
  }
  return raw;
}

/** The typed HTTP answer of a {@link MailAlertRefusal}. */
function refusalAnswer(e: unknown): never {
  if (e instanceof MailAlertRefusal) {
    throw new HttpException({ error: e.error, message: e.message }, e.status);
  }
  throw e;
}

/**
 * MAIL LOT 5'S ROUTES (docs/wiki/mail-client-transport.md#as-built---lot-5).
 *
 * - `POST /api/mls/mail-alert/subscribe|unsubscribe|state`: a device, with its own Canari session
 *   (`HeaderAuthGuard`, 10 per minute per user), subscribes to the empty mail push under the token
 *   it wrote into its OWN Zimbra alert, leaves it, or reads whether a token is live.
 * - `POST /api/hooks/mail-alert`: Cloudflare's Email Worker, with the estate's shared secret
 *   (`x-canari-mail-alert-secret`, compared in constant time), posts `{token}` - the local part of
 *   the address the alert went to, and nothing else. Throttled per token.
 */
@Controller()
export class MailAlertController {
  private readonly logger = new Logger(MailAlertController.name);

  constructor(private readonly mailAlert: MailAlertService) {}

  /** Subscribes this device under `token`; answers the domain the client builds the address with. */
  @UseGuards(HeaderAuthGuard, UserThrottlerGuard)
  @Post('mls/mail-alert/subscribe')
  @HttpCode(200)
  async subscribe(
    @Headers('x-user-id') userIdRaw: string,
    @Body() body: { deviceId?: unknown; token?: unknown }
  ): Promise<{ domain: string }> {
    const userId = sanitizeQueryValue(userIdRaw, 'userId');
    const deviceId = deviceIdOf(body?.deviceId);
    if (!isMailAlertToken(body?.token)) throw new BadRequestException('token must be 32 hex');
    return this.mailAlert.subscribe(userId, deviceId, body.token).catch(refusalAnswer);
  }

  /** Unsubscribes this device; answers how many of the account's devices remain. */
  @UseGuards(HeaderAuthGuard, UserThrottlerGuard)
  @Post('mls/mail-alert/unsubscribe')
  @HttpCode(200)
  async unsubscribe(
    @Headers('x-user-id') userIdRaw: string,
    @Body() body: { deviceId?: unknown }
  ): Promise<{ remaining: number }> {
    const userId = sanitizeQueryValue(userIdRaw, 'userId');
    return this.mailAlert.unsubscribe(userId, deviceIdOf(body?.deviceId));
  }

  /**
   * What this device needs to decide: the switch, the domain, whether it is subscribed, and whether
   * `token` (read from the account's own Zimbra alert, in the BODY so it never reaches a log line)
   * is the account's live one.
   */
  @UseGuards(HeaderAuthGuard, UserThrottlerGuard)
  @Post('mls/mail-alert/state')
  @HttpCode(200)
  async state(
    @Headers('x-user-id') userIdRaw: string,
    @Body() body: { deviceId?: unknown; token?: unknown }
  ): Promise<MailAlertState> {
    const userId = sanitizeQueryValue(userIdRaw, 'userId');
    const deviceId = deviceIdOf(body?.deviceId);
    const token = body?.token;
    if (token !== undefined && token !== null && !isMailAlertToken(token)) {
      throw new BadRequestException('token must be 32 hex or absent');
    }
    return this.mailAlert.state(userId, deviceId, isMailAlertToken(token) ? token : null);
  }

  /** Cloudflare's Email Worker: one new-mail alert, by its token only. */
  @UseGuards(MailAlertThrottlerGuard)
  @Throttle({ default: { limit: MAIL_ALERT_LIMIT_PER_MINUTE, ttl: 60_000 } })
  @Post('hooks/mail-alert')
  @HttpCode(200)
  async hook(
    @Headers(MAIL_ALERT_SECRET_HEADER) secret: string | undefined,
    @Body() body: { token?: unknown }
  ): Promise<MailAlertHookOutcome> {
    if (!mailAlertSecretMatches(secret, process.env.MAIL_ALERT_HOOK_SECRET)) {
      if (!(process.env.MAIL_ALERT_HOOK_SECRET ?? '').trim()) {
        this.logger.error(
          '[MAIL_ALERT] alert refused: MAIL_ALERT_HOOK_SECRET is unset on this estate'
        );
      } else {
        this.logger.warn('[MAIL_ALERT] alert refused: the secret does not match');
      }
      throw new UnauthorizedException();
    }
    if (!isMailAlertToken(body?.token)) {
      this.logger.warn('[MAIL_ALERT] alert refused: no well-formed token in the body');
      throw new BadRequestException('token must be 32 hex');
    }
    return this.mailAlert.alert(body.token);
  }
}
