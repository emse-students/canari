import type { FormItem } from './api';
import { PRODUCT_GRID_TYPE } from './productGridContract';
import { editorProductGrid, productGridPayload } from './productGridEditor';

/** Question types that carry no option list, so their options are dropped on save. */
const TYPES_WITHOUT_OPTIONS = [
  'short_text',
  'long_text',
  'linear_scale',
  'file',
  PRODUCT_GRID_TYPE,
];

/**
 * Question types whose options may carry a supplement. Any other type (a matrix) keeps its options
 * as columns at no price, so a question turned from a choice into a matrix drops its old supplements
 * rather than store prices its answer can never charge.
 */
const TYPES_WITH_PRICED_OPTIONS = ['single_choice', 'multiple_choice', 'dropdown'];

/**
 * Converts the builder's questions into the payload the API expects: prices in cents, blank
 * options dropped, matrix rows flattened to strings.
 *
 * Both admin screens carried a verbatim copy of this thirty-line mapping inside their `handleSave`,
 * which is a poor place for a money conversion to live twice - the euro-to-cent rounding is exactly
 * the kind of thing that must not be able to differ between creating a form and editing it.
 *
 * There is one supplement per option, not one per audience: who somebody is decides which CELL of
 * the pricing grid they land in, and a question the grid prices on carries no supplement at all.
 *
 * A priced grid (`product_grid`) carries its definition under `productGrid`, in the contract's
 * exact shape (`productGridPayload`: cents, one price per category x axis key); every other type
 * sends none - a question turned from a grid into a choice drops it here rather than on the server.
 * A grid is always sent required: see `productGridItemRefusal` for what the flag still does.
 */
export function toFormItemsPayload(items: any[]): FormItem[] {
  return items.map((item) => {
    const hasOptions = !TYPES_WITHOUT_OPTIONS.includes(item.type);
    const pricesOptions = TYPES_WITH_PRICED_OPTIONS.includes(item.type);
    const { productGrid, ...rest } = item;
    return {
      ...rest,
      // A grid is sent `required: true` whatever the card holds: the flag is no choice of the
      // manager's (the order rule is the form's), and it keeps an app that cannot draw the grid
      // holding the send (`productGridItemRefusal`).
      ...(item.type === PRODUCT_GRID_TYPE && productGrid
        ? { productGrid: productGridPayload(productGrid), required: true }
        : {}),
      options: hasOptions
        ? (item.options ?? [])
            .filter((opt: any) => opt.label?.trim())
            .map((opt: any) => ({
              ...opt,
              priceModifier:
                pricesOptions && opt.priceModifier != null
                  ? Math.round(opt.priceModifier * 100)
                  : 0,
            }))
        : [],
      rows: (item.rows ?? [])
        .map((r: any) => (typeof r === 'string' ? r : r.value))
        .filter(Boolean),
    };
  });
}

/**
 * The reverse trip, for the edit screen: cents back to euros so the inputs can bind to them.
 *
 * A form that takes no payment reads every supplement as zero rather than showing the stored
 * cents, so turning payment off and saving cannot silently keep old prices alive. A priced grid's
 * prices are read back as stored either way: a grid always charges, and the save refuses it on a
 * form without payment (`PRODUCT_GRID_REQUIRES_PAYMENT`) instead of zeroing what was typed.
 */
export function fromFormItems(items: any[], requiresPayment: boolean): any[] {
  return (items ?? []).map((item: any) => ({
    ...item,
    ...(item.type === PRODUCT_GRID_TYPE
      ? { productGrid: editorProductGrid(item.productGrid) }
      : {}),
    options:
      item.options?.map((opt: any) => ({
        ...opt,
        priceModifier: requiresPayment ? (opt.priceModifier ?? 0) / 100 : 0,
      })) || [],
    rows: item.rows || [],
  }));
}
