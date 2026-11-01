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
  LYDIA_UNREACHABLE,
  LydiaCashierAddedUnconfirmedException,
  type LydiaCashierRole,
} from './lydia-payment-provider';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * (OFF until one production removal has been observed); removing is live.
 */
@Controller('payments')
export class LydiaCashiersController {
  private readonly logger = new Logger(LydiaCashiersController.name);
  private readonly ops: LydiaCashierOps;

  constructor(private readonly paymentService: PaymentService) {
    this.ops = new LydiaCashierOps(paymentService);
  }

  /** The owner's gate, read through a method so a spec can open it. */
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
    if (!UUID_RE.test(associationId)) throw new BadRequestException('Invalid associationId');
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
    if (!UUID_RE.test(associationId) || !UUID_RE.test(cashierId)) {
      throw new BadRequestException('Invalid id');
    }
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
      const answer = err instanceof HttpException ? err.getResponse() : undefined;
      const code =
        answer && typeof answer === 'object' ? (answer as { code?: unknown }).code : undefined;
      if (err instanceof HttpException && code !== LYDIA_UNREACHABLE) {
        await this.ops.release(associationId, claimToken);
      } else {
        this.logger.error(
          `Lydia cashiers of ${associationId}: the add's outcome is unknown - the claim stays ` +
            `until a global admin clears it`
        );
      }
      throw err;
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
    if (!UUID_RE.test(associationId) || !UUID_RE.test(cashierId)) {
      throw new BadRequestException('Invalid id');
    }
    await assertCanManageAssociation(req, associationId, this.logger);
    const actorId = (req.headers['x-user-id'] as string | undefined)?.trim() ?? '';
    const number: LydiaCashierNumber = body?.number === 'previous' ? 'previous' : 'current';
    await this.ops.revoke(associationId, cashierId, number, actorId);
    return { ok: true };
  }
}
