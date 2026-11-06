import { BadRequestException } from '@nestjs/common';
import {
  bucketFor,
  dimensionsNeedProfile,
  findOverlappingBuckets,
  type Dimension,
  type PricingFacts,
} from '../pricing/audience';
import { parseDimension, type CriteriaContext } from '../pricing/validate';
import {
  PRODUCT_GRID_ALL_TIER,
  PRODUCT_GRID_TYPE,
  parseProductGridAnswer,
  productGridItemRefusal,
  productGridLines,
  productGridView,
  type ProductGrid,
  type ProductGridAnswer,
  type ProductGridAnswerCode,
  type ProductGridDefinitionCode,
  type ProductGridLine,
  type ProductGridPrices,
  type ProductGridRefusal,
  type ProductGridTiers,
  type ProductGridViewerPrices,
} from './product-grid-contract';

/**
 * THE PRICED GRID ON THE SERVER: what a save stores, what a page is told, what a submit charges.
 *
 * The rules both sides read are the contract's (`product-grid-contract.ts`); this file adds what
 * only the server can do - judge a tier criterion against the association, place a person in a
 * category from their profile, and turn an answer into the lines `FormsService.submit` charges and
 * snapshots into `submissions.lines` (migration 137).
 */

/** A stored `product_grid` question, as the readers here need it. */
export interface ProductGridItem {
  id: string;
  type: typeof PRODUCT_GRID_TYPE;
  label: string;
  required: true;
  productGrid: ProductGrid;
}

/** Whether a stored or sent question is a priced grid. */
export function isProductGridItem(item: { type?: string }): item is ProductGridItem {
  return item.type === PRODUCT_GRID_TYPE;
}

/** A form's priced grids, in question order. */
export function productGridItems(items: readonly { type?: string }[] | null | undefined) {
  return (items ?? []).filter(isProductGridItem);
}

/** The tier criteria of a form's grids. */
function tierDimensions(items: readonly { type?: string }[] | null | undefined): Dimension[] {
  return productGridItems(items)
    .map((item) => item.productGrid?.pricing?.tiers)
    .filter((tiers): tiers is ProductGridTiers => !!tiers) as unknown as Dimension[];
}

/** Whether a grid prices on a promo or a formation, so its facts need the identity provider. */
export function productGridsNeedProfile(items: readonly { type?: string }[] | null | undefined) {
  return dimensionsNeedProfile(tierDimensions(items));
}

/** Whether a grid sent for saving prices on a cotisation, so the save needs the association's tiers. */
export function productGridsNameCotisation(items: readonly unknown[] | null | undefined): boolean {
  return (items ?? []).some((item) => {
    const tiers = (item as { type?: string; productGrid?: { pricing?: { tiers?: unknown } } })
      ?.productGrid?.pricing?.tiers as { kind?: unknown } | null | undefined;
    return isProductGridItem(item as { type?: string }) && tiers?.kind === 'cotisation';
  });
}

/**
 * The dev-facing sentence beside each code. The editor and the fill page word their own from the
 * CODE through Paraglide, never from this text.
 */
const MESSAGES: Record<ProductGridDefinitionCode | ProductGridAnswerCode, string> = {
  PRODUCT_GRID_DEFINITION_MISSING:
    'A product grid question needs its grid (rows, columns, prices).',
  PRODUCT_GRID_NOT_REQUIRED: 'A product grid question is always required: it is the order itself.',
  PRODUCT_GRID_REQUIRES_PAYMENT: 'A form with a product grid must take payment: the grid charges.',
  PRODUCT_GRID_AXIS_INVALID: 'A product grid needs at least one row and one column, within bounds.',
  PRODUCT_GRID_ID_INVALID: 'A product grid row or column id is missing or malformed.',
  PRODUCT_GRID_DUPLICATE_ID: 'Two rows, or two columns, of a product grid share an id.',
  PRODUCT_GRID_LABEL_INVALID: 'A product grid row or column has an empty or too long label.',
  PRODUCT_GRID_DUPLICATE_LABEL: 'Two rows, or two columns, of a product grid share a label.',
  PRODUCT_GRID_MAX_PER_CELL_INVALID: 'The maximum per cell of a product grid must be 1 to 99.',
  PRODUCT_GRID_CLOSED_CELL_INVALID: 'A closed cell of a product grid names no cell of it.',
  PRODUCT_GRID_ALL_CELLS_CLOSED: 'Every cell of a product grid is closed: nothing can be ordered.',
  PRODUCT_GRID_PRICE_MODE_INVALID:
    'A product grid price mode must be single, per_row or per_column.',
  PRODUCT_GRID_TIER_INVALID:
    'A product grid can vary its prices on one cotisation, promo or formation criterion only.',
  PRODUCT_GRID_GUEST_PRICE_MISSING:
    'A public form charges a guest the "everyone else" price: the product grid needs it.',
  PRODUCT_GRID_PRICES_INCOMPLETE: 'A product grid needs exactly one price per category and axis.',
  PRODUCT_GRID_PRICE_INVALID: 'A product grid price must be a whole number of cents, at least 0.',
  PRODUCT_GRID_ANSWER_MISSING:
    'This form has a product grid this app cannot show: update the app to answer it.',
  PRODUCT_GRID_UNKNOWN_CELL: 'An order names a cell the product grid does not have.',
  PRODUCT_GRID_QUANTITY_INVALID: 'An ordered quantity is not a whole number within the maximum.',
  PRODUCT_GRID_CELL_CLOSED: 'An order names a combination that does not exist.',
  PRODUCT_GRID_EMPTY: 'Order at least one article.',
};

/** The 400 a refusal is answered with: its code, and the sentence for a client that has no word. */
export function productGridRefused(
  item: { id?: string },
  refusal: ProductGridRefusal<ProductGridDefinitionCode | ProductGridAnswerCode>
): BadRequestException {
  const where = refusal.detail ? ` (${refusal.detail})` : '';
  return new BadRequestException({
    code: refusal.code,
    message: `${MESSAGES[refusal.code]}${where}`,
    itemId: item.id ?? null,
  });
}

/** The form-level facts a grid definition is judged with. */
export interface ProductGridFormContext {
  isPublic: boolean;
  requiresPayment: boolean;
  /** Null for a personal form: a cotisation criterion has nothing to be a member of. */
  associationId: string | null;
}

/**
 * Judges every priced grid of a form about to be saved and returns the questions as they will be
 * STORED: each grid reduced to its known fields, labels trimmed, its tier criterion normalised by
 * the price grid's own parser. A refusal throws, coded (`PRODUCT_GRID_*`). Other questions pass
 * through, less any `productGrid` they carried.
 */
export function normaliseProductGridItems<T extends { type?: string }>(
  items: readonly T[],
  ctx: CriteriaContext,
  form: ProductGridFormContext
): T[] {
  return items.map((item) => {
    if (!isProductGridItem(item)) {
      // A grid definition on another type is nothing that type reads: not stored.
      if (!('productGrid' in item)) return item;
      const { productGrid: _dropped, ...rest } = item as T & { productGrid?: unknown };
      return rest as unknown as T;
    }
    const refusal = productGridItemRefusal(item, form);
    if (refusal) throw productGridRefused(item, refusal);
    const grid = item.productGrid;
    const tiers = grid.pricing.tiers ?? null;
    let parsedTiers: Dimension | null = null;
    if (tiers) {
      if (tiers.kind === 'cotisation' && !form.associationId) {
        throw productGridRefused(item, {
          code: 'PRODUCT_GRID_TIER_INVALID',
          detail: 'a cotisation criterion needs a beneficiary association',
        });
      }
      try {
        parsedTiers = parseDimension(tiers, ctx, `items[${item.id}].productGrid.pricing.tiers`);
      } catch (error) {
        if (!(error instanceof BadRequestException)) throw error;
        throw productGridRefused(item, {
          code: 'PRODUCT_GRID_TIER_INVALID',
          detail: String((error.getResponse() as { message?: unknown }).message ?? error.message),
        });
      }
      const clash = findOverlappingBuckets(parsedTiers)[0];
      if (clash) {
        throw productGridRefused(item, {
          code: 'PRODUCT_GRID_TIER_INVALID',
          detail: `categories ${clash[0]} and ${clash[1]} can both hold one person`,
        });
      }
    }
    const stored: ProductGrid = {
      rows: grid.rows.map((r) => ({ id: r.id, label: r.label.trim() })),
      columns: grid.columns.map((c) => ({ id: c.id, label: c.label.trim() })),
      maxPerCell: grid.maxPerCell,
      closedCells: [...(grid.closedCells ?? [])],
      pricing: {
        mode: grid.pricing.mode,
        tiers: parsedTiers as unknown as ProductGridTiers | null,
        prices: Object.fromEntries(
          Object.entries(grid.pricing.prices).map(([tier, list]) => [tier, { ...list }])
        ),
      },
    };
    return { ...item, required: true, productGrid: stored };
  });
}

/**
 * The prices ONE person pays on a grid: the category their profile places them in - every guest,
 * and anybody no category claims, in "everyone else" - and that category's list. A list missing
 * is a grid that broke the save-time completeness rule: it THROWS rather than price at 0.
 */
export function viewerPricesFor(
  item: ProductGridItem,
  facts: PricingFacts
): ProductGridViewerPrices {
  const tiers = item.productGrid.pricing.tiers;
  const tierId = tiers ? bucketFor(tiers as unknown as Dimension, facts) : PRODUCT_GRID_ALL_TIER;
  const prices = item.productGrid.pricing.prices[tierId];
  if (!prices) {
    throw new Error(`product grid ${item.id}: no price list for category ${tierId}`);
  }
  const tierLabel = tiers?.buckets.find((b) => b.id === tierId)?.label ?? null;
  return { tierId, tierLabel, prices: { ...prices } };
}

/** What a respondent's page is told of a form's grids: each one's prices for THIS person only. */
export function productGridPricesFor(
  items: readonly { type?: string }[] | null | undefined,
  facts: PricingFacts
): ProductGridPrices {
  const view: ProductGridPrices = {};
  for (const item of productGridItems(items)) view[item.id] = viewerPricesFor(item, facts);
  return view;
}

/** The questions as a guest reads them: a grid without its price lists (they come resolved). */
export function respondentItems<T extends { type?: string }>(items: readonly T[]): T[] {
  return items.map((item) =>
    isProductGridItem(item) ? { ...item, productGrid: productGridView(item.productGrid) } : item
  );
}

/**
 * Judges one VISIBLE grid's answer and prices it for this person: the answer as it is stored (the
 * ordered cells only, in grid order) and its lines. A refusal throws, coded.
 */
export function priceProductGridAnswer(
  item: ProductGridItem,
  raw: unknown,
  facts: PricingFacts
): { answer: ProductGridAnswer; lines: ProductGridLine[] } {
  const parsed = parseProductGridAnswer(item.productGrid, raw);
  // Narrowed by hand: this package compiles without strictNullChecks, where a boolean discriminant
  // does not narrow the union.
  if (!parsed.ok) {
    throw productGridRefused(item, parsed as unknown as ProductGridRefusal<ProductGridAnswerCode>);
  }
  const { answer } = parsed as { answer: ProductGridAnswer };
  return {
    answer,
    lines: productGridLines(item, answer, viewerPricesFor(item, facts)),
  };
}

/** Everything that sets what a form's grids charge, for the price fingerprint. */
export function productGridPriceFingerprint(
  items: readonly { type?: string }[] | null | undefined
) {
  return productGridItems(items).map((item) => [item.id, item.productGrid?.pricing ?? null]);
}

/** Whether any grid of a form can charge: a price above 0 anywhere. */
export function productGridsCharge(items: readonly { type?: string }[] | null | undefined) {
  return productGridItems(items).some((item) =>
    Object.values(item.productGrid?.pricing?.prices ?? {}).some((list) =>
      Object.values(list ?? {}).some((cents) => typeof cents === 'number' && cents > 0)
    )
  );
}
