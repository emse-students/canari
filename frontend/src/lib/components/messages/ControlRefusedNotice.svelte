<script lang="ts">
  /**
   * The discreet mention a message wears when the durable queue REFUSED a control action on it
   * (reaction, edit, pin, delete): the peers will not hear of it until the user retries. Reads the
   * module store (`controlRefusals.svelte.ts`), so it appears and goes away without a prop.
   */
  import { m } from '$lib/paraglide/messages';
  import {
    controlRefusalFor,
    retryControlRefusal,
    type ControlRefusalKind,
  } from '$lib/utils/chat/controlRefusals.svelte';

  let { messageId, isOwn = false }: { messageId: string; isOwn?: boolean } = $props();

  const refusal = $derived(controlRefusalFor(messageId));

  const labels: Record<ControlRefusalKind, () => string> = {
    reaction: () => m.control_refused_reaction(),
    edit: () => m.control_refused_edit(),
    pin: () => m.control_refused_pin(),
    delete: () => m.control_refused_delete(),
  };
</script>

{#if refusal}
  <div
    class="text-text-muted mt-0.5 flex items-center gap-2 text-xs {isOwn
      ? 'justify-end'
      : 'justify-start'}"
    role="status"
    data-testid="control-refused-notice"
  >
    <span>{labels[refusal.kind]()}</span>
    <button
      type="button"
      class="font-medium underline"
      data-testid="control-refused-retry"
      onclick={() => void retryControlRefusal(messageId)}
    >
      {m.control_refused_retry()}
    </button>
  </div>
{/if}
