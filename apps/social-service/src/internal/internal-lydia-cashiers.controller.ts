import {
  BadRequestException,
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import {
  LydiaCashiersService,
  type LydiaCashierRevokeTarget,
} from '../associations/lydia-cashiers.service';
import type { LydiaCashierNumber, LydiaCashierView } from '../associations/lydia-cashiers-list';
import { claimTokenOf } from '../associations/lydia-cashier-claim';
import { assertInternalSecret } from './internal-secret.util';

/** The text of a body field, trimmed; '' when absent or not a string. */
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** A row id from the body, or a 400. */
function cashierIdOf(body: { cashierId?: unknown } | undefined): string {
  const cashierId = text(body?.cashierId);
  if (!isUUID(cashierId)) throw new BadRequestException('cashierId is required');
  return cashierId;
}

/** The claim token of a body, or a 400. */
function claimTokenOrThrow(body: { claimToken?: unknown } | undefined): string {
  const token = claimTokenOf(body?.claimToken);
  if (!token) throw new BadRequestException('claimToken is required');
  return token;
}

/** `current` or `previous`, or a 400. */
function numberOf(body: { number?: unknown } | undefined): LydiaCashierNumber {
  if (body?.number === 'current' || body?.number === 'previous') return body.number;
  throw new BadRequestException('number must be current or previous');
}

/**
 * The internal routes of Lydia enrolment lot 3 - the cashiers beyond the Responsable, and removing
 * a number - called by core-service only (docs/wiki/frontend/modules/payments.md). Under
 * `/api/internal/`, which nginx does not route, `X-Internal-Secret` guarded and `no-store`. Phones
 * travel in the BODY (both ways), never a path, and nothing here logs one.
 */
@Controller('internal/associations')
export class InternalLydiaCashiersController {
  constructor(private readonly cashiers: LydiaCashiersService) {}

  /** The checks and claim before an add (`LydiaCashiersService.claimAdd`). */
  @Post(':id/lydia-cashier-add-claim')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async addClaim(
    @Headers('x-internal-secret') headerSecret: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { userId?: unknown; phone?: unknown; role?: unknown }
  ): Promise<{ vendorToken: string; claimToken: string }> {
    assertInternalSecret(headerSecret);
    const userId = text(body?.userId);
    if (!userId) throw new BadRequestException('userId is required');
    return this.cashiers.claimAdd(id, { userId, phone: text(body?.phone), role: text(body?.role) });
  }

  /** The checks and claim before a role change; answers the cashier's number for the re-add. */
  @Post(':id/lydia-cashier-role-claim')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async roleClaim(
    @Headers('x-internal-secret') headerSecret: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { cashierId?: unknown; role?: unknown }
  ): Promise<{ vendorToken: string; phone: string; userId: string; claimToken: string }> {
    assertInternalSecret(headerSecret);
    return this.cashiers.claimRoleChange(id, {
      cashierId: cashierIdOf(body),
      role: text(body?.role),
    });
  }

  /** Records an add or a role change Lydia answered (confirmed or not); releases the claim. */
  @Post(':id/lydia-cashier')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async record(
    @Headers('x-internal-secret') headerSecret: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: {
      vendorToken?: unknown;
      userId?: unknown;
      phone?: unknown;
      role?: unknown;
      addedByUserId?: unknown;
      confirmed?: unknown;
      cashierId?: unknown;
      claimToken?: unknown;
    }
  ): Promise<{ cashier: LydiaCashierView }> {
    assertInternalSecret(headerSecret);
    if (body?.cashierId !== undefined) cashierIdOf(body);
    return {
      cashier: await this.cashiers.record(id, {
        vendorToken: body?.vendorToken,
        userId: body?.userId,
        phone: body?.phone,
        role: body?.role,
        addedByUserId: body?.addedByUserId,
        confirmed: body?.confirmed,
        cashierId: body?.cashierId,
        claimToken: body?.claimToken,
      }),
    };
  }

  /** Releases a cashier operation's claim after a typed outcome core-service knows (its token). */
  @Post(':id/lydia-cashier-release')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async release(
    @Headers('x-internal-secret') headerSecret: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { claimToken?: unknown }
  ): Promise<{ ok: true; released: boolean }> {
    assertInternalSecret(headerSecret);
    return { ok: true, released: await this.cashiers.release(id, claimTokenOrThrow(body)) };
  }

  /**
   * The checks and claim before a removal; answers the number to remove and the confirmed
   * Responsable's number, both opened, and the claim token - for core-service alone.
   */
  @Post(':id/lydia-cashier-revoke-claim')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async revokeClaim(
    @Headers('x-internal-secret') headerSecret: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { cashierId?: unknown; number?: unknown }
  ): Promise<LydiaCashierRevokeTarget> {
    assertInternalSecret(headerSecret);
    return this.cashiers.claimRevoke(id, { cashierId: cashierIdOf(body), number: numberOf(body) });
  }

  /**
   * Records a removal's outcome (closed, or flagged when Lydia did not confirm it), under the claim
   * token, for the number core-service removed (`cashierPhone`, compared with the row's).
   */
  @Post(':id/lydia-cashier-revoke')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async recordRevoke(
    @Headers('x-internal-secret') headerSecret: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: {
      cashierId?: unknown;
      number?: unknown;
      verified?: unknown;
      actorId?: unknown;
      cashierPhone?: unknown;
      claimToken?: unknown;
    }
  ): Promise<{ ok: true }> {
    assertInternalSecret(headerSecret);
    if (typeof body?.verified !== 'boolean') throw new BadRequestException('verified is required');
    const cashierPhone = text(body?.cashierPhone);
    if (!cashierPhone) throw new BadRequestException('cashierPhone is required');
    await this.cashiers.recordRevoke(id, {
      cashierId: cashierIdOf(body),
      number: numberOf(body),
      verified: body.verified,
      actorId: text(body?.actorId),
      cashierPhone,
      claimToken: claimTokenOrThrow(body),
    });
    return { ok: true };
  }
}
