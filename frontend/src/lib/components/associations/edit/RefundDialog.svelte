<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import { m } from '$lib/paraglide/messages';
  import {
    refundAssociationPurchase,
    type AssociationPurchase,
    type RefundStanding,
  } from '$lib/associations/api';
  import { formatAmount } from '$lib/forms/fillAnswers';
  import {
    eurosToCents,
    refundAttemptOf,
    refundAttemptOfView,
    refundEffectMessage,
    type RefundAttempt,
  } from '$lib/associations/refundWording';
  import { Log } from '$lib/utils/Log';

  interface Props {
    associationId: string;
    purchase: AssociationPurchase;
    standing: RefundStanding;
    /** The buyer's name as the purchases list writes it. */
    buyer: string;
    /** What was bought, as the purchases list names it. */
    item: string;
    onClose: () => void;
    /** Called once an attempt has an outcome, so the list re-reads the payment's state. */
    onSettled: () => void;
  }

  let { associationId, purchase, standing, buyer, item, onClose, onSettled }: Props = $props();

  /**
   * THE DIALOG'S STEPS: the form (total or partial, an amount, a reason), the confirmation naming
   * what a total refund withdraws, the call, and its outcome in plain words.
   */
  type Step = 'form' | 'confirm' | 'sending' | 'done';

  // Drawn ONCE per dialog: a second "Refund" click after an unknown outcome resends the SAME key, so
  // the server answers the first refund instead of making a second one.
  const idempotencyKey = crypto.randomUUID();

  let step = $state<Step>('form');
  let kind = $state<'total' | 'partial'>('total');
  let amountTyped = $state('');
  let reason = $state('');
  let outcome = $state<{ tone: 'ok' | 'wait' | 'error'; text: string } | null>(null);

  /** What is left to refund on this payment; a total refund is offered only with nothing refunded. */
  const remainingCents = $derived(Math.max(0, standing.paidCents - standing.refundedCents));
  const totalOffered = $derived(standing.refundedCents === 0);
  const partialCents = $derived(eurosToCents(amountTyped));
  const amountValid = $derived(partialCents !== null && partialCents <= remainingCents);
  const amountCents = $derived(kind === 'total' ? standing.paidCents : (partialCents ?? 0));
  const canContinue = $derived(reason.trim().length > 0 && (kind === 'total' || amountValid));

  $effect.pre(() => {
    if (!totalOffered) kind = 'partial';
  });

  /** The words of what an attempt came to. */
  function outcomeOf(attempt: RefundAttempt): { tone: 'ok' | 'wait' | 'error'; text: string } {
    switch (attempt.kind) {
      case 'refunded':
        return { tone: 'ok', text: m.asso_refund_done() };
      case 'in-progress':
        return { tone: 'wait', text: m.asso_refund_in_progress() };
      case 'unconfirmed':
        return { tone: 'wait', text: m.asso_refund_unconfirmed() };
      case 'unrecorded':
        return { tone: 'wait', text: m.asso_refund_unrecorded() };
      case 'refused':
        return { tone: 'error', text: attempt.message };
      default:
        return { tone: 'error', text: m.asso_refund_failed() };
    }
  }

  /**
   * Sends the refund and words what came of it; the list is re-read whatever the outcome. An answer
   * is read by its `state`, never its status: a resent click answers the first refund as it stands.
   */
  async function send() {
    step = 'sending';
    Log.i('ASSO', `refund of payment ${purchase.id.slice(0, 8)}: ${kind}, ${amountCents} cents`);
    let attempt: RefundAttempt;
    try {
      const refund = await refundAssociationPurchase(associationId, purchase.id, {
        kind,
        ...(kind === 'partial' ? { amountCents } : {}),
        reason: reason.trim(),
        idempotencyKey,
      });
      attempt = refundAttemptOfView(refund);
      if (attempt.kind === 'unrecorded') {
        console.error(`[ASSO] refund of payment ${purchase.id.slice(0, 8)}: confirmed, not saved`);
      }
    } catch (e) {
      attempt = refundAttemptOf(e);
      if (attempt.kind === 'unknown') {
        console.error(`[ASSO] refund of payment ${purchase.id.slice(0, 8)} failed:`, e);
      }
    }
    Log.i('ASSO', `refund of payment ${purchase.id.slice(0, 8)}: ${attempt.kind}`);
    outcome = outcomeOf(attempt);
    step = 'done';
    onSettled();
  }
</script>

<Modal
  open
  title={m.asso_refund_title()}
  dismissible={step !== 'sending'}
  onClose={() => step !== 'sending' && onClose()}
>
  <div class="space-y-4" data-testid="refund-dialog" data-step={step}>
    <p class="text-text-main text-sm">
      {m.asso_refund_summary({ buyer, amount: formatAmount(standing.paidCents), item })}
      {#if standing.refundedCents > 0}
        {m.asso_refund_summary_refunded({ amount: formatAmount(standing.refundedCents) })}
      {/if}
    </p>

    {#if step === 'form'}
      <form
        class="space-y-4"
        onsubmit={(e) => {
          e.preventDefault();
          if (canContinue) step = 'confirm';
        }}
      >
        <fieldset class="space-y-2">
          {#if totalOffered}
            <label class="flex items-center gap-2 text-sm">
              <input type="radio" name="refund-kind" value="total" bind:group={kind} />
              {m.asso_refund_kind_total({ amount: formatAmount(standing.paidCents) })}
            </label>
          {/if}
          <label class="flex items-center gap-2 text-sm">
            <input type="radio" name="refund-kind" value="partial" bind:group={kind} />
            {m.asso_refund_kind_partial()}
          </label>
        </fieldset>
        {#if kind === 'partial'}
          <div class="space-y-1">
            <label for="refund-amount" class="text-text-muted block text-xs font-semibold"
              >{m.asso_refund_amount_label()}</label
            >
            <input
              id="refund-amount"
              type="text"
              inputmode="decimal"
              bind:value={amountTyped}
              class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2.5 text-sm"
            />
            <p class="text-xs {amountTyped && !amountValid ? 'text-red-err' : 'text-text-muted'}">
              {amountTyped && !amountValid
                ? m.asso_refund_amount_error({ amount: formatAmount(remainingCents) })
                : m.asso_refund_amount_hint({ amount: formatAmount(remainingCents) })}
            </p>
          </div>
        {/if}
        <div class="space-y-1">
          <label for="refund-reason" class="text-text-muted block text-xs font-semibold"
            >{m.asso_refund_reason_label()}</label
          >
          <input
            id="refund-reason"
            type="text"
            maxlength="500"
            bind:value={reason}
            placeholder={m.asso_refund_reason_placeholder()}
            class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2.5 text-sm"
          />
        </div>
        <div class="flex justify-end gap-2">
          <button
            type="button"
            onclick={onClose}
            class="border-cn-border text-text-main hover:bg-cn-bg rounded-xl border px-4 py-2 text-sm font-semibold"
          >
            {m.common_cancel_button()}
          </button>
          <button
            type="submit"
            disabled={!canContinue}
            data-testid="refund-continue"
            class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50"
          >
            {m.asso_refund_continue()}
          </button>
        </div>
      </form>
    {:else if step === 'confirm' || step === 'sending'}
      <h3 class="text-text-main text-sm font-bold">
        {m.asso_refund_confirm_title({ amount: formatAmount(amountCents) })}
      </h3>
      <p class="text-text-main text-sm" data-testid="refund-effect">
        {refundEffectMessage(kind, standing.withdrawal, buyer)}
      </p>
      <p class="text-text-muted text-xs">{m.asso_refund_lydia_notice()}</p>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          disabled={step === 'sending'}
          onclick={() => (step = 'form')}
          class="border-cn-border text-text-main hover:bg-cn-bg rounded-xl border px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {m.asso_refund_back()}
        </button>
        <button
          type="button"
          disabled={step === 'sending'}
          onclick={send}
          data-testid="refund-send"
          class="bg-red-err rounded-xl px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
        >
          {step === 'sending'
            ? m.asso_refund_sending()
            : m.asso_refund_confirm_button({ amount: formatAmount(amountCents) })}
        </button>
      </div>
    {:else if outcome}
      <p
        role="status"
        data-testid="refund-outcome"
        data-tone={outcome.tone}
        class="rounded-xl border px-4 py-3 text-sm {outcome.tone === 'ok'
          ? 'border-green-ok/30 bg-green-ok/10 text-green-ok'
          : outcome.tone === 'wait'
            ? 'border-amber-warn/30 bg-amber-warn/10 text-text-main'
            : 'border-red-err/30 bg-red-err/10 text-red-err'}"
      >
        {outcome.text}
      </p>
      <div class="flex justify-end">
        <button
          type="button"
          onclick={onClose}
          class="border-cn-border text-text-main hover:bg-cn-bg rounded-xl border px-4 py-2 text-sm font-semibold"
        >
          {m.asso_refund_close()}
        </button>
      </div>
    {/if}
  </div>
</Modal>
