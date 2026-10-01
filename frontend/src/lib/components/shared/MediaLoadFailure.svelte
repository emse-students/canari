<script lang="ts">
  import { CircleAlert, ImageOff, RotateCw, WifiOff } from '@lucide/svelte';
  import { isRetryableMediaFailure, type MediaFailureCause } from '$lib/utils/mediaErrors';
  import { mediaFailureLabel } from '$lib/utils/mediaFailureLabel';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE INSIDE OF A "THIS MEDIA COULD NOT BE SHOWN" BOX - the icon, the sentence, and a retry.
   *
   * WHY (user, 2026-10-01): every failure but a purge said "Impossible de charger le media", so a
   * reader offline, a reader looking at a deleted file and a reader holding damaged bytes were told
   * the same thing and offered nothing to do about it. The cause now comes typed from the throw
   * (`mediaFailureCause`); this draws it, and offers "Reessayer" exactly when trying again can
   * change the answer - never for a 404 or a retention purge, which no retry repairs.
   *
   * The BOX is the caller's: a feed card, a gallery cell, a lightbox and a chat bubble each have
   * their own shape, border and fill. This owns only what all of them say.
   */
  interface Props {
    cause: MediaFailureCause;
    /** The surface's wording for a retention purge. */
    expiredLabel: string;
    /** The surface's wording for an unclassified failure. */
    otherLabel: string;
    /** Starts the download again, in place - no page reload. Omitted: no button is drawn. */
    onRetry?: () => void;
    /**
     * `surface`: on the card or bubble background, a live failure in red. `dark`: over the viewer's
     * black. `ink`: inside the amber bubble of one's own message, where red is unreadable.
     */
    tone?: 'surface' | 'dark' | 'ink';
    /** One line, smaller icon - a chat audio row or any box under ~56 px tall. */
    compact?: boolean;
  }

  let {
    cause,
    expiredLabel,
    otherLabel,
    onRetry,
    tone = 'surface',
    compact = false,
  }: Props = $props();

  const label = $derived(mediaFailureLabel(cause, { expired: expiredLabel, other: otherLabel }));
  const permanent = $derived(!isRetryableMediaFailure(cause));
  const Icon = $derived(permanent ? ImageOff : cause === 'unreachable' ? WifiOff : CircleAlert);

  const textClass = $derived(
    tone === 'dark'
      ? 'text-white/70'
      : tone === 'ink'
        ? 'text-cn-ink/70'
        : permanent
          ? 'text-text-muted'
          : 'text-red-600 dark:text-red-400'
  );
  const buttonClass = $derived(
    tone === 'dark'
      ? 'bg-white/15 text-white hover:bg-white/25'
      : tone === 'ink'
        ? 'bg-cn-ink/10 text-cn-ink hover:bg-cn-ink/20'
        : 'bg-black/5 text-text-main hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15'
  );

  function retry(e: MouseEvent) {
    // Inside a bubble or a card a click also means "open" - this one means only "again".
    e.stopPropagation();
    onRetry?.();
  }
</script>

<div
  class="flex items-center justify-center text-center {compact
    ? 'gap-2'
    : 'flex-col gap-2'} {textClass}"
  role="status"
>
  <Icon size={compact ? 16 : 24} strokeWidth={2} class="shrink-0 opacity-70" />
  <span class="{compact ? 'text-2xs' : 'text-xs'} leading-snug font-semibold">{label}</span>
  {#if onRetry && !permanent}
    <button
      type="button"
      onclick={retry}
      class="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-xs font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 {buttonClass}"
    >
      <RotateCw size={14} strokeWidth={2.5} />
      {m.media_retry_button()}
    </button>
  {/if}
</div>
