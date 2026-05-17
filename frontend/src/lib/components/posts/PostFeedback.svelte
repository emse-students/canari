<script lang="ts">
  import { CircleAlert, CircleCheck } from '@lucide/svelte';
  import { slide, fade } from 'svelte/transition';

  /**
   * Props for the PostFeedback component.
   * Displays in-card success and error notification banners below a post.
   */
  interface Props {
    /** Error message to display (empty string = hidden). */
    errorMessage: string;
    /** Success/action message to display (empty string = hidden). */
    actionMessage: string;
  }

  let { errorMessage, actionMessage }: Props = $props();
</script>

{#if errorMessage || actionMessage}
  <div class="px-5 pb-5 pt-2">
    {#if errorMessage}
      <div
        transition:slide={{ duration: 200 }}
        class="flex items-start gap-3 p-3.5 rounded-xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 shadow-inner"
      >
        <div transition:fade={{ duration: 150 }} class="flex items-center gap-3">
          <CircleAlert size={18} class="shrink-0 mt-0.5" />
          <span class="text-sm font-bold leading-snug">{errorMessage}</span>
        </div>
      </div>
    {/if}

    {#if actionMessage}
      <div
        transition:slide={{ duration: 200 }}
        class="flex items-start gap-3 p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-400 shadow-inner mt-2"
      >
        <div transition:fade={{ duration: 150 }} class="flex items-center gap-3">
          <CircleCheck size={18} class="shrink-0 mt-0.5" />
          <span class="text-sm font-bold leading-snug">{actionMessage}</span>
        </div>
      </div>
    {/if}
  </div>
{/if}
