<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import { m } from '$lib/paraglide/messages';
  import { resolveAssociationRefund, type AssociationRefund } from '$lib/associations/api';
  import { formatAmount } from '$lib/forms/fillAnswers';
  import { refundAttemptOf } from '$lib/associations/refundWording';
  import { Log } from '$lib/utils/Log';

  interface Props {
    associationId: string;
    refund: AssociationRefund;
    buyer: string;
    onClose: () => void;
    /** Called once the check is recorded (or refused), so the list re-reads the payment. */
    onSettled: () => void;
  }

  let { associationId, refund, buyer, onClose, onSettled }: Props = $props();

  /**
   * THE RE-CHECK OF A REFUND LYDIA NEVER CONFIRMED. Lydia offers Canari no way to read a refund back,
   * so the manager reads the association's own Lydia history and says what they see: only then can a
   * new refund of the payment be made. Never a blind retry.
   */
  let busy = $state(false);
  let outcome = $state<{ tone: 'ok' | 'error'; text: string } | null>(null);

  async function declare(refunded: boolean) {
    busy = true;
    Log.i('ASSO', `refund ${refund.id.slice(0, 8)} checked by hand: refunded=${refunded}`);
    try {
      await resolveAssociationRefund(associationId, refund.id, refunded);
      outcome = {
        tone: 'ok',
        text: refunded ? m.asso_refund_check_done_yes() : m.asso_refund_check_done_no(),
      };
    } catch (e) {
      const attempt = refundAttemptOf(e);
      if (attempt.kind !== 'refused') {
        console.error(`[ASSO] checking refund ${refund.id.slice(0, 8)} failed:`, e);
      }
      outcome = {
        tone: 'error',
        text: attempt.kind === 'refused' ? attempt.message : m.asso_refund_failed(),
      };
    } finally {
      busy = false;
    }
    onSettled();
  }
</script>

<Modal
  open
  title={m.asso_refund_check_title()}
  dismissible={!busy}
  onClose={() => !busy && onClose()}
>
  <div class="space-y-4" data-testid="refund-check-dialog">
    <p class="text-text-main text-sm">
      {m.asso_refund_check_body({ amount: formatAmount(refund.amountCents), buyer })}
    </p>
    {#if outcome}
      <p
        role="status"
        data-testid="refund-check-outcome"
        class="rounded-xl border px-4 py-3 text-sm {outcome.tone === 'ok'
          ? 'border-green-ok/30 bg-green-ok/10 text-green-ok'
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
    {:else}
      <div class="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onclick={() => declare(false)}
          data-testid="refund-check-no"
          class="border-cn-border text-text-main hover:bg-cn-bg rounded-xl border px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {m.asso_refund_check_no()}
        </button>
        <button
          type="button"
          disabled={busy}
          onclick={() => declare(true)}
          data-testid="refund-check-yes"
          class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50"
        >
          {m.asso_refund_check_yes()}
        </button>
      </div>
    {/if}
  </div>
</Modal>
