<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * The one banner surface. Every strip that announces a transient app-wide fact goes through here.
   *
   * WHY IT EXISTS. Six banners had been written independently and agreed on nothing: four different
   * background treatments (three of them translucent, so the text underneath read through the words
   * meant to be read), two placement strategies, and `role`/`aria-live` on some but not others - the
   * chat ones had neither, so a screen reader was never told the app had gone offline or started
   * synchronising. Harmonising them one call site at a time is how they drifted in the first place.
   *
   * WHAT IT OWNS: the surface (always opaque - see `--banner-bg` in `app.css`), the live region, and
   * the row layout. WHAT IT DOES NOT OWN: placement. A banner is `fixed` at the window scale,
   * `absolute` over a conversation, or in the flow above the content, and only the caller knows
   * which - so position comes in through `class`. Keeping placement out is deliberate: it is the one
   * property that legitimately differs, and pretending otherwise would push every caller to fight
   * the component.
   */
  interface Props {
    /**
     * `neutral` and `warn` are subtle tints of the theme surface, for facts the user can keep
     * working through (offline, synchronising). `notice`, `danger` and `info` are strong, deliberately
     * identical in both themes, for facts that interrupt (maintenance, a fatal MLS error).
     */
    variant?: 'neutral' | 'warn' | 'notice' | 'danger' | 'info';
    /**
     * `status` waits for a pause in what the screen reader is saying; `alert` cuts in. Use `alert`
     * only where the message genuinely cannot wait - a fatal error, not a synchronisation.
     */
    tone?: 'status' | 'alert';
    /** Marks the region busy while work is in progress, so assistive tech can say so. */
    busy?: boolean;
    /** Centres the row. Left-aligned reads better when the text can wrap to two lines. */
    center?: boolean;
    /** Placement and any call-site spacing. The surface itself is not overridable. */
    class?: string;
    children: Snippet;
    /** Trailing control (dismiss, take over, reload). Kept out of the label's flow. */
    action?: Snippet;
  }

  const {
    variant = 'neutral',
    tone = 'status',
    busy = false,
    center = false,
    class: extra = '',
    children,
    action,
  }: Props = $props();

  /**
   * Opaque backgrounds, one per variant. Written out rather than interpolated because Tailwind scans
   * source text: a computed class name like `bg-banner-{variant}` generates no CSS at all, and the
   * banner then renders with no background - which is exactly the failure `cn-surface-alt` hit.
   */
  const SURFACE = {
    neutral: 'bg-banner text-text-muted border-b border-cn-border',
    warn: 'bg-banner-warn text-text-main border-b border-amber-warn/30',
    notice: 'bg-banner-notice text-cn-ink shadow-md',
    danger: 'bg-banner-danger text-white shadow-md',
    info: 'bg-banner-info text-white shadow-md',
  } as const;
</script>

<div
  class="flex items-center gap-2 px-4 py-2 text-sm {center
    ? 'justify-center text-center'
    : 'justify-between'} {SURFACE[variant]} {extra}"
  role={tone}
  aria-live={tone === 'alert' ? 'assertive' : 'polite'}
  aria-busy={busy ? 'true' : undefined}
>
  {#if action}
    <div class="flex min-w-0 items-center gap-2">{@render children()}</div>
    {@render action()}
  {:else}
    {@render children()}
  {/if}
</div>
