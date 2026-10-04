<script lang="ts">
  import { LoaderCircle, TriangleAlert, Check, Clock } from '@lucide/svelte';
  import SeenByHeads from './SeenByHeads.svelte';
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
    /** User IDs who have read the message, derived from the conversation's read watermarks. */
    readBy: string[];
    /** When true, renders outside the bubble (delivery/read indicators). */
    outsideBubble?: boolean;
  }

  let {
    isEdited,
    isOwn,
    isLastOwn,
    isReadReceiptAnchor = false,
    status,
    readBy,
    outsideBubble = false,
  }: Props = $props();

  /*
   * THERE IS NO PER-MESSAGE TIMESTAMP (user, 2026-09-08). It was redundant twice over: the thread
   * already prints a centred time between groups, and clicking a message opens `MessageInfoTooltip`
   * with its exact time. What the row cost was a line of vertical margin under EVERY group, on the
   * most repeated element in the application - and the reference prints no time in or under a bubble
   * either. `formatTime24` is still used by the tooltip; only this row is gone.
   */
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
  const show = $derived(showEdited || showSendStatus || showSent || showRead);
</script>

{#if show}
  <div
    class="flex w-full items-center gap-1.5 {outsideBubble
      ? 'mt-0.5 justify-end px-0.5'
      : 'mt-1 justify-end'}"
  >
    {#if showEdited}
      <span class="text-2xs font-medium italic opacity-65">{m.msg_modifie()}</span>
    {/if}
    {#if showSendStatus}
      {#if status === 'pending'}
        <span class="text-2xs inline-flex items-center gap-1 font-semibold opacity-50">
          <Clock size={12} />
          {m.msg_en_attente()}
        </span>
      {:else if status === 'sending'}
        <span class="text-2xs inline-flex items-center gap-1 font-semibold opacity-50">
          <LoaderCircle size={12} class="animate-spin" />
          {m.common_sending_label()}
        </span>
      {:else if status === 'error'}
        <span class="text-2xs inline-flex items-center gap-1 font-semibold text-red-500">
          <TriangleAlert size={12} />
          {m.msg_echec()}
        </span>
      {/if}
    {:else if showSent}
      <!--
        Single check icon only - no visible text, so the state is carried entirely by an SVG. The
        label is what makes "sent" distinguishable from "read" without sight: the two differ by one
        tick and a colour otherwise.
      -->
      <span class="msg-status msg-status-sent inline-flex items-center opacity-50" role="status">
        <Check size={12} strokeWidth={2.5} />
        <span class="sr-only">{m.msg_statut_envoye()}</span>
      </span>
    {:else if showRead}
      <!-- Reader avatars + double-check (tap bubble for names/time detail) -->
      <SeenByHeads readers={readBy} withCheck />
    {/if}
  </div>
{/if}
