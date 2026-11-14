<script lang="ts">
  import { LoaderCircle, TriangleAlert, Check, Clock, CircleHelp } from '@lucide/svelte';
  import SeenByHeads from './SeenByHeads.svelte';
  import { m } from '$lib/paraglide/messages';
  import type { MessageSendStatus } from '$lib/types';

  interface Props {
    /** The conversation's nickname scope ("Modifier les pseudos"): names drawn here are read in it. */
    nicknameScope?: string | null;
    /** When true, shows an "(modifié)" label. */
    isEdited: boolean;
    /**
     * When true, the message was restored from another member's history with nothing proving its
     * author (an older build's message, history-reconciliation "authorship") - it is marked, never hidden.
     */
    restoredUnverified?: boolean;
    /** When true, enables delivery status display. */
    isOwn: boolean;
    /** When true, shows send status (pending / sending / error / sent) on the last own message. */
    isLastOwn: boolean;
    /** When true, shows the read receipt on the last message read by interlocutor(s). */
    isReadReceiptAnchor: boolean;
    /** Current send status of the message. */
    status?: MessageSendStatus;
    /**
     * What a `pending` message WAITS FOR, when that is known (R05, 2026-11-09): the link (`network`:
     * the last attempt got no answer, or the device is offline) or the server (`server`: it answered
     * "not now", 502/503/504 - a deploy). The label says so instead of a bare "en attente"; `null`
     * keeps it. Never a failure: the send goes on its own.
     */
    waitingOn?: 'network' | 'server' | null;
    /** User IDs who have read the message, derived from the conversation's read watermarks. */
    readBy: string[];
    /** When true, renders outside the bubble (delivery/read indicators). */
    outsideBubble?: boolean;
    /**
     * Offered on a salon send that can be re-sent (WP-OFF-2): a FAILED one, an UNCONFIRMED one,
     * whose repeat the server answers with the row it already holds (WP-OFF-3), and a PENDING one
     * held for the server after a "not now" (R05, review of #3189), to send it now.
     */
    onRetry?: () => void;
    /** Offered beside `onRetry` (a held, failed or unconfirmed send): gives the message up. */
    onDiscard?: () => void;
    /**
     * Offered on an UNCONFIRMED send (no answer came back): takes the row away and hands its text back
     * to the composer, for a member who would rather rewrite it than retry it.
     */
    onRestore?: () => void;
  }

  let {
    isEdited,
    restoredUnverified = false,
    isOwn,
    isLastOwn,
    isReadReceiptAnchor = false,
    status,
    waitingOn = null,
    readBy,
    outsideBubble = false,
    onRetry,
    onDiscard,
    onRestore,
    nicknameScope = null,
  }: Props = $props();

  /*
   * THERE IS NO PER-MESSAGE TIMESTAMP (user, 2026-09-08). It was redundant twice over: the thread
   * already prints a centred time between groups, and clicking a message opens `MessageInfoTooltip`
   * with its exact time. What the row cost was a line of vertical margin under EVERY group, on the
   * most repeated element in the application - and the reference prints no time in or under a bubble
   * either. `formatTime24` is still used by the tooltip; only this row is gone.
   */
  const showEdited = $derived(isEdited && !outsideBubble);
  const showUnverified = $derived(restoredUnverified && !outsideBubble);
  /** Whether the "unverified" marker's explanation is open - local to this row, closed by default. */
  let unverifiedOpen = $state(false);
  // A FAILURE IS SHOWN WHEREVER IT IS, not only on the last own message: a salon message that was
  // refused and then followed by another one must not look delivered.
  //
  // A SEND IN TRANSIT IS SHOWN UNDER THE BUBBLE, WHERE ITS CHECK WILL BE (2026-11-13,
  // keyboard-and-send-motion.md). Inside, its "En attente..." / "Envoi..." line made the bubble two
  // lines tall until delivery, and the bubble then shrank by that line in one frame, ~680 ms after
  // the send (Mi 9T recording); Messenger's bubble never changes size. Under it, the line hands over
  // to the check in the same row, held one `--text-2xs` line tall by that token's own line height
  // (so text zoom moves it too) - the row keeps its height.
  // A failure stays inside: it is an exception carrying its buttons, not a passing state.
  const inTransit = $derived(status === 'sending' || status === 'pending');
  const showSendStatus = $derived(
    isOwn &&
      (outsideBubble ? isLastOwn && inTransit : status === 'error' || status === 'unconfirmed')
  );
  const showSent = $derived(
    isOwn &&
      isLastOwn &&
      outsideBubble &&
      status !== 'sending' &&
      status !== 'error' &&
      status !== 'unconfirmed' &&
      status !== 'pending' &&
      readBy.length === 0
  );
  const showRead = $derived(isOwn && isReadReceiptAnchor && outsideBubble && readBy.length > 0);
  const show = $derived(showEdited || showUnverified || showSendStatus || showSent || showRead);
</script>

<!-- What the author can do about an unsent row, the same three buttons wherever they apply: Retry,
     Restore (an unconfirmed send only) and Discard. -->
{#snippet sendActions(withRestore: boolean)}
  {#if onRetry}
    <button
      type="button"
      class="font-semibold underline"
      data-testid="message-retry"
      onclick={(e) => {
        e.stopPropagation();
        onRetry?.();
      }}>{m.common_retry_button()}</button
    >
  {/if}
  {#if withRestore && onRestore}
    <button
      type="button"
      class="font-semibold underline"
      data-testid="message-restore"
      onclick={(e) => {
        e.stopPropagation();
        onRestore?.();
      }}>{m.msg_remettre_dans_le_champ()}</button
    >
  {/if}
  {#if onDiscard}
    <button
      type="button"
      class="font-semibold underline"
      data-testid="message-discard"
      onclick={(e) => {
        e.stopPropagation();
        onDiscard?.();
      }}>{m.common_delete_button()}</button
    >
  {/if}
{/snippet}

{#if show}
  <div
    class="flex w-full items-center gap-1.5 {outsideBubble
      ? 'mt-0.5 min-h-[var(--text-2xs--line-height)] justify-end px-0.5'
      : 'mt-1 justify-end'}"
  >
    {#if showEdited}
      <span class="text-2xs font-medium italic opacity-65">{m.msg_modifie()}</span>
    {/if}
    {#if showUnverified}
      <!-- A tap explains the marker; it must not also open the bubble's own panel. -->
      <button
        type="button"
        class="text-2xs font-medium italic underline decoration-dotted opacity-65"
        data-testid="message-restored-unverified"
        aria-expanded={unverifiedOpen}
        onclick={(e) => {
          e.stopPropagation();
          unverifiedOpen = !unverifiedOpen;
        }}>{m.msg_restored_unverified()}</button
      >
    {/if}
    {#if showSendStatus}
      {#if status === 'pending'}
        <span
          class="text-2xs inline-flex items-center gap-1 font-semibold opacity-50"
          data-testid="message-pending"
          role="status"
        >
          <Clock size={12} />
          {waitingOn === 'server'
            ? m.msg_waiting_for_server()
            : waitingOn === 'network'
              ? m.msg_waiting_for_network()
              : m.msg_en_attente()}
          <!-- A salon text held for the server keeps its author's hand on it (review of #3189). -->
          {@render sendActions(false)}
        </span>
      {:else if status === 'sending'}
        <span
          class="text-2xs inline-flex items-center gap-1 font-semibold opacity-50"
          role="status"
        >
          <LoaderCircle size={12} class="animate-spin" />
          {m.common_sending_label()}
        </span>
      {:else if status === 'error'}
        <span class="text-2xs inline-flex items-center gap-1 font-semibold text-red-500">
          <TriangleAlert size={12} />
          {m.msg_echec()}
          {@render sendActions(false)}
        </span>
      {:else if status === 'unconfirmed'}
        <span
          class="text-2xs text-accent-text inline-flex items-center gap-1 font-semibold"
          data-testid="message-unconfirmed"
        >
          <CircleHelp size={12} />
          {m.msg_non_confirme()}
          {@render sendActions(true)}
        </span>
      {/if}
    {:else if showSent}
      <!--
        Single check icon only - no visible text, so the state is carried entirely by an SVG. The
        label is what makes "sent" distinguishable from "read" without sight: the two differ by one
        tick and a colour otherwise.
      -->
      <span
        class="msg-status msg-status-sent relative inline-flex items-center opacity-50"
        role="status"
      >
        <Check size={12} strokeWidth={2.5} />
        <span class="sr-only">{m.msg_statut_envoye()}</span>
      </span>
    {:else if showRead}
      <!-- Reader avatars + double-check (tap bubble for names/time detail) -->
      <SeenByHeads readers={readBy} withCheck {nicknameScope} />
    {/if}
  </div>
  {#if showUnverified && unverifiedOpen}
    <p
      class="text-2xs mt-0.5 text-right opacity-65"
      data-testid="message-restored-unverified-why"
      role="note"
    >
      {m.msg_restored_unverified_hint()}
    </p>
  {/if}
{/if}
