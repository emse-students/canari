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
  <div class="px-5 pt-2 pb-5">
    {#if errorMessage}
      <div
        transition:slide={{ duration: 200 }}
        class="flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/10 p-3.5 text-red-600 shadow-inner dark:text-red-400"
      >
        <div transition:fade={{ duration: 150 }} class="flex items-center gap-3">
          <CircleAlert size={18} class="mt-0.5 shrink-0" />
          <span class="text-sm leading-snug font-bold">{errorMessage}</span>
        </div>
      </div>
    {/if}

    {#if actionMessage}
      <div
        transition:slide={{ duration: 200 }}
        class="mt-2 flex items-start gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3.5 text-emerald-700 shadow-inner dark:text-emerald-400"
      >
        <div transition:fade={{ duration: 150 }} class="flex items-center gap-3">
          <CircleCheck size={18} class="mt-0.5 shrink-0" />
          <span class="text-sm leading-snug font-bold">{actionMessage}</span>
        </div>
      </div>
    {/if}
  </div>
{/if}
