<script lang="ts">
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';

  /**
   * THE ONE BUTTON. Every button on a screen is this component, and `controlsGuard.test.ts` fails a
   * file that draws one by hand (docs/wiki/frontend/controls.md).
   *
   * Its box is `.ui-control` (`app.css`): the same height, edge and corner as `Input` and `Select`,
   * so a button, a select and a text field in one row line up by construction. What differs between
   * buttons is the variant:
   *
   *  - `primary`   the yellow fill, reserved for THE action of a surface (save, send, confirm);
   *  - `secondary` the thin grey edge of a field on a neutral fill - everything else, cancel included;
   *  - `soft`      a quiet filled secondary (the recessed `cn-surface-alt`, no edge) for an offer beside
   *    content that must not shout - "Suivre" on a suggestion card (owner, 2026-11-10);
   *  - `ghost`     no fill and no edge, for a low-ranking action beside a primary one;
   *  - `danger-outline` a destructive action on a list row or a panel: red text and a thin red edge on
   *    the neutral fill, so it reads as destructive without outshouting the primary;
   *  - `danger`    SOLID red, for the final confirm inside a confirmation (delete, leave, revoke);
   *  - `link`      NO BOX: accent text inside a line of prose or metadata ("19 h · Suggestion ·
   *    Suivre", owner 2026-11-10). It drops `.ui-control`'s height, edge and padding and keeps the
   *    tap target with an invisible enlarged hit area, so a quiet action stays reachable on a phone.
   *
   * The height is a MIN-height (Android text zoom scales fonts, not lengths): a long label wraps and
   * grows the box instead of overflowing. `size="compact"` (2rem) is for a dense toolbar only. `icon`
   * draws a square of the row's height
   * around one glyph and REQUIRES an `aria-label`, because nothing else names it. `href` renders an
   * anchor wearing the same box, so a link that looks like a button is not a second implementation.
   */
  interface Props {
    /** HTML button type attribute; ignored when `href` is set. */
    type?: 'button' | 'submit' | 'reset';
    /** Whether the button is disabled. */
    disabled?: boolean;
    /** Shows a spinner and disables the button while true. */
    loading?: boolean;
    /** Additional CSS classes forwarded to the element (layout only: width, margin, flex). */
    class?: string;
    /** Click event handler. */
    onclick?: (e: MouseEvent) => void;
    /** Slot content rendered inside the button. */
    children?: import('svelte').Snippet;
    /** Visual variant. */
    variant?: 'primary' | 'secondary' | 'soft' | 'ghost' | 'danger' | 'danger-outline' | 'link';
    /** `default` is 2.5rem, `compact` 2rem. */
    size?: 'default' | 'compact';
    /** A square holding one icon; the caller supplies `aria-label`. */
    icon?: boolean;
    /** Renders an anchor instead of a button. */
    href?: string;
    [key: string]: unknown;
  }

  let {
    type = 'button',
    disabled = false,
    loading = false,
    class: className = '',
    onclick,
    children,
    variant = 'primary',
    size = 'default',
    icon = false,
    href,
    ...rest
  }: Props = $props();

  const VARIANT: Record<NonNullable<Props['variant']>, string> = {
    primary: 'border-transparent bg-accent text-on-accent hover:bg-accent-hover',
    secondary: 'bg-cn-surface text-text-main hover:bg-black/5 dark:hover:bg-white/10',
    soft: 'border-transparent bg-cn-surface-alt text-text-main hover:bg-cn-border',
    ghost:
      'border-transparent bg-transparent text-text-muted hover:bg-black/5 hover:text-text-main dark:hover:bg-white/10',
    danger: 'border-transparent bg-red-solid text-white hover:brightness-90',
    'danger-outline':
      'border-red-err/50 bg-cn-surface text-red-solid hover:bg-red-err/10 dark:text-red-err',
    link: '',
  };

  /** The box-less variant: inline accent text, its hit area widened by a transparent `::before`. */
  const LINK_CLASSES =
    "relative inline cursor-pointer font-semibold text-accent-text before:absolute before:-inset-x-2 before:-inset-y-4 before:content-[''] hover:underline focus-visible:underline aria-disabled:pointer-events-none aria-disabled:opacity-50 disabled:cursor-not-allowed disabled:opacity-50";

  const classes = $derived(
    variant === 'link'
      ? [LINK_CLASSES, className].filter(Boolean).join(' ')
      : [
          'ui-control',
          size === 'compact' ? 'ui-control--compact text-sm' : 'text-base',
          icon ? 'ui-control--icon' : '',
          'inline-flex min-w-0 shrink-0 cursor-pointer items-center justify-center gap-2 text-center font-semibold',
          icon ? '' : size === 'compact' ? 'py-1' : 'py-1.5',
          'transition-colors active:scale-[0.98] aria-disabled:pointer-events-none aria-disabled:opacity-50 disabled:cursor-not-allowed disabled:opacity-50',
          VARIANT[variant],
          className,
        ]
          .filter(Boolean)
          .join(' ')
  );

  const inert = $derived(disabled || loading);
</script>

{#snippet content()}
  {#if loading}
    <span
      class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
    ></span>
  {/if}
  {@render children?.()}
{/snippet}

{#if href !== undefined}
  <a
    {href}
    class={classes}
    aria-disabled={inert || undefined}
    tabindex={inert ? -1 : undefined}
    {onclick}
    {...rest as HTMLAnchorAttributes}
  >
    {@render content()}
  </a>
{:else}
  <button {type} disabled={inert} class={classes} {onclick} {...rest as HTMLButtonAttributes}>
    {@render content()}
  </button>
{/if}
