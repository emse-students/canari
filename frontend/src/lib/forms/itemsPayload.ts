import type { FormItem } from './api';
import { PRODUCT_GRID_TYPE, productGridRequiredOnSave } from './productGridContract';
import { editorProductGrid, productGridPayload } from './productGridEditor';

/**
 * What every form payload of this editor carries: it draws each priced grid's "Obligatoire" switch
 * (owner, 2026-11-13), so the `required` it sends on a grid is the manager's choice. A save without
 * it comes from an older editor, which sends `required: true` on every grid, and the server keeps
 * each grid's stored flag instead (`productGridRequiredOnSave`).
 */
export const GRID_REQUIRED_SWITCH = { gridRequiredSwitch: true } as const;

/**
 * The questions of an unpublished revision as this editor opens them. A revision saved by an editor
 * older than the switch ([LEGACY], docs/wiki/legacy-compatibility.md) carries no
 * `gridRequiredSwitch` and `required: true` on every grid, which says nothing: each grid takes the
 * flag the form stores under its id - the rule the server applies when that revision is published
 * (`productGridRequiredOnSave`) - so opening it never turns a switch on by surprise.
 */
export function revisionItems(
  document: { items?: unknown; gridRequiredSwitch?: unknown },
  storedItems: readonly FormItem[] | null | undefined
): FormItem[] | undefined {
  const items = document.items as FormItem[] | undefined;
  if (!Array.isArray(items) || document.gridRequiredSwitch === true) return items;
  return items.map((item) =>
    item.type === PRODUCT_GRID_TYPE
      ? { ...item, required: productGridRequiredOnSave(item, false, storedItems) }
      : item
  );
}

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
 * A grid's `required` is its "Obligatoire" switch, sent as the card holds it; the form payload says
 * so with `gridRequiredSwitch` ({@link GRID_REQUIRED_SWITCH}).
 */
export function toFormItemsPayload(items: any[]): FormItem[] {
  return items.map((item) => {
    const hasOptions = !TYPES_WITHOUT_OPTIONS.includes(item.type);
    const pricesOptions = TYPES_WITH_PRICED_OPTIONS.includes(item.type);
    const { productGrid, ...rest } = item;
    return {
      ...rest,
      ...(item.type === PRODUCT_GRID_TYPE && productGrid
        ? { productGrid: productGridPayload(productGrid), required: item.required === true }
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
