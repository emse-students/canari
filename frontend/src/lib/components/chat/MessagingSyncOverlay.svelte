<script lang="ts">
  import { Loader2 } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Status line shown under the spinner (e.g. catch-up vs unlock). */
    message?: string;
  }

  let { message = m.chat_sync_overlay_message() }: Props = $props();
</script>

<div
  class="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-[color-mix(in_srgb,var(--cn-surface)_92%,white)]/95 px-6 text-center backdrop-blur-md dark:bg-[color-mix(in_srgb,var(--cn-surface)_88%,black)]/95"
  role="status"
  aria-live="polite"
  aria-busy="true"
>
  <Loader2 size={28} class="shrink-0 animate-spin text-amber-500" strokeWidth={2} />
  <p class="text-text-main text-sm font-medium">{message}</p>
  <p class="text-text-muted max-w-sm text-xs">
    {m.chat_sync_overlay_description()}
  </p>
</div>
