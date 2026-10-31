import {
  BadGatewayException,
  HttpException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import axios from 'axios';
import type { PaymentService } from './payment.service';
import { internalSocialRequestConfig } from './social-internal-client';
import { socialUrl } from '../internal/service-urls';
import { describeHttpError } from '../common/http-error-log';
import { LYDIA_CASHIER_REVOKE_UNCONFIRMED } from './lydia-payment-provider';

/** Which number of a cashier row a removal is about: its own, or a Responsable's old one. */
export type LydiaCashierNumber = 'current' | 'previous';

/** How long one social-service step of a cashier operation may take. */
const SOCIAL_STEP_TIMEOUT_MS = 10_000;

/** The internal social-service route of association `associationId` named `suffix`. */
export function cashierSocialUrl(associationId: string, suffix: string): string {
  return socialUrl(`internal/associations/${encodeURIComponent(associationId)}/${suffix}`);
}

/**
 * THE STEPS OF A LYDIA CASHIER OPERATION THAT TALK TO SOCIAL-SERVICE (lot 3), shared by the
 * Responsable's route (`PaymentController`) and the cashiers' routes (`LydiaCashiersController`).
 * Not a provider: built from the `PaymentService` its controller already holds.
 */
export class LydiaCashierOps {
  private readonly logger = new Logger(LydiaCashierOps.name);

  constructor(private readonly paymentService: PaymentService) {}

  /**
   * One social-service call. A 4xx is social-service's ANSWER (a typed refusal) and is passed on as
   * it was given; a 5xx or no answer is a 503 logged at ERROR, never a bare 500. `afterLydia` says
   * the call came after Lydia changed something, which the log line must say.
   */
  async socialStep<T>(
    associationId: string,
    step: string,
    body: unknown,
    afterLydia = false
  ): Promise<T> {
    try {
      return (
        await axios.post<T>(cashierSocialUrl(associationId, step), body, {
          ...internalSocialRequestConfig(),
          timeout: SOCIAL_STEP_TIMEOUT_MS,
        })
      ).data;
    } catch (err: unknown) {
      const answer = (err as { response?: { status?: unknown; data?: unknown } }).response;
      if (typeof answer?.status === 'number' && answer.status >= 400 && answer.status < 500) {
        this.logger.warn(
          `Lydia cashiers of ${associationId}: social-service refused ${step} (${answer.status})`
        );
        throw new HttpException(answer.data as Record<string, unknown>, answer.status);
      }
      this.logger.error(
        `Lydia cashiers of ${associationId}: ${step} at social-service failed` +
          (afterLydia
            ? ' AFTER Lydia changed - the claim stays until a global admin clears it'
            : ''),
        describeHttpError(err as Error)
      );
      throw new ServiceUnavailableException('The association service could not be reached');
    }
  }

  /**
   * Releases the claim `claimToken` after an outcome core KNOWS (social-service clears it only while
   * it still carries that token); a failure is ERROR and never replaces the answer.
   */
  async release(associationId: string, claimToken: string): Promise<void> {
    try {
      await this.socialStep(associationId, 'lydia-cashier-release', { claimToken });
    } catch {
      this.logger.error(
        `Lydia cashiers of ${associationId}: the claim could not be released - a global admin clears it`
      );
    }
  }

  /**
   * REMOVES ONE NUMBER of cashier row `cashierId` at Lydia, and proves it: social-service checks
   * and claims (`lydia-cashier-revoke-claim`: the row, the Responsable's current number refused,
   * the numbers opened under the claim's lock), the removal preconditions are checked
   * (`LYDIA_CASHIER_REMOVAL_PRECONDITION` otherwise, nothing changed), Lydia is asked to remove the
   * number, and its re-read decides (`removeCashier`). Only 0
   * rights is a removal: the row is closed (`current`) or the old number cleared (`previous`).
   * Anything else is recorded as a removal NOT confirmed - the row stays live, flagged - and answered
   * 502 `LYDIA_CASHIER_REVOKE_UNCONFIRMED`, at ERROR. Repeating a removal is safe, so every outcome
   * releases the claim (the record does it, for the number removed only); a refusal before any
   * change at Lydia releases it too.
   */
  async revoke(
    associationId: string,
    cashierId: string,
    number: LydiaCashierNumber,
    actorId: string
  ): Promise<void> {
    this.logger.log(`Lydia cashiers of ${associationId}: removal of a ${number} number asked`);
    const target = await this.socialStep<{
      vendorToken: string;
      cashierPhone: string;
      contextPhone: string;
      claimToken: string;
    }>(associationId, 'lydia-cashier-revoke-claim', { cashierId, number });
    let removal: { verified: boolean; held: number | null };
    try {
      removal = await this.paymentService.removeLydiaCashier(
        associationId,
        target.vendorToken,
        target.contextPhone,
        target.cashierPhone
      );
    } catch (err: unknown) {
      // Refused before any change (no Provider key, a malformed number, a precondition not met):
      // nothing changed at Lydia.
      await this.release(associationId, target.claimToken);
      throw err;
    }
    await this.socialStep(
      associationId,
      'lydia-cashier-revoke',
      {
        cashierId,
        number,
        verified: removal.verified,
        actorId,
        cashierPhone: target.cashierPhone,
        claimToken: target.claimToken,
      },
      true
    );
    if (!removal.verified) {
      this.logger.error(
        `Lydia cashiers of ${associationId}: removal of a ${number} number NOT confirmed ` +
          `(held=${String(removal.held)}) - the row stays live, flagged`
      );
      throw new BadGatewayException({
        code: LYDIA_CASHIER_REVOKE_UNCONFIRMED,
        message: 'Lydia did not confirm the removal; trying again is safe',
      });
    }
    this.logger.log(`Lydia cashiers of ${associationId}: removal of a ${number} number confirmed`);
  }
}
