import {
  BadGatewayException,
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { clientAddress } from '../common/client-address';
import { ClientIpThrottlerGuard } from '../common/guards/client-ip-throttler.guard';
import { GuestReceiptDto, GuestSubmitFormDto } from './dto/form.dto';
import { CONFIRM_PAYMENT_PER_MINUTE } from './forms.controller';
import { FormsService } from './forms.service';
import type { GuestReceiptView } from './guest-receipt';
import { GuestReceiptThrottlerGuard } from './guest-receipt-throttler.guard';

/**
 * A PUBLIC FORM, ANSWERED WITHOUT AN ACCOUNT (user, 2026-09-30) - the two routes a guest on a
 * shared link calls, under `/api/public/`, where nginx strips every identity header.
 *
 * There is no captcha: the edge that offered one is gone, and the user chose a throttle and a
 * honeypot instead. The throttle counts per visitor, and that visitor is an ADDRESS: a room of
 * guests behind one NAT - a school network at an event - shares it, which is why the limit sits
 * well above what one person types and bounds only what a script can make this service store.
 */
@Controller('public/forms')
export class PublicFormsController {
  private readonly logger = new Logger(PublicFormsController.name);

  constructor(private readonly service: FormsService) {}

  /** The questions of a public form. Unthrottled: a database read, as the post preview JSON is. */
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getPublic(id);
  }

  /**
   * One guest answer. The reply is an ALLOWLIST (`toGuestSubmitReply`): that it was taken and, when
   * the form charges, where to pay (Lydia's payer page) or that cash is owed. Never a submission id
   * or anything else the service answers beside it.
   */
  @UseGuards(ClientIpThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':id/submit')
  @HttpCode(200)
  async submit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GuestSubmitFormDto,
    @Req() req: Request
  ) {
    // A filled honeypot is answered exactly like a real answer, so the bot learns nothing, and
    // logged, so a rise in them is seen rather than guessed.
    if (dto.website) {
      this.logger.warn(`[FORMS] guest answer dropped by the honeypot form=${id.slice(0, 8)}`);
      return { ok: true };
    }
    const result = await this.service.submit(
      id,
      { answers: dto.answers, payerEmail: dto.payerEmail, paymentMethod: dto.paymentMethod },
      'guest',
      // The visitor a paid answer is counted against (PP5): the address the throttle counts too.
      clientAddress(req)
    );
    const reply = toGuestSubmitReply(result);
    this.logger.log(
      `[FORMS] guest answer stored form=${id.slice(0, 8)} ` +
        (reply.checkoutUrl ? 'online payment issued' : reply.cashPayment ? 'cash owed' : 'free')
    );
    return reply;
  }

  /**
   * THE GUEST RETURN PAGE (WP-P2): where a paid guest answer stands, confirmed at Lydia server to
   * server, for whoever holds its RECEIPT - the proof a guest has instead of a session
   * (`guest-receipt.ts`). The receipt travels in the body, so it stays out of the access logs. An
   * unknown receipt and a malformed one are the same 404. Throttled per receipt
   * (`GuestReceiptThrottlerGuard`) at the member's own confirmation rate: the page polls ten times,
   * three seconds apart, and each read of a pending answer spends one Lydia call.
   */
  @UseGuards(GuestReceiptThrottlerGuard)
  @Throttle({ default: { limit: CONFIRM_PAYMENT_PER_MINUTE, ttl: 60_000 } })
  @Post('receipts/confirm')
  @HttpCode(200)
  confirmReceipt(@Body() dto: GuestReceiptDto): Promise<GuestReceiptView> {
    return this.service.confirmGuestReceipt(dto.receipt);
  }
}

/** What a guest is answered after a submit: these fields and nothing else. */
export interface GuestSubmitReply {
  ok: true;
  /** Lydia's payer page, when the answer is paid online. */
  checkoutUrl?: string;
  /** The answer is recorded and its price is owed in cash to the organiser. */
  cashPayment?: true;
  /** With `cashPayment`: the reference the guest gives the organiser (`guestReference`). */
  reference?: string;
}

/**
 * Picks the guest's reply out of `FormsService.submit`'s result. A paid answer whose request was
 * not issued (`submit` answers a `message` and has released the row) was NOT taken: it is a 502,
 * rather than a guest reading that an answer nobody can pay for was recorded.
 */
export function toGuestSubmitReply(result: {
  /** Read by nobody here: named so every shape `submit` answers is one this accepts. */
  submissionId?: string;
  checkoutUrl?: string;
  cashPayment?: boolean;
  reference?: string;
  message?: string;
}): GuestSubmitReply {
  if (result.message && !result.checkoutUrl) {
    throw new BadGatewayException('The payment request could not be created.');
  }
  return {
    ok: true,
    ...(result.checkoutUrl ? { checkoutUrl: result.checkoutUrl } : {}),
    ...(result.cashPayment
      ? { cashPayment: true as const, ...(result.reference ? { reference: result.reference } : {}) }
      : {}),
  };
}
