<script lang="ts">
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { CircleCheck, CircleX, Loader } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { apiFetch } from '$lib/utils/apiFetch';
  import { getSubmissionPayment } from '$lib/forms/api';
  import { paymentReturnVerdict } from '$lib/forms/paymentReturn';

  const sessionId = $derived(page.url.searchParams.get('session_id'));
  /** Lydia's return carries the submission id: its signed callback, not this page, marks it paid. */
  const submissionId = $derived(page.url.searchParams.get('submission_id'));

  /** Ceiling on how long the page keeps asking before it says the payment is still unconfirmed. */
  const MAX_POLLS = 10;
  const POLL_INTERVAL_MS = 3000;

  let status = $state<'loading' | 'confirmed' | 'pending' | 'error'>('loading');
  let formId = $state<string | null>(null);

  async function confirmBySubmission(id: string) {
    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      const submission = await getSubmissionPayment(id);
      formId = submission.formId;
      const verdict = paymentReturnVerdict(submission.paymentStatus);
      if (verdict === 'confirmed') {
        status = 'confirmed';
        return;
      }
      if (verdict === 'failed') {
        status = 'error';
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    status = 'pending';
  }

  onMount(async () => {
    if (submissionId) {
      try {
        await confirmBySubmission(submissionId);
      } catch (err) {
        console.error('[forms/success] could not read the submission:', err);
        status = 'error';
      }
      return;
    }
    if (!sessionId) {
      status = 'error';
      return;
    }
    try {
      const coreUrl = (import.meta as any).env?.VITE_CORE_URL?.trim() || '';
      const res = await apiFetch(`${coreUrl}/api/payments/verify-session`, {
        method: 'POST',
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json();
      if (data.ok) {
        formId = data.formId ?? null;
        status = 'confirmed';
      } else {
        status = 'error';
      }
    } catch {
      status = 'error';
    }
  });
</script>

<div class="flex min-h-screen items-center justify-center px-4">
  <div class="w-full max-w-md space-y-6 text-center">
    {#if status === 'loading'}
      <div class="flex justify-center">
        <div class="bg-cn-border/30 animate-pulse rounded-full p-4">
          <Loader size={48} class="text-text-muted animate-spin" />
        </div>
      </div>
      <p class="text-text-muted">{m.form_success_verifying()}</p>
    {:else if status === 'pending'}
      <div>
        <h1 class="text-text-main text-2xl font-bold tracking-tight">
          {m.form_success_pending_heading()}
        </h1>
        <p class="text-text-muted mt-2">{m.form_success_pending_desc()}</p>
      </div>
      <a
        href={formId ? `/forms/${formId}` : '/forms'}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-6 py-3 text-sm font-bold shadow-sm transition-all"
      >
        {m.form_success_back_to_form()}
      </a>
    {:else if status === 'confirmed'}
      <div class="flex justify-center">
        <div class="bg-green-ok/15 rounded-full p-4">
          <CircleCheck size={48} class="text-green-ok" />
        </div>
      </div>
      <div>
        <h1 class="text-text-main text-2xl font-bold tracking-tight">
          {m.form_success_confirmed_heading()}
        </h1>
        <p class="text-text-muted mt-2">
          {m.form_success_confirmed_desc()}
        </p>
      </div>
      <a
        href={formId ? `/forms/${formId}` : '/forms'}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-6 py-3 text-sm font-bold shadow-sm transition-all"
      >
        {m.form_success_back_to_form()}
      </a>
    {:else}
      <div class="flex justify-center">
        <div class="bg-red-err/20 rounded-full p-4">
          <CircleX size={48} class="text-red-500" />
        </div>
      </div>
      <div>
        <h1 class="text-text-main text-2xl font-bold tracking-tight">
          {m.form_success_not_found_heading()}
        </h1>
        <p class="text-text-muted mt-2">
          {m.form_success_not_found_desc()}
        </p>
      </div>
      <a
        href="/forms"
        class="bg-cn-border/40 text-text-main hover:bg-cn-border/60 inline-flex items-center gap-2 rounded-xl px-6 py-3 text-sm font-bold transition-all"
      >
        {m.form_success_back_to_forms()}
      </a>
    {/if}
  </div>
</div>
