<script lang="ts">
  import { LoaderCircle, TriangleAlert, CheckCheck, Check } from '@lucide/svelte';
  import { format } from 'date-fns';

  interface Props {
    /** When true, shows an "(modifié)" label. */
    isEdited: boolean;
    /** When true, enables delivery status display. */
    isOwn: boolean;
    /** When true, shows send status (sending / error / sent) on the last own message. */
    isLastOwn: boolean;
    /** When true, shows the read receipt on the last message read by interlocutor(s). */
    isReadReceiptAnchor: boolean;
    /** Current send status of the message. */
    status?: 'sending' | 'sent' | 'error';
    /** List of user IDs who have read the message. */
    readBy: string[];
    /** Timestamp of first read receipt (Date.now() on receiving device). */
    readAt?: number;
    /** When true, renders outside the bubble (below reactions). */
    outsideBubble?: boolean;
  }

  let {
    isEdited,
    isOwn,
    isLastOwn,
    isReadReceiptAnchor = false,
    status,
    readBy,
    readAt,
    outsideBubble = false,
  }: Props = $props();

  const readLabel = $derived(() => {
    let label = `Lu${readBy.length > 1 ? ` (${readBy.length})` : ''}`;
    if (readAt) label += ` à ${format(readAt, 'HH:mm')}`;
    return label;
  });

  const showEdited = $derived(isEdited && !outsideBubble);
  const showSendStatus = $derived(
    isOwn && isLastOwn && !outsideBubble && (status === 'sending' || status === 'error')
  );
  const showSent = $derived(
    isOwn &&
      isLastOwn &&
      outsideBubble &&
      status !== 'sending' &&
      status !== 'error' &&
      readBy.length === 0
  );
  const showRead = $derived(isOwn && isReadReceiptAnchor && outsideBubble && readBy.length > 0);
  const show = $derived(showEdited || showSendStatus || showSent || showRead);
</script>

{#if show}
  <div
    class="flex items-center gap-1.5 {outsideBubble
      ? 'mt-1 justify-end px-0.5'
      : 'mt-1.5 justify-end'}"
  >
    {#if showEdited}
      <span class="italic text-[0.65rem] opacity-65 font-medium">(modifié)</span>
    {/if}
    {#if showSendStatus}
      {#if status === 'sending'}
        <span class="inline-flex items-center gap-1 text-[0.65rem] font-semibold opacity-50">
          <LoaderCircle size={12} class="animate-spin" />
          Envoi...
        </span>
      {:else if status === 'error'}
        <span class="inline-flex items-center gap-1 text-[0.65rem] font-semibold text-red-500">
          <TriangleAlert size={12} />
          Échec
        </span>
      {/if}
    {:else if showSent}
      <span class="inline-flex items-center gap-1 text-[0.65rem] font-semibold opacity-80">
        <Check size={12} strokeWidth={2.4} />
        Envoyé
      </span>
    {:else if showRead}
      <span
        class="inline-flex items-center gap-1 text-[0.65rem] font-bold text-emerald-700 dark:text-emerald-400"
      >
        <CheckCheck size={12} strokeWidth={2.5} />
        {readLabel()}
      </span>
    {/if}
  </div>
{/if}
