<script lang="ts">
  import { LoaderCircle, TriangleAlert, Check, CheckCheck, Clock } from '@lucide/svelte';
  import { formatTime24 } from '$lib/utils/dates';
  import Avatar from '../shared/Avatar.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** When true, shows an "(modifié)" label. */
    isEdited: boolean;
    /** When true, enables delivery status display. */
    isOwn: boolean;
    /** When true, shows send status (pending / sending / error / sent) on the last own message. */
    isLastOwn: boolean;
    /** When true, shows the read receipt on the last message read by interlocutor(s). */
    isReadReceiptAnchor: boolean;
    /** Current send status of the message. */
    status?: 'pending' | 'sending' | 'sent' | 'error';
    /** List of user IDs who have read the message. */
    readBy: string[];
    /** Timestamp of first read receipt - kept for API compat, detail shown in tooltip. */
    readAt?: number;
    /** When true, renders outside the bubble (delivery/read indicators). */
    outsideBubble?: boolean;
    /** Send time of the message, shown inside the bubble. */
    timestamp?: Date;
    /**
     * Group position of the message within a run of consecutive messages from the same sender.
     * Timestamp is suppressed on 'start' and 'middle' to reduce clutter (shown only on the last).
     */
    groupPosition?: 'single' | 'start' | 'middle' | 'end';
  }

  let {
    isEdited,
    isOwn,
    isLastOwn,
    isReadReceiptAnchor = false,
    status,
    readBy,
    readAt: _readAt,
    outsideBubble = false,
    timestamp,
    groupPosition,
  }: Props = $props();

  // Show timestamp on the last message of a group only (end/single), never mid-run.
  const showTimestamp = $derived(
    !outsideBubble && !!timestamp && groupPosition !== 'start' && groupPosition !== 'middle'
  );
  const showEdited = $derived(isEdited && !outsideBubble);
  const showSendStatus = $derived(
    isOwn &&
      isLastOwn &&
      !outsideBubble &&
      (status === 'sending' || status === 'error' || status === 'pending')
  );
  const showSent = $derived(
    isOwn &&
      isLastOwn &&
      outsideBubble &&
      status !== 'sending' &&
      status !== 'error' &&
      status !== 'pending' &&
      readBy.length === 0
  );
  const showRead = $derived(isOwn && isReadReceiptAnchor && outsideBubble && readBy.length > 0);
  const show = $derived(showTimestamp || showEdited || showSendStatus || showSent || showRead);
</script>

{#if show}
  <div
    class="flex w-full items-center gap-1.5 {outsideBubble
      ? 'mt-0.5 justify-end px-0.5'
      : 'mt-1 justify-end'}"
  >
    {#if showTimestamp}
      <span class="text-[0.65rem] opacity-50 font-medium tabular-nums">
        {formatTime24(timestamp!)}
      </span>
    {/if}
    {#if showEdited}
      <span class="italic text-[0.65rem] opacity-65 font-medium">{m.msg_modifie()}</span>
    {/if}
    {#if showSendStatus}
      {#if status === 'pending'}
        <span class="inline-flex items-center gap-1 text-[0.65rem] font-semibold opacity-50">
          <Clock size={12} />
          {m.msg_en_attente()}
        </span>
      {:else if status === 'sending'}
        <span class="inline-flex items-center gap-1 text-[0.65rem] font-semibold opacity-50">
          <LoaderCircle size={12} class="animate-spin" />
          {m.common_sending_label()}
        </span>
      {:else if status === 'error'}
        <span class="inline-flex items-center gap-1 text-[0.65rem] font-semibold text-red-500">
          <TriangleAlert size={12} />
          {m.msg_echec()}
        </span>
      {/if}
    {:else if showSent}
      <!-- Single check icon only - no text -->
      <span class="inline-flex items-center opacity-50">
        <Check size={12} strokeWidth={2.5} />
      </span>
    {:else if showRead}
      <!-- Reader avatars + double-check (tap bubble for names/time detail) -->
      <span class="inline-flex items-center gap-0.5">
        {#each readBy.slice(0, 3) as userId (userId)}
          <Avatar {userId} size="xs" shape="circle" />
        {/each}
        {#if readBy.length > 3}
          <span class="text-[0.6rem] font-bold opacity-70">+{readBy.length - 3}</span>
        {/if}
        <CheckCheck
          size={12}
          strokeWidth={2.5}
          class="ml-0.5 text-emerald-500 dark:text-emerald-400"
        />
      </span>
    {/if}
  </div>
{/if}
