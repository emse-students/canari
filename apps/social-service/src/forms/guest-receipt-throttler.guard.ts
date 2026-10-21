import { Injectable } from '@nestjs/common';
import { ClientIpThrottlerGuard } from '../common/guards/client-ip-throttler.guard';
import { hashGuestReceipt, isGuestReceiptShape } from './guest-receipt';

/**
 * The guest return page's throttle, counted per RECEIPT - the guest twin of the member's
 * `UserResourceThrottlerGuard` on `confirm-payment` (per user AND submission).
 *
 * What the limit protects is the platform's Lydia reads: each confirmation of a pending answer
 * spends one. Only a receipt that MATCHES a row reaches Lydia, so the bucket that matters is the
 * receipt's - keyed on its hash, never on the receipt itself (the tracker lives in memory and may be
 * logged; the hash is what the database already holds). Counted per receipt, a guest behind an event
 * hall's shared address does not share a bucket with the room.
 *
 * A body with no receipt-shaped string reaches no row and no provider, so it is counted on the
 * VISITOR (`ClientIpThrottlerGuard`), which bounds what a script can make this service look up.
 */
@Injectable()
export class GuestReceiptThrottlerGuard extends ClientIpThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    const receipt: unknown = req.body?.receipt;
    if (isGuestReceiptShape(receipt)) return `receipt:${hashGuestReceipt(receipt)}`;
    return `visitor:${await super.getTracker(req)}`;
  }
}
