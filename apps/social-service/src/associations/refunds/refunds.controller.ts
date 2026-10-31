import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { NginxAuthGuard } from '../../common/guards/nginx-auth.guard';
import { UserResourceThrottlerGuard } from '../../common/guards/user-resource-throttler.guard';
import { RefundsService, type RefundInput } from './refunds.service';
import { parseStatementLabels } from './statement-labels';

/**
 * The refund routes (enrolment chantier lot 4). Every one is for a `MANAGE_PAYOUT_ACCOUNT` holder of
 * the association whose Lydia Business took the payment (`RefundsService.assertPayoutManager`), the
 * permission of every other Lydia route - not `MANAGE_PRODUCTS`, which the purchases list asks.
 * Kept in its own controller so this lot touches none of `AssociationsController`'s routes.
 */
@Controller('associations')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  /** Per payment of the purchases list: refundable or why not, and every refund with its state. */
  @UseGuards(NginxAuthGuard)
  @Get(':id/refunds')
  async describe(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Param('id', ParseUUIDPipe) id: string
  ) {
    await this.refunds.assertPayoutManager(userId, id, ga === 'true');
    return this.refunds.describe(id);
  }

  /**
   * Refunds a payment: `{ kind: 'total' | 'partial', amountCents?, reason, idempotencyKey }`. The key
   * is a uuid the dialog draws once, so a resent click answers the same refund and sends nothing.
   */
  @UseGuards(NginxAuthGuard, UserResourceThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/purchases/:purchaseId/refunds')
  @HttpCode(200)
  async refund(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('purchaseId', ParseUUIDPipe) purchaseId: string,
    @Body() body: RefundInput
  ) {
    await this.refunds.assertPayoutManager(userId, id, ga === 'true');
    return this.refunds.refund(id, purchaseId, userId, body);
  }

  /**
   * Settles a refund Lydia never confirmed, after the manager read Lydia's own statement:
   * `{ refunded: boolean }`.
   */
  @UseGuards(NginxAuthGuard)
  @Post(':id/refunds/:refundId/resolve')
  @HttpCode(200)
  async resolve(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('refundId', ParseUUIDPipe) refundId: string,
    @Body() body: { refunded?: unknown }
  ) {
    await this.refunds.assertPayoutManager(userId, id, ga === 'true');
    return this.refunds.resolve(id, refundId, userId, body?.refunded === true);
  }

  /**
   * The association's statement - payments and refunds with totals - as a CSV download, written in
   * the client's words (`labels`, a JSON object; refused `export-labels` without them).
   */
  @UseGuards(NginxAuthGuard)
  @Get(':id/statement.csv')
  async statement(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('labels') rawLabels: string | undefined,
    @Res() res: Response
  ) {
    await this.refunds.assertPayoutManager(userId, id, ga === 'true');
    const labels = parseStatementLabels(rawLabels);
    const csv = await this.refunds.statementCsv(id, labels);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="statement.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(csv);
  }
}
