<script lang="ts">
  /**
   * The discreet mention a message wears when the durable queue REFUSED a control action on it
   * (reaction, edit, pin, delete): the peers will not hear of it until the user retries. One line
   * per refused act - a refused 👍 and a refused pin on the same message are two things to retry.
   * Reads the module store (`controlRefusals.svelte.ts`), so it appears and goes away without a prop.
   */
  import { m } from '$lib/paraglide/messages';
  import {
    controlRefusalsFor,
    retryControlRefusal,
    type ControlAct,
  } from '$lib/utils/chat/controlRefusals.svelte';

  let {
    messageId,
    isOwn = false,
    excerpt = '',
  }: {
    messageId: string;
    isOwn?: boolean;
    /** The message's text, named in each Retry's accessible name so a screen reader knows which. */
    excerpt?: string;
  } = $props();

  const refusals = $derived(controlRefusalsFor(messageId));
  const shortExcerpt = $derived(
    excerpt.length > 40 ? `${excerpt.slice(0, 40).trimEnd()}...` : excerpt.trim()
  );

  function labelOf(act: ControlAct): string {
    switch (act.kind) {
      case 'reaction':
        return m.control_refused_reaction({ emoji: act.emoji });
      case 'edit':
        return m.control_refused_edit();
      case 'pin':
        return m.control_refused_pin();
      case 'delete':
        return m.control_refused_delete();
    }
  }

  function retryNameOf(act: ControlAct): string {
    const action = labelOf(act);
    return shortExcerpt
      ? m.control_refused_retry_label({ action, excerpt: shortExcerpt })
      : m.control_refused_retry_label_no_text({ action });
  }

  /** A rejection that is not a refusal (the executor threw) is accused, never swallowed. */
  function retry(key: string, kind: string) {
    retryControlRefusal(key).catch((e: unknown) =>
      console.error(`[OUTBOX] retry of refused "${kind}" on ${messageId.slice(0, 8)} failed: ${e}`)
    );
  }
</script>

{#each refusals as refusal (refusal.key)}
  <div
    class="text-text-muted flex items-center gap-1 text-xs {isOwn
      ? 'justify-end'
      : 'justify-start'}"
    role="status"
    data-testid="control-refused-notice"
  >
    <span>{labelOf(refusal.act)}</span>
    <button
      type="button"
      class="inline-flex min-h-11 min-w-11 items-center justify-center px-2 font-medium underline"
      data-testid="control-refused-retry"
      aria-label={retryNameOf(refusal.act)}
      onclick={() => retry(refusal.key, refusal.act.kind)}
    >
      {m.control_refused_retry()}
    </button>
  </div>
{/each}
