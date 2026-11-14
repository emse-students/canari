import axios from 'axios';
import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PlatformConfig } from './entities/platform-config.entity';
import {
  LydiaContractInvalid,
  bandOf,
  contractYearOf,
  parisDate,
  parseAnniversary,
  parseLydiaContractTerms,
  type ContractYear,
  type LydiaBand,
  type LydiaContractSettings,
  type LydiaContractTerms,
} from './lydia-contract';
import { describeHttpError } from '../common/http-error-log';
import { internalSocialRequestConfig, lydiaFluxUrl } from '../payment/social-internal-client';

/** The log tag of every line about the platform's Lydia contract. */
export const LYDIA_CONTRACT_LOG_TAG = '[LYDIA-CONTRACT]';

/** Same budget as the sibling core -> social-service calls. */
const SOCIAL_FLUX_TIMEOUT_MS = 15_000;

/** What social-service measures over a contract year (`measureLydiaFlux`), cents TTC. */
export interface LydiaFluxMeasure {
  paidCents: number;
  paymentCount: number;
  refundedCents: number;
  refundCount: number;
  fluxCents: number;
  excludedCents: number;
  excludedCount: number;
  untraceableCount: number;
}

/**
 * What a price editor's payout estimate needs: the fee of a payment Canari issues (`remote`, HT) and
 * the VAT that makes it what is deducted - or `null`, not configured, and the estimate says so.
 */
export type LydiaFeeSchedule = { percentBps: number; fixedCents: number; vatBps: number } | null;

/** The admin counter: the contract year, its flux against the target, and the band it falls in. */
export interface LydiaContractCounter {
  /** Today in Paris, `YYYY-MM-DD`. */
  today: string;
  /** Null when the anniversary is not configured, or today is before it. */
  year: ContractYear | null;
  /** Null when there is no year to measure. */
  flux: LydiaFluxMeasure | null;
  /** Null when not configured. */
  targetCents: number | null;
  /** The band the flux falls in (null below every band, or with no bands entered). */
  band: (LydiaBand & { index: number }) | null;
  /** The next band up, if any. */
  nextBand: (LydiaBand & { index: number }) | null;
  /** What is missing for a full counter: `anniversary`, `target`, `bands`. Empty = complete. */
  missing: Array<'anniversary' | 'target' | 'bands'>;
}

/**
 * The platform's Lydia contract terms - read and written by a global admin, read for the payout
 * estimate - and the counter of the contract year's flux (docs/wiki/lydia-contract-flux.md). The
 * terms live on the `platform_config` singleton row (migration 024) and are never part of
 * `PlatformConfigPublic`, which `GET /api/version` publishes.
 */
@Injectable()
export class LydiaContractService {
  private readonly logger = new Logger(LydiaContractService.name);

  constructor(
    @InjectRepository(PlatformConfig)
    private readonly repo: Repository<PlatformConfig>
  ) {}

  /** The terms as stored. A stored value that no longer parses is an ERROR and reads as unset. */
  async getSettings(): Promise<LydiaContractSettings> {
    const row = await this.repo.findOne({
      where: { id: 1 },
      select: { id: true, lydiaContractAnniversary: true, lydiaContract: true },
    });
    let terms: LydiaContractTerms;
    try {
      terms = parseLydiaContractTerms(row?.lydiaContract ?? null);
    } catch (err: unknown) {
      // Only `putSettings` writes it, through the same parse: a refusal here is a hand edit.
      this.logger.error(
        `${LYDIA_CONTRACT_LOG_TAG} the stored terms do not parse (${(err as Error).message}) - read as NOT CONFIGURED`
      );
      terms = parseLydiaContractTerms(null);
    }
    return { anniversary: row?.lydiaContractAnniversary ?? null, ...terms };
  }

  /**
   * Replaces the terms with what a global admin sent - the whole set, parsed first: a 400 naming the
   * field writes nothing. The actor is logged, never a value (the terms are confidential).
   */
  async putSettings(raw: unknown, actor: string): Promise<LydiaContractSettings> {
    const by = actor.slice(0, 8);
    let anniversary: string | null;
    let terms: LydiaContractTerms;
    try {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new LydiaContractInvalid('body', 'must be an object');
      }
      const body = raw as Record<string, unknown>;
      anniversary = parseAnniversary(body.anniversary);
      terms = parseLydiaContractTerms({
        fluxTargetCents: body.fluxTargetCents,
        vatBps: body.vatBps,
        fees: body.fees,
        bands: body.bands,
      });
    } catch (err: unknown) {
      if (err instanceof LydiaContractInvalid) {
        this.logger.warn(`${LYDIA_CONTRACT_LOG_TAG} terms refused (${err.field}) by=${by}`);
        throw new BadRequestException({
          statusCode: 400,
          code: 'LYDIA_CONTRACT_INVALID',
          field: err.field,
          message: err.message,
        });
      }
      throw err;
    }
    const updated = await this.repo.update(
      { id: 1 },
      { lydiaContractAnniversary: anniversary, lydiaContract: terms as object }
    );
    if (updated.affected !== 1) {
      this.logger.error(`${LYDIA_CONTRACT_LOG_TAG} terms update found no platform_config row`);
      throw new Error('platform_config row missing');
    }
    this.logger.warn(
      `${LYDIA_CONTRACT_LOG_TAG} terms replaced by=${by}: anniversary=${anniversary ? 'set' : 'unset'} ` +
        `target=${terms.fluxTargetCents === null ? 'unset' : 'set'} vat=${terms.vatBps === null ? 'unset' : 'set'} ` +
        `fees=[${Object.keys(terms.fees).join(',')}] bands=${terms.bands.length}`
    );
    return this.getSettings();
  }

  /**
   * The fee schedule a price editor's estimate applies: the `remote` fee and the VAT. Not configured
   * is `null`, logged at WARN - every estimate drawn meanwhile is missing (a signal, never a default).
   */
  async feeSchedule(): Promise<LydiaFeeSchedule> {
    const settings = await this.getSettings();
    const remote = settings.fees.remote;
    if (!remote || settings.vatBps === null) {
      this.logger.warn(
        `${LYDIA_CONTRACT_LOG_TAG} fee schedule asked while NOT CONFIGURED ` +
          `(remote fee ${remote ? 'set' : 'unset'}, VAT ${settings.vatBps === null ? 'unset' : 'set'}): ` +
          `no payout estimate can be drawn`
      );
      return null;
    }
    return {
      percentBps: remote.percentBps,
      fixedCents: remote.fixedCents,
      vatBps: settings.vatBps,
    };
  }

  /**
   * The counter of the current contract year: social-service measures the flux of the year the
   * anniversary puts today in; the band is the one that flux falls in. A missing value is named in
   * `missing` and logged at WARN; a failed measure is a 502, never a zero.
   */
  async counter(now: Date = new Date()): Promise<LydiaContractCounter> {
    const settings = await this.getSettings();
    const today = parisDate(now);
    const missing: LydiaContractCounter['missing'] = [];
    if (!settings.anniversary) missing.push('anniversary');
    if (settings.fluxTargetCents === null) missing.push('target');
    if (settings.bands.length === 0) missing.push('bands');
    if (missing.length > 0) {
      this.logger.warn(
        `${LYDIA_CONTRACT_LOG_TAG} counter read while NOT CONFIGURED: missing ${missing.join(',')}`
      );
    }
    const year = settings.anniversary ? contractYearOf(settings.anniversary, today) : null;
    if (settings.anniversary && !year) {
      this.logger.log(`${LYDIA_CONTRACT_LOG_TAG} counter: today is before the first anniversary`);
    }
    const flux = year ? await this.measure(year.start, year.end) : null;
    const { index, next } = flux
      ? bandOf(settings.bands, flux.fluxCents)
      : { index: null, next: null };
    return {
      today,
      year,
      flux,
      targetCents: settings.fluxTargetCents,
      band: index === null ? null : { ...settings.bands[index], index },
      nextBand: next === null ? null : { ...settings.bands[next], index: next },
      missing,
    };
  }

  private async measure(from: string, to: string): Promise<LydiaFluxMeasure> {
    try {
      const { data } = await axios.get<LydiaFluxMeasure>(lydiaFluxUrl(from, to), {
        ...internalSocialRequestConfig(),
        timeout: SOCIAL_FLUX_TIMEOUT_MS,
      });
      return data;
    } catch (err: unknown) {
      this.logger.error(
        `${LYDIA_CONTRACT_LOG_TAG} the flux of [${from}, ${to}) could not be measured: ${describeHttpError(err)}`
      );
      throw new BadGatewayException({
        statusCode: 502,
        code: 'LYDIA_FLUX_UNREADABLE',
        message: 'The flux could not be measured',
      });
    }
  }
}
