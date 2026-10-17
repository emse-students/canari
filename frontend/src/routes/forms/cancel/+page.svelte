<script lang="ts">
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { CircleCheck, CircleX, Loader } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { cancelPendingSubmission, getSubmissionPayment } from '$lib/forms/api';
  import { paymentCancelView, type PaymentCancelView } from '$lib/forms/paymentReturn';
  import { SocialApiError } from '$lib/associations/api';
  import { PREVIOUS_PAYMENT_OPEN } from '$lib/associations/paymentRefusal';

  /** Lydia's return carries the submission id (it cannot fill in a session id). */
  const submissionId = $derived(page.url.searchParams.get('submission_id'));
  let formId = $state<string | null>(null);
  /** `loading` until the row is read: "cancelled" must not flash over an answer that is paid. */
  let view = $state<PaymentCancelView | 'loading'>('loading');

  onMount(async () => {
    if (!submissionId) {
      console.warn('[forms/cancel] reached without a submission_id');
      view = 'cancelled';
      return;
    }
    try {
      const before = await getSubmissionPayment(submissionId);
      formId = before.formId;
      // The confirm callback may have landed before the payer left Lydia: a paid answer is shown
      // paid, and not cancelled.
      const known = paymentCancelView(before.paymentStatus);
      if (known !== 'cancelled') {
        view = known;
        return;
      }
      const result = await cancelPendingSubmission(submissionId);
      if (result.alreadyPaid) {
        // The cancel found the request PAID at Lydia and recorded it; the row says which seat.
        const after = await getSubmissionPayment(submissionId);
        view = paymentCancelView(after.paymentStatus);
        return;
      }
      view = 'cancelled';
    } catch (err) {
      if (err instanceof SocialApiError && err.code === PREVIOUS_PAYMENT_OPEN) {
        // An answer, not a failure: the request could not be shown dead or paid, so the answer
        // stays pending until it is paid or its hold ends.
        console.info('[forms/cancel] the payment request is still open, nothing cancelled');
        view = 'stillOpen';
        return;
      }
      console.error('[forms/cancel] could not cancel the pending submission:', err);
      view = 'unconfirmed';
    }
  });
</script>

<div class="flex min-h-screen items-center justify-center px-4">
  <div class="w-full max-w-md space-y-6 text-center">
    {#if view === 'loading'}
      <div class="flex justify-center">
        <div class="bg-cn-border/30 animate-pulse rounded-full p-4">
          <Loader size={48} class="text-text-muted animate-spin" />
        </div>
      </div>
      <p class="text-text-muted">{m.form_success_verifying()}</p>
    {:else if view === 'paid'}
      <div class="flex justify-center">
        <div class="bg-green-ok/15 rounded-full p-4">
          <CircleCheck size={48} class="text-green-ok" />
        </div>
      </div>
      <div>
        <h1 class="text-text-main text-2xl font-bold tracking-tight">
          {m.form_success_confirmed_heading()}
        </h1>
        <p class="text-text-muted mt-2">{m.form_success_confirmed_desc()}</p>
      </div>
    {:else if view === 'overCapacity'}
      <div>
        <h1 class="text-text-main text-2xl font-bold tracking-tight">
          {m.form_success_over_capacity_heading()}
        </h1>
        <p class="text-text-muted mt-2">{m.form_success_over_capacity_desc()}</p>
      </div>
    {:else}
      <div class="flex justify-center">
        <div class="bg-red-err/20 rounded-full p-4">
          <CircleX size={48} class="text-red-500" />
        </div>
      </div>
      <div>
        <h1 class="text-text-main text-2xl font-bold tracking-tight">
          {#if view === 'stillOpen'}
            {m.form_cancel_still_open_title()}
          {:else if view === 'unconfirmed'}
            {m.form_cancel_unconfirmed_title()}
          {:else}
            {m.form_cancel_title()}
          {/if}
        </h1>
        <p class="text-text-muted mt-2">
          {#if view === 'stillOpen'}
            {m.form_previous_payment_open()}
          {:else if view === 'unconfirmed'}
            {m.form_cancel_unconfirmed_desc()}
          {:else}
            {m.form_cancel_desc()}
          {/if}
        </p>
      </div>
    {/if}
    {#if view !== 'loading'}
      <a
        href={formId ? `/forms/${formId}` : '/forms'}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-6 py-3 text-sm font-bold shadow-sm transition-all"
      >
        {#if view === 'paid' || view === 'overCapacity'}
          {m.form_success_back_to_form()}
        {:else}
          {formId ? m.common_retry_button() : m.form_cancel_back_button()}
        {/if}
      </a>
    {/if}
  </div>
</div>
