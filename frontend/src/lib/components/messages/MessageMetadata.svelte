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
    /** User IDs who have read the message, derived from the conversation's read watermarks. */
    readBy: string[];
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
    outsideBubble = false,
    timestamp,
    groupPosition,
  }: Props = $props();

  /*
   * Show the timestamp on the last message of a group only (end/single), never mid-run - AND
   * OUTSIDE THE BUBBLE, not in it.
   *
   * It used to render as its own flex row INSIDE the bubble, which made every bubble that carried
   * one two lines tall: a one-line message measured 66px where the reference measures 35px. The
   * reference puts no metadata inside a bubble at all - the bubble is exactly the text - and hangs
   * the time under the group. Halving the height of the most repeated element on the screen is the
   * single largest density win available here.
   */
  const showTimestamp = $derived(
    outsideBubble && !!timestamp && groupPosition !== 'start' && groupPosition !== 'middle'
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
      <span class="text-2xs font-medium tabular-nums opacity-50">
        {formatTime24(timestamp!)}
      </span>
    {/if}
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
      <span class="msg-status msg-status-read inline-flex items-center gap-0.5" role="status">
        <span class="inline-flex items-center gap-0.5" aria-hidden="true">
          {#each readBy.slice(0, 3) as userId (userId)}
            <Avatar {userId} size="xs" shape="circle" />
          {/each}
          {#if readBy.length > 3}
            <span class="text-2xs font-bold opacity-70">+{readBy.length - 3}</span>
          {/if}
          <CheckCheck
            size={12}
            strokeWidth={2.5}
            class="ml-0.5 text-emerald-500 dark:text-emerald-400"
          />
        </span>
        <!--
          One key per arity, which is this codebase's convention for counted strings (see
          `chat_typing_one_person` / `_two_people` / `_multiple_people`). The inlang project has no
          ICU plural support, and a single `{count, plural, ...}` message compiles to an input the
          generated type does not carry.
        -->
        <span class="sr-only">
          {readBy.length === 1
            ? m.msg_statut_lu_une_personne()
            : m.msg_statut_lu_plusieurs({ count: readBy.length })}
        </span>
      </span>
    {/if}
  </div>
{/if}
