/**
 * The one class string every text-like form control wears.
 *
 * It exists because the forms admin had grown four hand-copied variants of it - two of them with a
 * different focus ring and one with a different toggle geometry - and a "visual pass" that only
 * fixed the copies would leave the next one free to drift again. `Input.svelte` and
 * `Select.svelte` both render exactly this, so a change to the control style is one edit.
 */

/** Border/focus colours, split out because only these differ between valid and invalid. */
const EDGE_OK = 'border-cn-border focus:border-cn-yellow';
const EDGE_INVALID = 'border-red-err focus:border-red-err';

/** Everything that depends on neither validity nor density. */
const BASE =
  'text-text-main placeholder:text-text-muted/50 disabled:bg-cn-border/20 w-full rounded-2xl ' +
  'border-2 bg-(--cn-surface) transition-all outline-none ' +
  'focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)] disabled:opacity-50';

/**
 * How much room the control takes.
 *
 * `compact` is a real variant rather than a padding override at the call site because three call
 * sites had already written `py-2 text-sm` after `controlClass()` and NONE of them worked: Tailwind
 * emits competing utilities in scale order, so the `py-3` and `text-base` inside this string were
 * always the later rule and always won. A size that loses silently is worse than no size, and a
 * dense grid of prices is the one place the default padding does not fit.
 */
export type ControlDensity = 'default' | 'compact';

const DENSITY: Record<ControlDensity, string> = {
  default: 'px-4 py-3 text-base',
  compact: 'px-3 py-2 text-sm',
};

/** Returns the full class string for a text input or a select. */
export function controlClass(invalid = false, density: ControlDensity = 'default'): string {
  return `${BASE} ${DENSITY[density]} ${invalid ? EDGE_INVALID : EDGE_OK}`;
}

/** The label above a control. */
export const CONTROL_LABEL_CLASS = 'text-text-main mb-2 ml-1 block text-sm font-bold';

/** The hint below a control. */
export const CONTROL_HINT_CLASS = 'text-text-muted mt-1.5 ml-1 text-xs';
