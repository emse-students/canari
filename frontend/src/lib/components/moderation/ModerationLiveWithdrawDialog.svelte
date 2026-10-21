<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import { m } from '$lib/paraglide/messages';
  import { withdrawBroadcaster, LiveRefusalError } from '$lib/live/api';
  import type { LiveWithdrawalResult } from '$lib/live/types';
  import { reportReasons, type ReportReason } from '$lib/moderation/reasons';
  import { LIVE_CUT_DETAILS_MAX } from '$lib/live/constants';
  import { isTransportFailure } from '$lib/utils/transportFailure';

  interface Props {
    /** Whether the dialog is visible. */
    open: boolean;
    /** The broadcaster whose right is withdrawn. */
    userId: string;
    /** Named in the body, so the moderator reads WHO is affected before pressing. */
    broadcasterName: string;
    /** Told the server's answer (`newlyWithdrawn: false` is a repeat) once it is recorded. */
    onWithdrawn: (result: LiveWithdrawalResult) => void;
    onClose: () => void;
  }

  let { open, userId, broadcasterName, onWithdrawn, onClose }: Props = $props();

  let reason = $state<ReportReason | ''>('');
  let details = $state('');
  let submitting = $state(false);
  let error = $state('');

  const reasons = $derived(reportReasons());
  /** Too long to send: the button stays disabled, so a 400 is never about the length. */
  const detailsTooLong = $derived(details.trim().length > LIVE_CUT_DETAILS_MAX);

  // A dialog reopened for another account must not carry the previous choice.
  $effect(() => {
    if (!open) {
      reason = '';
      details = '';
      error = '';
      submitting = false;
    }
  });

  /** The sentence for a refusal, decided on the typed code, never on a message. */
  function errorText(e: unknown): string {
    if (e instanceof LiveRefusalError) {
      if (e.code === 'LIVE_WITHDRAWAL_FORBIDDEN') return m.moderation_live_withdraw_forbidden();
      if (e.code === 'LIVE_WITHDRAWAL_NOT_DUE') return m.moderation_live_withdraw_not_due();
      if (e.code === 'LIVE_CUT_REASON_INVALID' || e.code === 'LIVE_CUT_DETAILS_INVALID') {
        return m.moderation_live_withdraw_invalid();
      }
    }
    return m.moderation_live_withdraw_error();
  }

  async function confirm() {
    if (!reason || submitting || detailsTooLong) return;
    submitting = true;
    error = '';
    console.debug(`[MODERATION] withdrawing the right of ${userId} (${reason})`);
    try {
      const result = await withdrawBroadcaster(userId, reason, details.trim() || undefined);
      console.log(
        `[MODERATION] right of ${userId} withdrawn (${result.newlyWithdrawn ? 'new' : 'repeat'})`
      );
      onWithdrawn(result);
    } catch (e) {
      // A refusal is an answer (the server said no); no answer at all is a transport failure.
      console.warn(
        `[MODERATION] withdrawing the right of ${userId} failed${isTransportFailure(e) ? ' (no answer)' : ''}`,
        e
      );
      error = errorText(e);
    } finally {
      submitting = false;
    }
  }
</script>

<Modal
  {open}
  {onClose}
  title={m.moderation_live_withdraw_title()}
  maxWidth="max-w-md"
  dismissible={!submitting}
>
  <div class="space-y-4 px-1 pb-2" data-live-withdraw-dialog>
    <p class="text-text-main text-sm leading-relaxed" data-live-withdraw-body>
      {m.moderation_live_withdraw_body({ name: broadcasterName })}
    </p>
    <p class="text-text-muted text-xs font-semibold">
      {m.moderation_live_withdraw_reason_prompt()}
    </p>
    <div class="space-y-2">
      {#each reasons as option (option.value)}
        <button
          type="button"
          class="border-cn-border text-text-main w-full rounded-xl border px-3 py-2.5 text-left text-sm transition-colors hover:border-amber-400 disabled:opacity-40 {reason ===
          option.value
            ? 'border-amber-400 bg-amber-400/10'
            : ''}"
          onclick={() => (reason = option.value)}
          aria-pressed={reason === option.value}
          data-live-withdraw-reason={option.value}
        >
          {option.label}
        </button>
      {/each}
    </div>
    <label class="block">
      <span class="text-text-muted mb-1.5 block text-xs font-semibold"
        >{m.moderation_live_cut_details_label()}</span
      >
      <textarea
        bind:value={details}
        rows="3"
        maxlength={LIVE_CUT_DETAILS_MAX}
        class="border-cn-border text-text-main focus:border-cn-yellow focus:ring-cn-yellow/20 bg-cn-surface w-full resize-y rounded-xl border px-3 py-2.5 text-sm outline-none focus:ring-2"
        data-live-withdraw-details></textarea>
    </label>

    {#if error}
      <p class="text-red-err text-xs" role="alert" data-live-withdraw-error>{error}</p>
    {/if}

    <div class="flex justify-end gap-2 pt-1">
      <button
        type="button"
        class="text-text-muted rounded-xl px-4 py-2 text-sm font-semibold transition-colors hover:bg-black/5 disabled:opacity-40"
        onclick={onClose}
        disabled={submitting}
      >
        {m.common_cancel_button()}
      </button>
      <button
        type="button"
        class="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-40"
        onclick={confirm}
        disabled={!reason || detailsTooLong || submitting}
        data-live-withdraw-confirm-button
      >
        {submitting
          ? m.moderation_live_withdraw_in_progress()
          : m.moderation_live_withdraw_confirm_button()}
      </button>
    </div>
  </div>
</Modal>
