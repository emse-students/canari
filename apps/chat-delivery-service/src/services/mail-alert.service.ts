import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { QueryFailedError, Repository } from 'typeorm';
import { MailAlertDevice } from '../entities/mail-alert-device.entity';
import { MailAlertToken } from '../entities/mail-alert-token.entity';
import { PushToken } from '../entities/push-token.entity';
import { describeFcmFailure, fcmErrorCode, isTerminalPushTokenError } from '../utils/fcm-errors';
import { cutDeviceId, cutUserId } from '../utils/log-repeat';
import { buildMailPushMessage, hashMailAlertToken } from '../utils/mail-alert';
import { readMailPush, type MailPush } from '../utils/mail-push';
import { PUSH_DELIVERY_RECORDER, PushDeliveryTally } from '../utils/push-delivery-records';

/**
 * The `error` of every refusal the mail alert routes answer - a TYPE a client switches on, never the
 * prose beside it.
 */
export const MAIL_ALERT_REFUSAL = {
  /** 409: `platform_config.mail_push` is `none`; nothing may be subscribed. */
  off: 'mail_push_off',
  /** 503: this estate has no `MAIL_ALERT_DOMAIN`, so no address can be built. */
  unconfigured: 'mail_alert_unconfigured',
  /** 409: the device has no push registration, so no push could reach it. */
  notRegistered: 'push_not_registered',
  /** 409: another account already holds this token's hash (a collision): the client draws again. */
  tokenTaken: 'mail_alert_token_taken',
} as const;

/** The unique constraint on `mail_alert_token.tokenHash` (migration 059). */
const TOKEN_HASH_CONSTRAINT = 'UQ_mail_alert_token_hash';

/** Whether `e` is Postgres refusing a second account the same token hash - read from the driver's typed field. */
function isTokenHashTaken(e: unknown): boolean {
  return (
    e instanceof QueryFailedError &&
    (e.driverError as { constraint?: unknown } | undefined)?.constraint === TOKEN_HASH_CONSTRAINT
  );
}

/** What a subscription refusal carries. */
export class MailAlertRefusal extends Error {
  constructor(
    readonly error: (typeof MAIL_ALERT_REFUSAL)[keyof typeof MAIL_ALERT_REFUSAL],
    readonly status: 409 | 503
  ) {
    super(error);
  }
}

/** What the hook answers the Worker: a fact per outcome, never a guess. */
export type MailAlertHookOutcome =
  | { status: 'off' }
  | { status: 'unknown' }
  | { status: 'no_device' }
  | { status: 'pushed'; sent: number; failed: number };

/** What a device reads to decide whether to subscribe, keep, or repair (lot 5's reconcile). */
export interface MailAlertState {
  mode: MailPush;
  /** The alert domain of this estate; null when unconfigured. */
  domain: string | null;
  /** Whether THIS device is subscribed. */
  deviceSubscribed: boolean;
  /**
   * Whether the token the client read from the account's filter rule is the account's LIVE one (its
   * hash is the stored one and at least one device is subscribed). False for no token given.
   */
  tokenLive: boolean;
  /** How many of the account's devices are subscribed. */
  devices: number;
  /**
   * Whether the account holds a token at all: a device that never subscribed reads it to know
   * whether a rule of Canari's MAY exist before it reads the account's filter rules.
   */
  accountToken: boolean;
}

/**
 * MAIL LOT 5'S SERVER PATH (docs/wiki/mail-client-transport.md#as-built---lot-5): the subscriptions
 * a device makes with its own session, and the hook Cloudflare's Email Worker posts a token to,
 * which becomes an EMPTY push (`{type: 'mail'}`) to the account's subscribed devices. Nothing here
 * ever sees a mail, a sender, a subject or a mailbox address: only the account id, a device id and
 * the SHA-256 of an opaque token.
 */
@Injectable()
export class MailAlertService {
  private readonly logger = new Logger(MailAlertService.name);
  /** Alerts for a token nobody listens to (unknown, or no device left), since this process started. */
  private orphanAlerts = 0;

  constructor(
    @InjectRepository(MailAlertToken) private readonly tokenRepo: Repository<MailAlertToken>,
    @InjectRepository(MailAlertDevice) private readonly deviceRepo: Repository<MailAlertDevice>,
    @InjectRepository(PushToken) private readonly pushTokenRepo: Repository<PushToken>
  ) {}

  /** The estate's alert domain (`MAIL_ALERT_DOMAIN`), lower case; null when unset. */
  alertDomain(): string | null {
    const domain = (process.env.MAIL_ALERT_DOMAIN ?? '').trim().toLowerCase();
    return domain || null;
  }

  /**
   * Subscribes `deviceId` of `userId` under `token`: the account's live token becomes `token` (a new
   * one REPLACES the old - a rotation), and the device is added. Idempotent. Refused typed when the
   * switch is off, the estate has no domain, or the device has no push registration.
   */
  async subscribe(userId: string, deviceId: string, token: string): Promise<{ domain: string }> {
    const who = `user=${cutUserId(userId)} device=${cutDeviceId(deviceId)}`;
    const mode = await readMailPush(this.tokenRepo.manager, this.logger);
    if (mode !== 'cloudflare') {
      this.logger.log(`[MAIL_ALERT] subscribe REFUSED ${who}: mail_push=${mode}`);
      throw new MailAlertRefusal(MAIL_ALERT_REFUSAL.off, 409);
    }
    const domain = this.alertDomain();
    if (!domain) {
      this.logger.error(`[MAIL_ALERT] subscribe REFUSED ${who}: MAIL_ALERT_DOMAIN is unset`);
      throw new MailAlertRefusal(MAIL_ALERT_REFUSAL.unconfigured, 503);
    }
    const registered = await this.pushTokenRepo.exists({ where: { userId, deviceId } });
    if (!registered) {
      this.logger.warn(`[MAIL_ALERT] subscribe REFUSED ${who}: no push registration`);
      throw new MailAlertRefusal(MAIL_ALERT_REFUSAL.notRegistered, 409);
    }
    const tokenHash = hashMailAlertToken(token);
    try {
      await this.tokenRepo.manager.transaction(async (manager) => {
        // The account's token row, LOCKED: a subscribe and an unsubscribe of one account serialise
        // here, so "the last device left, the token goes" never races a device joining.
        const current = await manager.findOne(MailAlertToken, {
          where: { userId },
          lock: { mode: 'pessimistic_write' },
        });
        if (current?.tokenHash !== tokenHash) {
          await manager.upsert(MailAlertToken, { userId, tokenHash }, ['userId']);
          this.logger.log(`[MAIL_ALERT] token ${current ? 'rotated' : 'set'} ${who}`);
        }
        await manager.upsert(MailAlertDevice, { userId, deviceId }, ['userId', 'deviceId']);
      });
    } catch (e) {
      if (!isTokenHashTaken(e)) throw e;
      this.logger.warn(`[MAIL_ALERT] subscribe REFUSED ${who}: the token's hash is taken`);
      throw new MailAlertRefusal(MAIL_ALERT_REFUSAL.tokenTaken, 409);
    }
    this.logger.log(`[MAIL_ALERT] subscribed ${who}`);
    return { domain };
  }

  /**
   * Unsubscribes `deviceId`. When it was the account's last device the token row goes too: a token
   * with nobody to push to is useless and is not kept. Returns how many devices remain. Idempotent.
   */
  async unsubscribe(userId: string, deviceId: string): Promise<{ remaining: number }> {
    const who = `user=${cutUserId(userId)} device=${cutDeviceId(deviceId)}`;
    const remaining = await this.tokenRepo.manager.transaction(async (manager) => {
      // Locked first, as in `subscribe`: the count below is then the truth when it is acted on.
      await manager.findOne(MailAlertToken, {
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });
      await manager.delete(MailAlertDevice, { userId, deviceId });
      const left = await manager.count(MailAlertDevice, { where: { userId } });
      if (left === 0) await manager.delete(MailAlertToken, { userId });
      return left;
    });
    this.logger.log(`[MAIL_ALERT] unsubscribed ${who} remaining=${remaining}`);
    return { remaining };
  }

  /** What `deviceId` reads to decide (see {@link MailAlertState}). */
  async state(userId: string, deviceId: string, token: string | null): Promise<MailAlertState> {
    const mode = await readMailPush(this.tokenRepo.manager, this.logger);
    const [row, devices, mine] = await Promise.all([
      this.tokenRepo.findOne({ where: { userId } }),
      this.deviceRepo.count({ where: { userId } }),
      this.deviceRepo.exists({ where: { userId, deviceId } }),
    ]);
    const tokenLive =
      token !== null && row !== null && row.tokenHash === hashMailAlertToken(token) && devices > 0;
    this.logger.debug(
      `[MAIL_ALERT] state user=${cutUserId(userId)} mode=${mode} devices=${devices} mine=${mine} live=${tokenLive}`
    );
    return {
      mode,
      domain: this.alertDomain(),
      deviceSubscribed: mine,
      tokenLive,
      devices,
      accountToken: row !== null,
    };
  }

  /**
   * One alert the Worker posted: `token` already shape-checked and the secret already proven by the
   * controller. Pushes `{type: 'mail'}` to every subscribed device of the token's account.
   */
  async alert(token: string): Promise<MailAlertHookOutcome> {
    const mode = await readMailPush(this.tokenRepo.manager, this.logger);
    if (mode !== 'cloudflare') {
      this.logger.log('[MAIL_ALERT] alert dropped: mail_push=none');
      return { status: 'off' };
    }
    const row = await this.tokenRepo.findOne({ where: { tokenHash: hashMailAlertToken(token) } });
    if (!row) {
      // A token rotated away or never subscribed: the account's filter rule still names it until a
      // device repairs it (lot 5's reconcile). Said at info - it names nobody.
      this.orphanAlerts++;
      this.logger.log(
        `[MAIL_ALERT] alert for an unknown token - nothing sent (orphan alerts since start=${this.orphanAlerts})`
      );
      return { status: 'unknown' };
    }
    const { userId, tokenHash } = row;
    const subscribed = await this.deviceRepo.find({ where: { userId } });
    const tokens =
      subscribed.length === 0
        ? []
        : await this.pushTokenRepo.find({
            where: subscribed.map((d) => ({ userId, deviceId: d.deviceId })),
          });
    if (tokens.length === 0) {
      // Every subscribed device lost its registration (the cascade took the rows): the token is
      // useless alone, so it goes.
      // By its hash too: a token rotated in since this read is not this one, and stays.
      await this.tokenRepo.delete({ userId, tokenHash });
      this.orphanAlerts++;
      this.logger.warn(
        `[MAIL_ALERT] alert for user=${cutUserId(userId)} with no subscribed device - the token is deleted (orphan alerts since start=${this.orphanAlerts})`
      );
      return { status: 'no_device' };
    }
    if (getApps().length === 0) {
      this.logger.warn('[MAIL_ALERT] Firebase not initialized - nothing sent');
      return { status: 'pushed', sent: 0, failed: tokens.length };
    }
    let sent = 0;
    let failed = 0;
    const tally = new PushDeliveryTally('mail');
    try {
      // A try PER DEVICE: one refused token never stops the others.
      for (const pt of tokens) {
        tally.attempted(pt);
        try {
          await getMessaging().send(buildMailPushMessage(pt));
          tally.accepted(pt);
          sent++;
          this.logger.log(
            `[MAIL_ALERT] pushed user=${cutUserId(userId)} device=${cutDeviceId(pt.deviceId)} platform=${pt.platform}`
          );
        } catch (e) {
          failed++;
          tally.failed(pt, fcmErrorCode(e) ?? 'unknown');
          if (isTerminalPushTokenError(e)) {
            await this.pushTokenRepo.delete({ id: pt.id });
            tally.pruned(pt);
          }
          const failure = describeFcmFailure(e);
          this.logger[failure.level](
            `[MAIL_ALERT] FCM failed user=${cutUserId(userId)} device=${cutDeviceId(pt.deviceId)} ${failure.text}`
          );
        }
      }
    } finally {
      PUSH_DELIVERY_RECORDER.record(this.pushTokenRepo.manager, tally, 'mail-alert');
    }
    return { status: 'pushed', sent, failed };
  }
}
