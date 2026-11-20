import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PaymentService } from './payment.service';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { assertCanManageAssociation } from './manage-permission';
import { LydiaCashierOps, type LydiaCashierNumber } from './lydia-cashier-ops';
import {
  LYDIA_CASHIER_ADD_DISABLED,
  LYDIA_CASHIER_ADD_ENABLED,
  LYDIA_CASHIER_PHONE_INVALID,
  LYDIA_CASHIER_PHONE_RE,
  LYDIA_RESPONSABLE_HANDOVER_DISABLED,
  LYDIA_RESPONSABLE_HANDOVER_ENABLED,
  LYDIA_UNREACHABLE,
  LydiaCashierAddedUnconfirmedException,
  type LydiaCashierRole,
} from './lydia-payment-provider';
import { RouteParams } from '../common/route-params';

/**
 * social-service's `code` of a member who is not (or no longer) a member, which the hand-over
 * answers too when its target left while Lydia was being asked (`libs/contracts`, `social`).
 */
export const LYDIA_CASHIER_NOT_A_MEMBER = 'LYDIA_CASHIER_NOT_A_MEMBER';
/**
 * social-service's `code` (equal to `social.responsableHandoverHeirNotPayoutManager` in the contract)
 * for an heir who no longer holds MANAGE_PAYOUT_ACCOUNT when the hand-over is recorded: core answers
 * it, typed, for the record's `heir-ineligible` outcome.
 */
export const LYDIA_RESPONSABLE_HANDOVER_HEIR_NOT_PAYOUT_MANAGER =
  'LYDIA_RESPONSABLE_HANDOVER_HEIR_NOT_PAYOUT_MANAGER';

/** social-service's `code` of a cashier operation refused while another holds the claim. */
const LYDIA_CASHIER_IN_FLIGHT = 'LYDIA_CASHIER_IN_FLIGHT';

/** What social-service's hand-over record answers (`LydiaCashiersService.recordHandover`). */
interface HandoverRecord {
  outcome: 'handed-over' | 'unconfirmed' | 'target-left' | 'heir-ineligible';
  cashierId: string;
  /** The number of row `cashierId` to remove next through the verified path, or none. */
  remove: LydiaCashierNumber | null;
}

/**
 * What core's ERROR advises when a hand-over's record failed AFTER Lydia added the number, by what
 * the record answered - the rows of payments.md's failure table. A TYPED refusal (a 4xx social-service
 * answered, passed on as an `HttpException` carrying its code) released the claim: the same hand-over
 * may be asked again at once. No answer (a 503, or anything else) kept the claim: a global admin
 * clears it first.
 */
export function recordFailureAdvice(err: unknown): string {
  const status = err instanceof HttpException ? err.getStatus() : null;
  if (status !== null && status >= 400 && status < 500) {
    const answer = (err as HttpException).getResponse();
    const code =
      answer && typeof answer === 'object' ? (answer as { code?: unknown }).code : undefined;
    return (
      `social-service refused the record (${typeof code === 'string' ? code : status}), the claim ` +
      `released - hand over again to the same member with the same number, or remove it in the ` +
      `Lydia Pro app`
    );
  }
  return (
    'social-service did not answer, the claim KEPT - a global admin clears it first ' +
    '(lydia-enrolment-clear), then hand over again to the same member with the same number, or ' +
    'remove it in the Lydia Pro app'
  );
}

/** The two roles a manager adds or switches between; the Responsable is lot 2's own step. */
function addableRole(value: unknown): Exclude<LydiaCashierRole, 'responsable'> | null {
  return value === 'tresorier' || value === 'vendeur' ? value : null;
}

/**
 * THE CASHIERS OF AN ASSOCIATION'S LYDIA BUSINESS BEYOND THE RESPONSABLE (Lydia enrolment lot 3,
 * docs/wiki/frontend/modules/payments.md): add a Tresorier or a Vendeur, change their role, remove
 * a number - for MANAGE_PAYOUT_ACCOUNT holders (the removal an account's erasure asks for is
 * `InternalLydiaCashiersController`, not routed by nginx). social-service holds the rows, the sealed numbers and the claim; Lydia is
 * called from here only. Adding and changing a role are behind {@link LYDIA_CASHIER_ADD_ENABLED}
 * (ON since 1.7.1, owner 2026-11-18); removing is never gated.
 */
@RouteParams({ associationId: 'uuid', cashierId: 'uuid' })
@Controller('payments')
export class LydiaCashiersController {
  private readonly logger = new Logger(LydiaCashiersController.name);
  private readonly ops: LydiaCashierOps;

  constructor(private readonly paymentService: PaymentService) {
    this.ops = new LydiaCashierOps(paymentService);
  }

  /** The owner's gate (ON since 1.7.1), read through a method so a spec can close it. */
  cashierAddEnabled(): boolean {
    return LYDIA_CASHIER_ADD_ENABLED;
  }

  /** Refuses with the typed 409 while adding cashiers is switched off: nothing reaches Lydia. */
  private assertAddEnabled(associationId: string): void {
    if (this.cashierAddEnabled()) return;
    this.logger.warn(`Lydia cashiers of ${associationId}: add refused - switched off`);
    throw new ConflictException({
      code: LYDIA_CASHIER_ADD_DISABLED,
      message: 'Adding cashiers is not open yet',
    });
  }

  /**
   * Adds a member as a Tresorier or a Vendeur (body `{ userId, phone, role }`, phone E.164, never
   * logged): social-service checks and claims, Lydia adds the role's EXACT rights with its SMS,
   * the read-back must match exactly; then the row is recorded - confirmed, or UNCONFIRMED once
   * Lydia answered the add and anything after it failed. Answers `{ cashier }`.
   */
  @Post('lydia-cashiers/:associationId')
  @UseGuards(NginxAuthGuard)
  @HttpCode(200)
  async addCashier(
    @Param('associationId') associationId: string,
    @Body() body: { userId?: unknown; phone?: unknown; role?: unknown },
    @Req() req: Request
  ) {
    await assertCanManageAssociation(req, associationId, this.logger);
    this.assertAddEnabled(associationId);
    const actorId = (req.headers['x-user-id'] as string | undefined)?.trim() ?? '';
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    const phone = typeof body?.phone === 'string' ? body.phone.trim() : '';
    const role = addableRole(body?.role);
    if (!userId || !role) throw new BadRequestException('userId and role are required');
    if (!LYDIA_CASHIER_PHONE_RE.test(phone)) {
      this.logger.warn(`Lydia cashiers of ${associationId}: add refused, phone not E.164`);
      throw new BadRequestException({
        code: LYDIA_CASHIER_PHONE_INVALID,
        message: 'The phone number must be written +33...',
      });
    }
    const { vendorToken, claimToken } = await this.ops.socialStep<{
      vendorToken: string;
      claimToken: string;
    }>(associationId, 'lydia-cashier-add-claim', { userId, phone, role });
    const confirmed = await this.addAtLydia(associationId, vendorToken, phone, role, claimToken);
    const data = await this.ops.socialStep<{ cashier: unknown }>(
      associationId,
      'lydia-cashier',
      {
        vendorToken,
        userId,
        phone,
        role,
        addedByUserId: actorId,
        confirmed: confirmed === true,
        claimToken,
      },
      true
    );
    if (confirmed !== true) throw confirmed;
    this.logger.log(`Lydia cashiers of ${associationId}: ${role} added`);
    return { ok: true, cashier: data?.cashier ?? null };
  }

  /**
   * Changes a Tresorier's or a Vendeur's role (body `{ role }`): a re-add of the same number with
   * the new set (Lydia REPLACES the rights), read back exactly, then recorded. Behind the same gate
   * as the add. Answers `{ cashier }`.
   */
  @Post('lydia-cashiers/:associationId/:cashierId/role')
  @UseGuards(NginxAuthGuard)
  @HttpCode(200)
  async changeRole(
    @Param('associationId') associationId: string,
    @Param('cashierId') cashierId: string,
    @Body() body: { role?: unknown },
    @Req() req: Request
  ) {
    await assertCanManageAssociation(req, associationId, this.logger);
    this.assertAddEnabled(associationId);
    const actorId = (req.headers['x-user-id'] as string | undefined)?.trim() ?? '';
    const role = addableRole(body?.role);
    if (!role) throw new BadRequestException('role is required');
    const pre = await this.ops.socialStep<{
      vendorToken: string;
      phone: string;
      userId: string;
      claimToken: string;
    }>(associationId, 'lydia-cashier-role-claim', { cashierId, role });
    const confirmed = await this.addAtLydia(
      associationId,
      pre.vendorToken,
      pre.phone,
      role,
      pre.claimToken
    );
    const data = await this.ops.socialStep<{ cashier: unknown }>(
      associationId,
      'lydia-cashier',
      {
        vendorToken: pre.vendorToken,
        userId: pre.userId,
        phone: pre.phone,
        role,
        addedByUserId: actorId,
        confirmed: confirmed === true,
        cashierId,
        claimToken: pre.claimToken,
      },
      true
    );
    if (confirmed !== true) throw confirmed;
    this.logger.log(`Lydia cashiers of ${associationId}: role changed to ${role}`);
    return { ok: true, cashier: data?.cashier ?? null };
  }

  /**
   * Asks Lydia for the add. Answers `true` (confirmed) or the `LydiaCashierAddedUnconfirmedException`
   * to throw AFTER recording the row unconfirmed. A refusal before the add answered is rethrown here:
   * a typed one releases the claim (nothing changed at Lydia); no usable answer keeps it, at ERROR,
   * until a global admin clears it - the add may have happened.
   */
  private async addAtLydia(
    associationId: string,
    vendorToken: string,
    phone: string,
    role: Exclude<LydiaCashierRole, 'responsable'>,
    claimToken: string
  ): Promise<true | LydiaCashierAddedUnconfirmedException> {
    try {
      await this.paymentService.addLydiaCashier(associationId, vendorToken, phone, role);
      return true;
    } catch (err: unknown) {
      if (err instanceof LydiaCashierAddedUnconfirmedException) {
        this.logger.error(
          `Lydia cashiers of ${associationId}: ${role} added at Lydia, UNCONFIRMED - recorded so`
        );
        return err;
      }
      await this.afterRefusedAdd(associationId, err, claimToken, role);
      throw err;
    }
  }

  /** The owner's gate on the hand-over (OFF), read through a method so a spec can open it. */
  responsableHandoverEnabled(): boolean {
    return LYDIA_RESPONSABLE_HANDOVER_ENABLED;
  }

  /**
   * HANDS THE RESPONSABLE OVER to another member (body `{ userId, phone }`, phone E.164, never logged;
   * owner, 2026-11-19). Asked by the live Responsable themselves or a platform admin, through the
   * cashier screens (so a MANAGE_PAYOUT_ACCOUNT holder too - social-service checks the identity
   * under its lock, 403 `LYDIA_RESPONSABLE_HANDOVER_FORBIDDEN`). The order never leaves the Business
   * without a confirmed Responsable - ADD FIRST, REMOVE SECOND:
   *
   * 1. social-service checks and CLAIMS (`lydia-responsable-handover-claim`: one cashier operation of
   *    the association at a time);
   * 2. Lydia adds the number with the 13 rights and its SMS, and `getpermission` reads them back
   *    (`addLydiaBusinessHolder`, the Responsable's own add);
   * 3. social-service RECORDS (`lydia-responsable-handover`): confirmed, the target becomes the live
   *    Responsable (a cashier heir's own row closed - promoted, owner 2026-11-20) and the old number
   *    the new row's other number; not confirmed, the old Responsable stays and the asked number is
   *    tracked - the claim released either way; a confirmed heir is told by a bell row;
   * 4. the number the record names is REMOVED through the verified path (`LydiaCashierOps.revoke`:
   *    its own claim, the removal, the re-read at 0 rights).
   *
   * A typed refusal before the add answered releases the claim (nothing changed at Lydia); no usable
   * answer to the add keeps it until a global admin clears it (the add may have happened); a record
   * that fails after the add keeps it when social did not answer (`socialStep` says so at ERROR),
   * and a TYPED refusal of the record after Lydia added the number leaves a holder no row names -
   * said at ERROR with the heir and the number's last two digits, and the way back (the same
   * hand-over again, same number; or the number removed in the Lydia app). Answers
   * `{ outcome: 'handed-over', previousNumberRemoved }` - a removal that did not confirm leaves the
   * old number flagged on the card for "Retirer cet autre numero", never a failed hand-over. Lydia's
   * unconfirmed rights are the add's typed error; a target who left meanwhile is the 409
   * `LYDIA_CASHIER_NOT_A_MEMBER`, their number removed.
   */
  @Post('lydia-cashiers/:associationId/responsable-handover')
  @UseGuards(NginxAuthGuard)
  @HttpCode(200)
  async handOverResponsable(
    @Param('associationId') associationId: string,
    @Body() body: { userId?: unknown; phone?: unknown },
    @Req() req: Request
  ) {
    await assertCanManageAssociation(req, associationId, this.logger);
    if (!this.responsableHandoverEnabled()) {
      this.logger.warn(`Lydia Responsable of ${associationId}: hand-over refused - switched off`);
      throw new ConflictException({
        code: LYDIA_RESPONSABLE_HANDOVER_DISABLED,
        message: 'Handing the Responsable over is not open yet',
      });
    }
    const actorId = (req.headers['x-user-id'] as string | undefined)?.trim() ?? '';
    const globalAdmin = req.headers['x-global-admin'] === 'true';
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    const phone = typeof body?.phone === 'string' ? body.phone.trim() : '';
    if (!userId) throw new BadRequestException('userId is required');
    if (!LYDIA_CASHIER_PHONE_RE.test(phone)) {
      this.logger.warn(`Lydia Responsable of ${associationId}: hand-over refused, phone not E.164`);
      throw new BadRequestException({
        code: LYDIA_CASHIER_PHONE_INVALID,
        message: 'The phone number must be written +33...',
      });
    }
    const pre = await this.ops.socialStep<{
      vendorToken: string;
      claimToken: string;
      previousResponsableId: string;
    }>(associationId, 'lydia-responsable-handover-claim', { actorId, globalAdmin, userId, phone });
    this.logger.log(
      `Lydia Responsable of ${associationId}: hand-over claimed, adding the new holder`
    );
    let added: true | LydiaCashierAddedUnconfirmedException;
    try {
      await this.paymentService.addLydiaBusinessHolder(associationId, pre.vendorToken, phone);
      added = true;
    } catch (err: unknown) {
      if (!(err instanceof LydiaCashierAddedUnconfirmedException)) {
        await this.afterRefusedAdd(associationId, err, pre.claimToken, 'hand-over');
        throw err;
      }
      this.logger.error(
        `Lydia Responsable of ${associationId}: hand-over add answered, rights UNCONFIRMED - ` +
          `the old Responsable stays, the number is tracked`
      );
      added = err;
    }
    let record: HandoverRecord;
    try {
      record = await this.ops.socialStep<HandoverRecord>(
        associationId,
        'lydia-responsable-handover',
        {
          vendorToken: pre.vendorToken,
          userId,
          phone,
          previousResponsableId: pre.previousResponsableId,
          actorId,
          confirmed: added === true,
          claimToken: pre.claimToken,
        },
        true
      );
    } catch (err: unknown) {
      // Lydia holds the number (every right, or unknown rights) and NO row names it. The way back
      // depends on what the record answered (payments.md, the failure table).
      this.logger.error(
        `Lydia Responsable of ${associationId}: hand-over NOT recorded after Lydia added the number ` +
          `(${added === true ? 'every right confirmed' : 'rights unconfirmed'}) - user ` +
          `${userId.slice(0, 8)}, phone ending ${phone.slice(-2)}, holds them with no row: ` +
          recordFailureAdvice(err)
      );
      throw err;
    }
    const removed = record.remove
      ? await this.removeAfterHandover(associationId, record.cashierId, record.remove, actorId)
      : null;
    // An heir refused at the record wins over Lydia's answer: their number is removed either way.
    if (record.outcome === 'target-left' || record.outcome === 'heir-ineligible') {
      const left = record.outcome === 'target-left';
      this.logger.warn(
        `Lydia Responsable of ${associationId}: hand-over not made - the new holder ` +
          `${left ? 'left meanwhile' : 'no longer manages the payout account'} (their number ` +
          `${removed ? 'removed' : 'NOT removed, flagged'})`
      );
      throw new ConflictException(
        left
          ? {
              code: LYDIA_CASHIER_NOT_A_MEMBER,
              message: 'The new Responsable is no longer a member of the association',
            }
          : {
              code: LYDIA_RESPONSABLE_HANDOVER_HEIR_NOT_PAYOUT_MANAGER,
              message: 'The new Responsable no longer manages the payout account',
            }
      );
    }
    if (added !== true) throw added;
    this.logger.log(
      `Lydia Responsable of ${associationId}: handed over; the old number ` +
        `${removed ? 'removed (0 rights)' : 'NOT removed yet - flagged on the card'}`
    );
    return { ok: true, outcome: record.outcome, previousNumberRemoved: removed === true };
  }

  /**
   * After an add that did NOT answer "added": a typed refusal (nothing changed at Lydia) releases
   * the claim; no usable answer keeps it, at ERROR, until a global admin clears it - the add may
   * have happened. Shared by the cashier add and the hand-over.
   */
  private async afterRefusedAdd(
    associationId: string,
    err: unknown,
    claimToken: string,
    what: string
  ): Promise<void> {
    const answer = err instanceof HttpException ? err.getResponse() : undefined;
    const code =
      answer && typeof answer === 'object' ? (answer as { code?: unknown }).code : undefined;
    if (err instanceof HttpException && code !== LYDIA_UNREACHABLE) {
      await this.ops.release(associationId, claimToken);
      return;
    }
    this.logger.error(
      `Lydia cashiers of ${associationId}: the ${what}'s add has an unknown outcome - the claim ` +
        `stays until a global admin clears it`
    );
  }

  /**
   * Removes number `number` of row `cashierId` right after a hand-over's record - the old
   * Responsable's number (`previous`), or a target's who left (`previous` when it was tracked on
   * the old Responsable, `current` on a promoted cashier's own row) - through the verified path. Answers whether
   * Lydia's re-read showed 0 rights. Never throws: the hand-over's own outcome is already recorded,
   * and every way this fails leaves the number on the card (flagged, or untried while another
   * operation held the claim - WARN), for "Retirer cet autre numero".
   */
  private async removeAfterHandover(
    associationId: string,
    cashierId: string,
    number: LydiaCashierNumber,
    actorId: string
  ): Promise<boolean> {
    try {
      await this.ops.revoke(associationId, cashierId, number, actorId);
      return true;
    } catch (err: unknown) {
      const answer = err instanceof HttpException ? err.getResponse() : undefined;
      const code =
        answer && typeof answer === 'object' ? (answer as { code?: unknown }).code : undefined;
      if (code === LYDIA_CASHIER_IN_FLIGHT) {
        this.logger.warn(
          `Lydia Responsable of ${associationId}: the replaced number's removal waits - another ` +
            `cashier operation is in flight; it stays on the card`
        );
      } else {
        this.logger.error(
          `Lydia Responsable of ${associationId}: the replaced number's removal failed ` +
            `(${typeof code === 'string' ? code : 'untyped'}) - it stays on the card`
        );
      }
      return false;
    }
  }

  /**
   * Removes a number of cashier `cashierId` (body `{ number: 'current' | 'previous' }`, `previous`
   * being a Responsable's old number after a number change). Live, not gated: it only takes rights
   * away. Answers `{ ok: true }` once Lydia's re-read shows 0 rights; otherwise the typed 502
   * `LYDIA_CASHIER_REVOKE_UNCONFIRMED`, the row kept and flagged.
   */
  @Post('lydia-cashiers/:associationId/:cashierId/revoke')
  @UseGuards(NginxAuthGuard)
  @HttpCode(200)
  async revokeCashier(
    @Param('associationId') associationId: string,
    @Param('cashierId') cashierId: string,
    @Body() body: { number?: unknown },
    @Req() req: Request
  ) {
    await assertCanManageAssociation(req, associationId, this.logger);
    const actorId = (req.headers['x-user-id'] as string | undefined)?.trim() ?? '';
    const number: LydiaCashierNumber = body?.number === 'previous' ? 'previous' : 'current';
    await this.ops.revoke(associationId, cashierId, number, actorId);
    return { ok: true };
  }
}
