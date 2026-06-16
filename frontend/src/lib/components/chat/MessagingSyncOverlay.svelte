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
  class="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 px-6 text-center bg-[color-mix(in_srgb,var(--cn-surface)_92%,white)]/95 dark:bg-[color-mix(in_srgb,var(--cn-surface)_88%,black)]/95 backdrop-blur-md"
  role="status"
  aria-live="polite"
  aria-busy="true"
>
  <Loader2 size={28} class="animate-spin text-amber-500 shrink-0" strokeWidth={2} />
  <p class="text-sm font-medium text-text-main">{message}</p>
  <p class="text-xs text-text-muted max-w-sm">
    {m.chat_sync_overlay_description()}
  </p>
</div>
