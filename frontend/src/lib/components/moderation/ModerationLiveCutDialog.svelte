<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import { m } from '$lib/paraglide/messages';
  import { cutLive, LiveRefusalError } from '$lib/live/api';
  import type { LiveCutResult } from '$lib/live/types';
  import { reportReasons, type ReportReason } from '$lib/moderation/reasons';
  import { isTransportFailure } from '$lib/utils/transportFailure';

  interface Props {
    /** Whether the dialog is visible. */
    open: boolean;
    /** The live to cut. */
    liveId: string;
    /** Named in the confirmation, so the moderator reads WHO is being cut before pressing. */
    broadcasterName: string;
    /** How many times this broadcaster was cut before: the repeat-offender count, `0` says nothing. */
    priorCuts: number;
    /** Told the server's answer (`newlyCut: false` is a repeat) once the cut is recorded. */
    onCut: (result: LiveCutResult) => void;
    onClose: () => void;
  }

  let { open, liveId, broadcasterName, priorCuts, onCut, onClose }: Props = $props();

  /** `pick`: reason and details; `confirm`: the last look, with the repeat count. */
  let step = $state<'pick' | 'confirm'>('pick');
  let reason = $state<ReportReason | ''>('');
  let details = $state('');
  let submitting = $state(false);
  let error = $state('');

  const reasons = $derived(reportReasons());

  // A dialog reopened on another live must not carry the previous choice.
  $effect(() => {
    if (!open) {
      step = 'pick';
      reason = '';
      details = '';
      error = '';
      submitting = false;
    }
  });

  /** The sentence for a refusal, decided on the typed code and kind, never on a message. */
  function errorText(e: unknown): string {
    if (e instanceof LiveRefusalError) {
      if (e.code === 'LIVE_CUT_FORBIDDEN') return m.moderation_live_cut_forbidden();
      if (e.kind === 'not-found') return m.moderation_live_cut_not_found();
      if (e.code === 'LIVE_CUT_REASON_INVALID' || e.code === 'LIVE_CUT_DETAILS_INVALID') {
        return m.moderation_live_cut_invalid();
      }
    }
    return m.moderation_live_cut_error();
  }

  async function confirm() {
    if (!reason || submitting) return;
    submitting = true;
    error = '';
    console.debug(`[MODERATION] cutting live ${liveId} (${reason})`);
    try {
      const result = await cutLive(liveId, reason, details.trim() || undefined);
      console.log(`[MODERATION] live ${liveId} cut (${result.newlyCut ? 'new' : 'repeat'})`);
      onCut(result);
    } catch (e) {
      // A refusal is an answer (the server said no); no answer at all is a transport failure.
      console.warn(
        `[MODERATION] cutting live ${liveId} failed${isTransportFailure(e) ? ' (no answer)' : ''}`,
        e
      );
      error = errorText(e);
      step = 'pick';
    } finally {
      submitting = false;
    }
  }
</script>

<Modal
  {open}
  {onClose}
  title={m.moderation_live_cut_title()}
  maxWidth="max-w-md"
  dismissible={!submitting}
>
  <div class="space-y-4 px-1 pb-2" data-live-cut-step={step}>
    {#if step === 'pick'}
      <p class="text-text-muted text-xs font-semibold">{m.moderation_live_cut_reason_prompt()}</p>
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
            data-live-cut-reason={option.value}
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
          maxlength="500"
          class="border-cn-border text-text-main focus:border-cn-yellow focus:ring-cn-yellow/20 bg-cn-surface w-full resize-y rounded-xl border px-3 py-2.5 text-sm outline-none focus:ring-2"
          data-live-cut-details></textarea>
      </label>
    {:else}
      <p class="text-text-main text-sm leading-relaxed" data-live-cut-confirm>
        {m.moderation_live_cut_confirm_body({ name: broadcasterName })}
      </p>
      {#if priorCuts > 0}
        <p class="text-red-err text-sm font-semibold" data-live-cut-prior>
          {m.moderation_live_prior_cuts({ count: priorCuts })}
        </p>
      {/if}
    {/if}

    {#if error}
      <p class="text-red-err text-xs" role="alert" data-live-cut-error>{error}</p>
    {/if}

    <div class="flex justify-end gap-2 pt-1">
      {#if step === 'pick'}
        <button
          type="button"
          class="text-text-muted rounded-xl px-4 py-2 text-sm font-semibold transition-colors hover:bg-black/5"
          onclick={onClose}
        >
          {m.common_cancel_button()}
        </button>
        <button
          type="button"
          class="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-40"
          onclick={() => {
            error = '';
            step = 'confirm';
          }}
          disabled={!reason}
          data-live-cut-continue
        >
          {m.moderation_live_cut_continue_button()}
        </button>
      {:else}
        <button
          type="button"
          class="text-text-muted rounded-xl px-4 py-2 text-sm font-semibold transition-colors hover:bg-black/5 disabled:opacity-40"
          onclick={() => (step = 'pick')}
          disabled={submitting}
        >
          {m.moderation_live_cut_back_button()}
        </button>
        <button
          type="button"
          class="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-40"
          onclick={confirm}
          disabled={submitting}
          data-live-cut-confirm-button
        >
          {submitting
            ? m.moderation_live_cut_in_progress()
            : m.moderation_live_cut_confirm_button()}
        </button>
      {/if}
    </div>
  </div>
</Modal>
