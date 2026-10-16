<script lang="ts">
  import { page } from '$app/state';
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { CircleCheck, CircleX, Loader } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { confirmSubmissionPayment } from '$lib/forms/api';
  import { paymentReturnVerdict } from '$lib/forms/paymentReturn';
  import { SocialApiError } from '$lib/associations/api';
  import { announcePageTitle, setPageTitle } from '$lib/seo/pageTitle.svelte';

  /**
   * Lydia's return carries the submission id (it cannot fill in a session id). Each read asks the
   * server to check the row's own request at Lydia, so a payment whose callback was lost is still
   * confirmed here; a payment the callback already confirmed reads paid at once.
   */
  const submissionId = $derived(page.url.searchParams.get('submission_id'));

  /** Ceiling on how long the page keeps asking before it says the payment is still unconfirmed. */
  const MAX_POLLS = 10;
  const POLL_INTERVAL_MS = 3000;

  /**
   * A return with no submission starts on its answer, so the title the route announcer reads at the
   * navigation is already the right one and nothing has to be announced again.
   */
  let status = $state<'loading' | 'confirmed' | 'pending' | 'overCapacity' | 'error'>(
    untrack(() => submissionId) ? 'loading' : 'error'
  );
  let formId = $state<string | null>(null);

  /**
   * THE TITLE SAYS WHAT THE PAGE SAYS. The path's own title is neutral ("Retour de paiement"): this
   * page is reached before anything is known, and it read "Paiement reussi" over "Paiement
   * introuvable" for an unknown submission (iPhone 12, v1.2.9-alpha.3).
   */
  const STATUS_TITLE: Record<typeof status, () => string> = {
    loading: () => m.form_success_verifying(),
    confirmed: () => m.form_success_confirmed_heading(),
    pending: () => m.form_success_pending_heading(),
    overCapacity: () => m.form_success_over_capacity_heading(),
    error: () => m.form_success_not_found_heading(),
  };
  $effect(() => {
    setPageTitle(STATUS_TITLE[status]());
  });

  /**
   * THE ROUTE ANNOUNCER FOLLOWS THE ANSWER. It reads the title once per navigation, and here that
   * was still "Verification du paiement..." (iPhone 12, v1.2.9-alpha.4). When the page leaves
   * `loading` - once, after the server answered - the title above is written in the same flush and
   * the announcer is asked to read it again. A page that never was `loading` (no submission) never
   * asks: its first title was its answer, and on a cold load the router has not started yet.
   */
  let wasLoading = untrack(() => status === 'loading');
  $effect(() => {
    if (status === 'loading' || !wasLoading) return;
    wasLoading = false;
    void tick().then(announcePageTitle);
  });
  onDestroy(() => setPageTitle(null));

  async function confirmBySubmission(id: string) {
    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      const submission = await confirmSubmissionPayment(id);
      formId = submission.formId;
      const verdict = paymentReturnVerdict(submission.paymentStatus);
      if (verdict === 'confirmed') {
        status = 'confirmed';
        return;
      }
      if (verdict === 'overCapacity') {
        status = 'overCapacity';
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
    if (!submissionId) {
      console.warn('[forms/success] reached without a submission_id');
      return;
    }
    try {
      await confirmBySubmission(submissionId);
    } catch (err) {
      if (err instanceof SocialApiError && err.status === 429) {
        // The server's per-answer limit on asking Lydia (a reload after a full poll): an answer,
        // not a failure - the callback still decides, and the page says it is awaited.
        console.info('[forms/success] confirmation limit reached, waiting on the callback');
        status = 'pending';
        return;
      }
      console.error('[forms/success] could not read the submission:', err);
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
    {:else if status === 'overCapacity'}
      <div>
        <h1 class="text-text-main text-2xl font-bold tracking-tight">
          {m.form_success_over_capacity_heading()}
        </h1>
        <p class="text-text-muted mt-2">{m.form_success_over_capacity_desc()}</p>
      </div>
      <a
        href={formId ? `/forms/${formId}` : '/forms'}
        class="bg-cn-border/40 text-text-main hover:bg-cn-border/60 inline-flex items-center gap-2 rounded-xl px-6 py-3 text-sm font-bold transition-all"
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
