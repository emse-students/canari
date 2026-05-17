<script lang="ts">
  import { LoaderCircle, TriangleAlert, CheckCheck, Check } from 'lucide-svelte';
  import { format } from 'date-fns';

  interface Props {
    /** When true, shows an "(modifié)" label. */
    isEdited: boolean;
    /** When true, enables delivery status display. */
    isOwn: boolean;
    /** When true (and isOwn), shows read/sent status. */
    isLastOwn: boolean;
    /** Current send status of the message. */
    status?: 'sending' | 'sent' | 'error';
    /** List of user IDs who have read the message. */
    readBy: string[];
    /** Timestamp of first read receipt (Date.now() on receiving device). */
    readAt?: number;
  }

  let { isEdited, isOwn, isLastOwn, status, readBy, readAt }: Props = $props();

  const show = $derived(
    isEdited || (isOwn && isLastOwn) || (isOwn && (status === 'sending' || status === 'error'))
  );

  const readLabel = $derived(() => {
    let label = `Lu${readBy.length > 1 ? ` (${readBy.length})` : ''}`;
    if (readAt) label += ` à ${format(readAt, 'HH:mm')}`;
    return label;
  });
</script>

{#if show}
  <div class="flex items-center justify-end gap-1.5 mt-1.5">
    {#if isEdited}
      <span class="italic text-[0.65rem] opacity-65 font-medium">(modifié)</span>
    {/if}
    {#if isOwn}
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
      {:else if isLastOwn}
        {#if readBy.length > 0}
          <span
            class="inline-flex items-center gap-1 text-[0.65rem] font-bold text-emerald-700 dark:text-emerald-400"
          >
            <CheckCheck size={12} strokeWidth={2.5} class="animate-pulse" />
            {readLabel()}
          </span>
        {:else}
          <span class="inline-flex items-center gap-1 text-[0.65rem] font-semibold opacity-80">
            <Check size={12} strokeWidth={2.4} />
            Envoyé
          </span>
        {/if}
      {/if}
    {/if}
  </div>
{/if}
