import type { FormItem } from './api';

/** Question types that carry no option list, so their options are dropped on save. */
const TYPES_WITHOUT_OPTIONS = ['short_text', 'long_text', 'linear_scale'];

/**
 * Converts the builder's questions into the payload the API expects: prices in cents, blank
 * options dropped, matrix rows flattened to strings.
 *
 * Both admin screens carried a verbatim copy of this thirty-line mapping inside their `handleSave`,
 * which is a poor place for a money conversion to live twice - the euro-to-cent rounding is exactly
 * the kind of thing that must not be able to differ between creating a form and editing it.
 *
 * `priceModifierMember` is omitted rather than nulled when unset, because an option with no member
 * supplement falls back to the public one; sending null would price it at zero for cotisants.
 */
export function toFormItemsPayload(items: any[]): FormItem[] {
  return items.map((item) => {
    const hasOptions = !TYPES_WITHOUT_OPTIONS.includes(item.type);
    return {
      ...item,
      options: hasOptions
        ? (item.options ?? [])
            .filter((opt: any) => opt.label?.trim())
            .map((opt: any) => ({
              ...opt,
              priceModifier: opt.priceModifier != null ? Math.round(opt.priceModifier * 100) : 0,
              ...(opt.priceModifierMember != null && opt.priceModifierMember !== ''
                ? { priceModifierMember: Math.round(Number(opt.priceModifierMember) * 100) }
                : {}),
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
 * cents, so turning payment off and saving cannot silently keep old prices alive.
 */
export function fromFormItems(items: any[], requiresPayment: boolean): any[] {
  return (items ?? []).map((item: any) => ({
    ...item,
    options:
      item.options?.map((opt: any) => ({
        ...opt,
        priceModifier: requiresPayment ? (opt.priceModifier ?? 0) / 100 : 0,
        priceModifierMember:
          requiresPayment && opt.priceModifierMember != null
            ? opt.priceModifierMember / 100
            : undefined,
      })) || [],
    rows: item.rows || [],
  }));
}
