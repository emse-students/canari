<script lang="ts">
  import { page } from '$app/state';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { CircleCheck, CircleX, Loader } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { confirmGuestReceipt } from '$lib/forms/api';
  import { formatAmount } from '$lib/forms/fillAnswers';
  import { pollPaymentReturn, type PaymentReturnOutcome } from '$lib/forms/paymentReturnPoll';
  import { SocialApiError } from '$lib/associations/api';
  import { setPageTitle } from '$lib/seo/pageTitle.svelte';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';

  /**
   * THE GUEST'S RETURN FROM LYDIA (WP-P2 of the paid public forms chantier, decision PP2): a
   * confirmation and a REFERENCE, no e-mail, no account.
   *
   * The URL's `receipt` is the guest's proof of the answer (`guest-receipt.ts` on the server), and it
   * is the ONLY thing read from the URL: every status shown comes from the server, which reads the
   * answer's own request at Lydia. A URL that says "paid" says nothing here. The receipt stays in the
   * address bar on purpose - it is the link the guest comes back to while the payment confirms.
   * So the page sends NO Referer: its own requests - its chunks, the confirmation call, the retry
   * link - would otherwise carry the whole URL, receipt included, into the access log's referer
   * field, which the request-line redaction (`Dockerfile.frontend`) does not cover. The policy is a
   * response HEADER of every `/f/` page (`$capability_referrer_policy`), because this page boots on
   * the client and its first chunks leave before any <meta> can apply; the <meta> below restates it
   * for a shell served without that header (a dev server, a preview).
   *
   * It shares the member return page's poll (`pollPaymentReturn`) and its verdicts, and words them
   * for a guest: no e-mail is promised, and the organiser is reached with the reference.
   */
  const formId = $derived(page.params.id ?? '');
  const receipt = $derived(page.url.searchParams.get('receipt'));

  let status = $state<'loading' | PaymentReturnOutcome>(
    untrack(() => receipt) ? 'loading' : 'error'
  );
  let reference = $state<string | null>(null);
  let amount = $state<string | null>(null);

  const TITLE: Record<typeof status, () => string> = {
    loading: () => m.form_success_verifying(),
    confirmed: () => m.form_success_confirmed_heading(),
    pending: () => m.form_success_pending_heading(),
    overCapacity: () => m.form_success_over_capacity_heading(),
    declined: () => m.form_success_declined_heading(),
    ended: () => m.form_success_ended_heading(),
    error: () => m.form_success_not_found_heading(),
  };
  const DESCRIPTION: Record<Exclude<typeof status, 'loading'>, () => string> = {
    confirmed: () => m.form_guest_receipt_confirmed_desc(),
    pending: () => m.form_guest_receipt_pending_desc(),
    overCapacity: () => m.form_guest_receipt_over_capacity_desc(),
    declined: () => m.form_success_declined_desc(),
    ended: () => m.form_success_ended_desc(),
    error: () => m.form_guest_receipt_not_found_desc(),
  };
  $effect(() => {
    setPageTitle(TITLE[status]());
  });
  onDestroy(() => setPageTitle(null));

  onMount(async () => {
    if (!receipt) {
      console.warn('[f/receipt] reached without a receipt');
      return;
    }
    const proof = receipt;
    try {
      status = await pollPaymentReturn(
        () => confirmGuestReceipt(proof),
        (answer) => {
          reference = answer.reference;
          amount = formatAmount(answer.totalPaid, answer.currency);
        }
      );
    } catch (err) {
      if (err instanceof SocialApiError && err.status === 429) {
        // The per-receipt limit on asking Lydia (a reload after a full poll): an answer, not a
        // failure - the callback still decides, and the page says it is awaited.
        console.info('[f/receipt] confirmation limit reached, waiting on the callback');
        status = 'pending';
        return;
      }
      if (err instanceof SocialApiError && err.status === 404) {
        console.warn('[f/receipt] the receipt matches no answer');
      } else {
        console.error('[f/receipt] could not read the receipt:', err);
      }
      status = 'error';
    }
  });
</script>

<svelte:head>
  <meta name="referrer" content="no-referrer" />
</svelte:head>

<PageContainer width="reading">
  <div class="flex min-h-[70vh] items-center justify-center">
    <div class="w-full max-w-md space-y-6 text-center">
      {#if status === 'loading'}
        <div class="flex justify-center">
          <div class="bg-cn-border/30 animate-pulse rounded-full p-4">
            <Loader size={48} class="text-text-muted animate-spin" />
          </div>
        </div>
      {:else if status === 'confirmed'}
        <div class="flex justify-center">
          <div class="bg-green-ok/15 rounded-full p-4">
            <CircleCheck size={48} class="text-green-ok" />
          </div>
        </div>
      {:else if status === 'error' || status === 'declined' || status === 'ended'}
        <div class="flex justify-center">
          <div class="bg-red-err/20 rounded-full p-4">
            <CircleX size={48} class="text-red-err" />
          </div>
        </div>
      {/if}

      <!-- Announced by the page itself, as on the member return page: the route announcer reads the
           title once, while it still says "verifying". -->
      <div role="status" data-payment-answer>
        {#if status === 'loading'}
          <p class="text-text-muted">{m.form_success_verifying()}</p>
        {:else}
          <h1 class="text-text-main text-2xl font-bold tracking-tight">{TITLE[status]()}</h1>
          <p class="text-text-muted mt-2">{DESCRIPTION[status]()}</p>
        {/if}
      </div>

      {#if reference && status !== 'loading' && status !== 'error'}
        <div class="border-cn-border rounded-2xl border bg-(--cn-surface) px-5 py-4">
          <p class="text-text-main font-mono text-lg font-bold" data-guest-reference>
            {m.form_guest_reference({ reference })}
          </p>
          {#if amount}<p class="text-text-muted mt-1 text-sm">{amount}</p>{/if}
        </div>
      {/if}

      {#if status === 'declined' || status === 'ended'}
        <!-- The answer is released: the form itself is the retry. -->
        <a
          href={`/f/${encodeURIComponent(formId)}`}
          class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-6 py-3 text-sm font-bold shadow-sm transition-all"
        >
          {m.form_success_retry()}
        </a>
      {/if}
    </div>
  </div>

  <p class="text-text-muted mt-10 pb-6 text-center text-xs">{m.form_guest_footer()}</p>
</PageContainer>
