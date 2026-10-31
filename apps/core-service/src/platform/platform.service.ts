import axios from 'axios';
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { PlatformConfig, type CallsMode, type LivesMode } from './entities/platform-config.entity';
import { UpdatePlatformConfigDto } from './dto/update-platform-config.dto';
import { compareSemver } from './semver';
import { deployedVersion } from './deployed-version';
import { describeHttpError } from '../common/http-error-log';
import {
  internalSocialRequestConfig,
  providerActivatedUrl,
} from '../payment/social-internal-client';
import type { PaymentProviderId } from '../payment/payment-provider.interface';

export type PlatformConfigPublic = {
  maintenanceEnabled: boolean;
  maintenanceMessage: string | null;
  minClientVersion: string;
  paymentProvider: PaymentProviderId;
  callsMode: CallsMode;
  livesMode: LivesMode;
};

/**
 * Typed codes in the body of the platform-admin refusals, so the admin screen maps a refusal by
 * CODE and never by its English prose.
 *
 * `WITHHELD_RELEASE_INCOMPLETE` (502): the payment provider IS saved, but social-service did not
 * release every withheld product. The body also carries the saved `config`, so the screen can show
 * the truth rather than "nothing was saved", and the dedicated release action repeats the sweep.
 * `PAYMENTS_DISABLED` (400): the release action was asked while the provider is `disabled`.
 */
export const PLATFORM_ERROR_CODES = {
  WITHHELD_RELEASE_INCOMPLETE: 'WITHHELD_RELEASE_INCOMPLETE',
  PAYMENTS_DISABLED: 'PAYMENTS_DISABLED',
} as const;

/** How many withheld products social-service put on sale, and how many associations it missed. */
export type WithheldReleaseResult = { released: number; failed: number };

/** Same budget as the sibling core -> social-service calls (see payment/webhook.controller.ts). */
const SOCIAL_RELEASE_TIMEOUT_MS = 15_000;

const DEFAULT_ROW: PlatformConfig = {
  id: 1,
  maintenanceEnabled: false,
  maintenanceMessage: null,
  minClientVersion: '0.0.0',
  paymentProvider: 'disabled',
  callsMode: 'off',
  livesMode: 'off',
};

/** Reads and updates the singleton platform configuration row in PostgreSQL. */
@Injectable()
export class PlatformService implements OnModuleInit {
  private readonly logger = new Logger(PlatformService.name);

  constructor(
    @InjectRepository(PlatformConfig)
    private readonly repo: Repository<PlatformConfig>
  ) {}

  /** Ensures the singleton config row exists on service startup. */
  async onModuleInit(): Promise<void> {
    await this.ensureDefaults();
  }

  /** Creates the default row when missing (id=1). */
  async ensureDefaults(): Promise<void> {
    const existing = await this.repo.findOne({ where: { id: 1 } });
    if (existing) return;
    this.logger.debug('Creating default platform_config row');
    await this.repo.save({ ...DEFAULT_ROW });
  }

  /** Returns current platform settings for public version endpoint and auth guards. */
  async getConfig(): Promise<PlatformConfigPublic> {
    await this.ensureDefaults();
    const row = await this.repo.findOneOrFail({ where: { id: 1 } });
    return toPublic(row);
  }

  /**
   * Applies a partial update from a global admin and returns the new config. `actor` is the
   * administrator's user id: the switches that can shut every client out (the min-version raise
   * and the calls and lives kill switches) name who moved them, shortened to 8 characters like the other audit
   * lines - enough to find the account, not a full id copied into every log line.
   */
  async updateConfig(dto: UpdatePlatformConfigDto, actor: string): Promise<PlatformConfigPublic> {
    const by = actor.slice(0, 8);
    await this.ensureDefaults();
    // Read for the guards and the "from -> to" lines only. What is written is the columns this
    // request names, as ONE `UPDATE` of the row - never a save of the row read: a save writes back
    // every column another administrator changed since this read, a kill switch included.
    const row = await this.repo.findOneOrFail({ where: { id: 1 } });
    const changes: QueryDeepPartialEntity<PlatformConfig> = {};

    if (dto.maintenanceEnabled !== undefined) {
      changes.maintenanceEnabled = dto.maintenanceEnabled;
    }
    if (dto.maintenanceMessage !== undefined) {
      const trimmed = dto.maintenanceMessage?.trim() ?? '';
      changes.maintenanceMessage = trimmed.length > 0 ? trimmed : null;
    }
    if (dto.minClientVersion !== undefined) {
      const wanted = dto.minClientVersion.trim();
      // A CEILING ON THE ONE CONTROL THAT CAN LOCK OUT EVERY CLIENT AT ONCE.
      //
      // The DTO already refuses anything that is not `major.minor.patch`, so the value reaching here
      // is well-formed - and well-formed is not the same as possible. `1.14.0` for `0.14.0` is a
      // single keystroke and demands a client newer than any that has ever been built, which no user
      // can satisfy by updating. Nothing checked it: v0.14.0's raise locked out every iOS user the
      // App Store had not reached (see docs/wiki/legacy-compatibility.md).
      //
      // WHAT THIS CATCHES AND WHAT IT CANNOT. Above the deployed version is always wrong, so it is
      // refused. AT or below is accepted, which does NOT make it safe - the real hazard is a raise
      // above what the app stores have actually shipped, and no server can see App Store review
      // state. This is a typo guard on a platform-wide switch, not a substitute for the shipping
      // order that page describes.
      const deployed = deployedVersion();
      if (deployed === null) {
        // ACCUSING, NOT INFORMATIONAL: the guard did not run, and the next lockout will be the first
        // anyone hears of it. Allowing is still right - an administrator asked for this explicitly,
        // and refusing every raise because a file could not be read would be a read failure
        // masquerading as a policy.
        this.logger.warn(
          `minClientVersion set to ${wanted} WITHOUT the deployed-version bound - package.json ` +
            `could not be read, so nothing verified that a client able to satisfy it exists`
        );
      } else if (compareSemver(wanted, deployed) > 0) {
        throw new BadRequestException(
          `minClientVersion ${wanted} is above this server's own version ${deployed}: no client ` +
            `that can satisfy it has been built, so every client would be locked out.`
        );
      }
      // THE RAISE ITSELF IS WORTH A LINE, and it used to share a `debug` with the payment provider.
      // Every client's access turns on this value; a change to it should not need log level tuning
      // to be found afterwards.
      if (wanted !== row.minClientVersion) {
        this.logger.warn(
          `minClientVersion ${row.minClientVersion} -> ${wanted} (deployed ${deployed ?? 'unknown'}) by=${by}`
        );
      }
      changes.minClientVersion = wanted;
    }
    if (dto.paymentProvider !== undefined) {
      changes.paymentProvider = dto.paymentProvider;
    }
    if (dto.callsMode !== undefined) {
      // THE KILL SWITCH MOVING IS WORTH A LINE OF ITS OWN, at warn like the min-version raise: every
      // call on the estate turns on it, and "who closed calls, when" must be in the log without
      // debug logging having been on.
      if (dto.callsMode !== row.callsMode) {
        this.logger.warn(`callsMode ${row.callsMode} -> ${dto.callsMode} by=${by}`);
      }
      changes.callsMode = dto.callsMode;
    }
    if (dto.livesMode !== undefined) {
      // Same reason as the calls switch: every live on the estate turns on it, so who opened or
      // closed lives, and when, is a warn line rather than a debug one.
      if (dto.livesMode !== row.livesMode) {
        this.logger.warn(`livesMode ${row.livesMode} -> ${dto.livesMode} by=${by}`);
      }
      changes.livesMode = dto.livesMode;
    }

    if (Object.keys(changes).length > 0) {
      const updated = await this.repo.update({ id: 1 }, changes);
      if (updated.affected !== 1) {
        // `ensureDefaults` made the row above, and nothing deletes it: a miss is a broken estate.
        this.logger.error(
          `Platform config update found no row affected=${updated.affected ?? 'unknown'}`
        );
        throw new Error('platform_config row missing');
      }
    }
    const saved = await this.repo.findOneOrFail({ where: { id: 1 } });
    this.logger.debug(
      `Platform config updated fields=${Object.keys(changes).join(',') || 'none'} maintenance=${saved.maintenanceEnabled} minClient=${saved.minClientVersion} paymentProvider=${saved.paymentProvider} callsMode=${saved.callsMode} livesMode=${saved.livesMode}`
    );
    if (dto.paymentProvider !== undefined) {
      if (dto.paymentProvider === 'disabled') {
        this.logger.warn(`paymentProvider -> disabled by=${by}`);
      } else {
        this.logger.warn(`paymentProvider -> ${dto.paymentProvider} by=${by}`);
        // EVERY PATCH THAT SETS AN ACTIVE PROVIDER ASKS, NOT ONLY A CHANGE: the release is idempotent.
        // A failure here is NOT repeated through this form (it only sends what changed, so a reload
        // sends no provider at all): `releaseWithheldProducts` is the explicit retry.
        await this.sweepWithheldProducts(toPublic(saved));
      }
    }
    return toPublic(saved);
  }

  /**
   * The administrator's explicit, idempotent "release withheld products" action: the retry for a
   * sweep that failed after the provider was saved, which never depends on the settings form's
   * diff. Refused with `PAYMENTS_DISABLED` while payments are off - nothing could be released then.
   */
  async releaseWithheldProducts(actor: string): Promise<WithheldReleaseResult> {
    const by = actor.slice(0, 8);
    const config = await this.getConfig();
    if (config.paymentProvider === 'disabled') {
      this.logger.warn(`withheld-products release refused: payments are disabled by=${by}`);
      throw new BadRequestException({
        statusCode: 400,
        code: PLATFORM_ERROR_CODES.PAYMENTS_DISABLED,
        message: 'Payments are disabled platform-wide; nothing can be released.',
      });
    }
    this.logger.warn(
      `withheld-products release asked by=${by} (provider=${config.paymentProvider})`
    );
    return this.sweepWithheldProducts(config);
  }

  /**
   * Tells social-service payments are on, so the boutique products withheld while they were
   * disabled go on sale (an event at the point the state changes, not a timer). Runs AFTER the save,
   * because social-service re-reads the provider from `payments/provider`. A failure is surfaced to
   * the administrator rather than swallowed, as a 502 carrying `WITHHELD_RELEASE_INCOMPLETE` and the
   * saved `config`: the provider IS switched, the release is what is missing.
   */
  private async sweepWithheldProducts(
    config: PlatformConfigPublic
  ): Promise<WithheldReleaseResult> {
    let result: WithheldReleaseResult;
    try {
      const { data } = await axios.post<WithheldReleaseResult>(providerActivatedUrl(), undefined, {
        ...internalSocialRequestConfig(),
        timeout: SOCIAL_RELEASE_TIMEOUT_MS,
      });
      this.logger.log(
        `provider activated: social-service released=${data.released} failed=${data.failed}`
      );
      if (data.failed > 0) {
        throw new Error(`${data.failed} association(s) could not be released`);
      }
      result = data;
    } catch (err: unknown) {
      this.logger.error(
        `provider active but the withheld products were NOT all released: ${describeHttpError(err)}`
      );
      throw new BadGatewayException({
        statusCode: 502,
        code: PLATFORM_ERROR_CODES.WITHHELD_RELEASE_INCOMPLETE,
        message:
          'Payment provider saved, but withheld products could not all be released; use the release action to retry.',
        config,
      });
    }
    return result;
  }

  /** True when maintenance is on and the caller is not a global admin. */
  isAccessBlockedByMaintenance(config: PlatformConfigPublic, isGlobalAdmin: boolean): boolean {
    return config.maintenanceEnabled && !isGlobalAdmin;
  }
}

function toPublic(row: PlatformConfig): PlatformConfigPublic {
  return {
    maintenanceEnabled: row.maintenanceEnabled,
    maintenanceMessage: row.maintenanceMessage,
    minClientVersion: row.minClientVersion,
    paymentProvider: row.paymentProvider,
    callsMode: row.callsMode,
    livesMode: row.livesMode,
  };
}
