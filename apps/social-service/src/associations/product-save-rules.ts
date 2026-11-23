import { BadRequestException } from '@nestjs/common';
import {
  amountOutOfRange,
  PROVIDER_MAX_AMOUNT_CENTS,
  PROVIDER_MIN_AMOUNT_CENTS,
} from '../common/core-payment-error';

/**
 * The body `code` of the 400 a product save gets when nothing would price it: no fixed amount, no
 * free amount, no grid. Decided HERE, at the save, because the checkout of such a product could only
 * answer a bare 400 to a buyer (`product-save-rules.ts`, wiki: payments).
 */
export const PRODUCT_HAS_NO_PRICE = 'PRODUCT_HAS_NO_PRICE';

/** The log surface a refusal needs: the service passes its own `Logger`. */
interface WarnLogger {
  warn(message: string): void;
}

/** What prices a product: the three mechanisms, each of which alone is enough. */
export interface ProductPricingShape {
  type: string;
  amountCents: number | null | undefined;
  allowCustomAmount: boolean | null | undefined;
  priceMatrix: unknown;
}

/**
 * Whether something prices the product: a fixed amount, a free amount or a grid. A membership
 * product is always read as priced here: its tiers have their own ranking (`rankPriceCents`).
 */
export function productHasPrice(p: ProductPricingShape): boolean {
  return (
    p.type === 'membership' ||
    p.amountCents != null ||
    p.allowCustomAmount === true ||
    p.priceMatrix != null
  );
}

/**
 * Refuses (typed 400 `PRODUCT_HAS_NO_PRICE`) a product that nothing prices: no fixed `amountCents`,
 * no free amount (`allowCustomAmount`) and no `priceMatrix`. A membership product is out of this
 * rule: its tiers have their own ranking (`rankPriceCents`: the unpriced base tier ranks lowest, a
 * named tier with no price is refused where a rank is needed - `TIER_NOT_RANKABLE`).
 */
export function assertProductHasPrice(
  p: ProductPricingShape,
  logger: WarnLogger,
  what: 'create' | 'update'
): void {
  if (productHasPrice(p)) return;
  logger.warn(`[SHOP] product ${what} refused: no amount, no free amount and no price grid`);
  throw new BadRequestException({
    code: PRODUCT_HAS_NO_PRICE,
    message: 'A product needs a fixed price, a free amount or a price grid',
  });
}

/**
 * Refuses (typed 400 `AMOUNT_OUT_OF_RANGE`, carrying the payable range) a free-amount bound the
 * payment provider could never take: a buyer would be allowed by the product and refused at
 * checkout. Only a bound the request SETS is judged (`null` / `undefined` are not), so a product
 * saved before this rule stays editable.
 */
export function assertCustomBoundsPayable(
  bounds: { customAmountMinCents?: number | null; customAmountMaxCents?: number | null },
  logger: WarnLogger
): void {
  const { customAmountMinCents, customAmountMaxCents } = bounds;
  for (const [field, value] of Object.entries({ customAmountMinCents, customAmountMaxCents })) {
    if (value == null) continue;
    if (value >= PROVIDER_MIN_AMOUNT_CENTS && value <= PROVIDER_MAX_AMOUNT_CENTS) continue;
    logger.warn(
      `[SHOP] free-amount bound refused: ${field}=${value} outside the payable ${PROVIDER_MIN_AMOUNT_CENTS}-${PROVIDER_MAX_AMOUNT_CENTS} cents`
    );
    throw amountOutOfRange(
      PROVIDER_MIN_AMOUNT_CENTS,
      PROVIDER_MAX_AMOUNT_CENTS,
      `${field} must be between ${PROVIDER_MIN_AMOUNT_CENTS} and ${PROVIDER_MAX_AMOUNT_CENTS} cents`
    );
  }
}
