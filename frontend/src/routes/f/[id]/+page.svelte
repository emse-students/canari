<script lang="ts">
  import { resolve } from '$app/paths';
  import { Log } from '$lib/utils/Log';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { Ban, Banknote, Check, CreditCard, RotateCcw } from '@lucide/svelte';
  import { currentUserId } from '$lib/stores/user';
  import {
    getPublicForm,
    submitPublicForm,
    PublicFormUnavailableError,
    type PublicForm,
  } from '$lib/forms/api';
  import {
    firstMissingAnswer,
    formatAmount,
    initialSelections,
    isOrderEmpty,
    ORDER_MISSING_ID,
    revealOrderMissing,
    isItemAnswered,
    missingAnswerMessage,
    visibleAnswers,
    visibleItems as visibleItemsOf,
    type MissingAnswer,
    type Selections,
  } from '$lib/forms/fillAnswers';
  import { fillPriceState, optionModifierOf } from '$lib/forms/fillPricing';
  import { appliedTierLabels, isProductGrid } from '$lib/forms/productGridFill';
  import { formSubmitRefusalMessage } from '$lib/forms/answerBounds';
  import { formatFormOpensAt } from '$lib/posts/postComposerDraft';
  import FormHeader from '$lib/components/forms/FormHeader.svelte';
  import FormQuestion from '$lib/components/forms/FormQuestion.svelte';
  import FormViewerTier from '$lib/components/forms/FormViewerTier.svelte';
  import ProductGridQuestion from '$lib/components/forms/ProductGridQuestion.svelte';
  import ProductGridOrderBar from '$lib/components/forms/ProductGridOrderBar.svelte';
  import PaymentMethodChoice from '$lib/components/forms/PaymentMethodChoice.svelte';
  import PayerEmailPrompt from '$lib/components/payments/PayerEmailPrompt.svelte';
  import GuestIdentityFields from '$lib/components/forms/GuestIdentityFields.svelte';
  import {
    askedGuestFields,
    emptyGuestIdentity,
    firstGuestFieldProblem,
    guestIdentityPayload,
    payerPromptNeeded,
  } from '$lib/forms/guestIdentity';
  import Button from '$lib/components/ui/Button.svelte';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import { m } from '$lib/paraglide/messages';
  import { offersOnlyCash } from '$lib/forms/publish';

  /**
   * A PUBLIC FORM, ANSWERED WITHOUT AN ACCOUNT (user, 2026-09-30) - the page a shared link opens.
   *
   * It is not the member's fill page with the member parts switched off: that page holds a pending
   * answer's lifecycle, a reminder and a session, none of which a guest has. What the two share is
   * what a question IS - its card, the rules for an answer, the header - and, since a guest may pay
   * (WP-P1 of the paid public forms chantier), what an answer COSTS (`fillPriceState`) and how it is
   * paid (`PaymentMethodChoice`, `PayerEmailPrompt`): those are the components and functions both
   * use, so a question type or a price rule added once works on both.
   *
   * A signed-in member is sent to the member page, where the form knows who they are.
   */
  const formId = $derived(page.params.id ?? '');

  let form = $state<PublicForm | null>(null);
  let loading = $state(true);
  let loadError = $state('');
  let selections = $state<Selections>({});
  let honeypot = $state('');
  let error = $state('');
  let submitting = $state(false);
  let submitted = $state(false);
  /** The amount a guest owes in cash once the answer is recorded; null when nothing is owed. */
  let cashOwedCents = $state<number | null>(null);
  /** The reference the server gave a cash answer, for the guest to give the organiser. */
  let cashReference = $state<string | null>(null);
  let paymentMethodChoice = $state<'online' | 'cash'>('online');
  /** Online is paused and cash is accepted: the answer is paid in cash, no online choice shown. */
  const cashOnly = $derived(offersOnlyCash(form));
  $effect(() => {
    if (cashOnly) paymentMethodChoice = 'cash';
  });
  let askingPayerEmail = $state(false);
  /** The required question the last send stopped on: its card says why, until it is answered. */
  let missingAnswer = $state<MissingAnswer | null>(null);
  /** The name and e-mail the form asks a guest, as typed ("Vos coordonnees"). */
  let guestIdentity = $state(emptyGuestIdentity());
  /** Whether a send was held on them: their fields then say what is missing. */
  let guestIdentityChecked = $state(false);

  /** What the form asks a guest about who they are; nothing by default (owner, 2026-11-06). */
  const askedFields = $derived(askedGuestFields(form?.guestFields));
  const isNotOpenYet = $derived(!!form?.opensAt && new Date(form.opensAt) > new Date());
  const isClosed = $derived(!!form?.closedAt && new Date(form.closedAt) < new Date());
  // No profile half: the server refuses a public form whose questions depend on who answers.
  const visibleItems = $derived(form ? visibleItemsOf(form.items, selections) : []);
  /** What the answers cost so far, from the slice the server sent (a guest's is the whole grid). */
  const price = $derived(
    fillPriceState({
      basePrice: form?.basePrice ?? 0,
      pricing: form?.pricing ?? null,
      items: form?.items ?? [],
      visibleItems,
      selections,
      productGridPrices: form?.productGridPrices,
    })
  );
  /** Whether a priced grid is shown: the footer then totals the order and sticks. */
  const hasProductGrid = $derived(visibleItems.some(isProductGrid));
  /** A guest's category on the priced grids - "everyone else" wherever the grid has categories. */
  const tierLabels = $derived(appliedTierLabels(visibleItems, form?.productGridPrices));
  /** Signing in may lower the price: the sign-in page, then this form's member page. */
  const loginHref = $derived(
    `${resolve('/login')}?returnTo=${encodeURIComponent(`/forms/${formId}`)}`
  );
  const total = $derived(form ? price.total : 0);
  const paysOnline = $derived(
    total > 0 && !(form?.allowCashPayment && paymentMethodChoice === 'cash')
  );
  /** What the payment note says about the address: kept when the form asked it, else not kept. */
  const paymentNote = $derived(
    askedFields.includes('email')
      ? m.form_guest_payment_note_email_kept()
      : m.form_guest_payment_note()
  );
  const blocked = $derived(
    !form || isNotOpenYet || isClosed || form.formFull || price.priceUnavailable
  );

  onMount(async () => {
    if (currentUserId()) {
      Log.d('PublicForm', `member on a guest link, sent to the member page form=${formId}`);
      await goto(resolve(`forms/${formId}`), { replace: true });
      return;
    }
    try {
      form = await getPublicForm(formId);
      selections = initialSelections(form.items);
      Log.d('PublicForm', `loaded form=${formId} items=${form.items.length}`);
    } catch (e) {
      Log.d('PublicForm', `load failed form=${formId}: ${e}`);
      loadError =
        e instanceof PublicFormUnavailableError && e.notFound
          ? m.form_view_not_found()
          : m.form_view_load_error();
    } finally {
      loading = false;
    }
  });

  async function handleSubmit(payerEmail?: string) {
    if (!form || submitting || blocked) return;
    const missing = firstMissingAnswer(visibleItems, selections);
    missingAnswer = missing;
    if (missing?.itemId === null) {
      // An empty ORDER is the form's, no card's: said once, announced, and brought into view.
      Log.d('PublicForm', 'submit held: the order across the grids is empty');
      error = '';
      await revealOrderMissing();
      return;
    }
    if (missing) {
      // Said on the question's own card, brought into view.
      error = '';
      Log.d('PublicForm', `submit held: required question ${missing.itemId} (${missing.kind})`);
      document
        .getElementById(`q-${missing.itemId}`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    // The name and e-mail the creator asked, said on their own fields, brought into view.
    const identityProblem = firstGuestFieldProblem(askedFields, guestIdentity);
    if (identityProblem) {
      guestIdentityChecked = true;
      error = '';
      Log.d('PublicForm', `submit held: guest ${identityProblem} missing or invalid`);
      document
        .getElementById('guest-identity')
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    // Lydia's request goes to an address. When the form asked the guest's e-mail, that one is it
    // (typed once, kept with the answer); otherwise the guest types one here, forwarded once and
    // never stored (PP2).
    if (payerPromptNeeded(paysOnline, askedFields) && !payerEmail) {
      Log.d('PublicForm', `asking the payer address form=${form.id}`);
      askingPayerEmail = true;
      return;
    }
    error = '';
    submitting = true;
    try {
      const reply = await submitPublicForm(form.id, {
        answers: visibleAnswers(visibleItems, selections),
        website: honeypot,
        ...guestIdentityPayload(askedFields, guestIdentity),
        ...(payerEmail ? { payerEmail } : {}),
        ...(total > 0 && form.allowCashPayment ? { paymentMethod: paymentMethodChoice } : {}),
      });
      if (reply.checkoutUrl) {
        Log.d('PublicForm', `answer sent, to Lydia's payer page form=${form.id}`);
        const { navigateExternal } = await import('$lib/utils/openExternal');
        await navigateExternal(reply.checkoutUrl);
        return;
      }
      Log.d('PublicForm', `answer sent form=${form.id} cash=${reply.cashPayment === true}`);
      cashOwedCents = reply.cashPayment ? total : null;
      cashReference = reply.cashPayment ? (reply.reference ?? null) : null;
      submitted = true;
    } catch (e) {
      Log.d('PublicForm', `submit refused form=${form.id}: ${e}`);
      // Worded in the reader's language from the refusal's code (a form's, then a payment's); the
      // server's sentence is English and for the log - the guest reads ours.
      error = formSubmitRefusalMessage(e, m.form_guest_submit_failed());
    } finally {
      submitting = false;
    }
  }

  /**
   * The empty-order sentence, shown after a send refused for it and only while the order is still
   * empty: it goes the moment a unit is added. The form's, no card's (`MissingAnswer` itemId null).
   */
  const orderMissing = $derived(
    missingAnswer?.itemId === null && isOrderEmpty(visibleItems, selections)
  );

  /** What a question's card says after a refused send: why, while it is still unanswered. */
  function questionError(item: { id: string }): string | null {
    if (!missingAnswer || missingAnswer.itemId !== item.id) return null;
    const shown = visibleItems.find((i) => i.id === item.id);
    return shown && isItemAnswered(shown, selections[item.id])
      ? null
      : missingAnswerMessage(missingAnswer);
  }

  /** A public form takes several answers: start a fresh one from the same link. */
  function answerAgain() {
    if (!form) return;
    selections = initialSelections(form.items);
    missingAnswer = null;
    submitted = false;
    cashOwedCents = null;
    cashReference = null;
    // A shared device at an event: the next answer may be somebody else's.
    guestIdentity = emptyGuestIdentity();
    guestIdentityChecked = false;
    error = '';
    window.scrollTo({ top: 0 });
  }
</script>

<!-- The send button, one markup for the plain footer and the order bar of a priced grid. -->
{#snippet guestPayButton()}
  <Button
    variant="primary"
    disabled={blocked || submitting}
    loading={submitting}
    onclick={() => void handleSubmit()}
  >
    {#if total > 0}
      <CreditCard size={16} class="mr-1.5" />{m.form_view_pay_button({
        amount: formatAmount(total, form?.currency),
      })}
    {:else}
      <Check size={16} class="mr-1.5" />{m.form_view_submit()}
    {/if}
  </Button>
{/snippet}

<!-- The price category a guest pays, and the sign-in that may lower it. -->
{#snippet viewerTier()}
  <FormViewerTier name={null} {tierLabels} {loginHref} />
{/snippet}

{#if askingPayerEmail}
  <PayerEmailPrompt
    onSubmit={(email) => {
      askingPayerEmail = false;
      void handleSubmit(email);
    }}
    onClose={() => (askingPayerEmail = false)}
  />
{/if}

<PageContainer width="reading">
  {#if loading}
    <div class="flex justify-center py-24">
      <div
        class="border-accent-icon h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else if loadError || !form}
    <div class="border-cn-border rounded-3xl border bg-(--cn-surface) p-10 text-center">
      <p class="text-red-err font-semibold">{loadError}</p>
    </div>
  {:else}
    <FormHeader {form} {submitted} children={tierLabels.length > 0 ? viewerTier : undefined} />

    {#if submitted}
      <div class="border-cn-border space-y-4 rounded-3xl border bg-(--cn-surface) p-8 text-center">
        <div class="bg-green-ok/15 text-green-ok mx-auto w-fit rounded-full p-3">
          {#if cashOwedCents != null}<Banknote size={24} />{:else}<Check size={24} />{/if}
        </div>
        {#if cashOwedCents != null}
          <p class="text-text-main font-bold">{m.form_guest_cash_owed_title()}</p>
          <p class="text-text-muted text-sm">
            {m.form_guest_cash_owed_desc({ amount: formatAmount(cashOwedCents, form.currency) })}
          </p>
          {#if cashReference}
            <p class="text-text-main font-mono text-lg font-bold" data-guest-reference>
              {m.form_guest_reference({ reference: cashReference })}
            </p>
          {/if}
        {:else}
          <p class="text-text-main font-bold">{m.form_guest_sent_title()}</p>
        {/if}
        <Button variant="secondary" onclick={answerAgain}>
          <RotateCcw size={16} class="mr-1.5" />{m.form_guest_answer_again()}
        </Button>
      </div>
    {:else}
      {#if isNotOpenYet && form.opensAt}
        <p
          class="border-accent/40 bg-accent/20 text-accent-text mb-4 rounded-2xl border px-4 py-4 text-sm font-semibold"
        >
          {m.form_view_opens_at({ date: formatFormOpensAt(form.opensAt) })}
        </p>
      {:else if isClosed}
        <p class="text-text-muted mb-4 text-center text-sm font-medium">{m.form_view_closed()}</p>
      {:else if form.formFull}
        <p class="text-text-muted mb-4 text-center text-sm font-medium">
          {m.form_view_form_full_note()}
        </p>
      {/if}

      <div class="space-y-3 sm:space-y-4">
        {#each visibleItems as item, index (item.id)}
          <!-- A priced grid draws its own card: the product photo spans it, the price sits by the title. -->
          {#if isProductGrid(item) && item.productGrid}
            <ProductGridQuestion
              {item}
              grid={item.productGrid}
              bind:value={selections[item.id]}
              disabled={isNotOpenYet || isClosed || form.formFull || submitting}
              prices={form.productGridPrices?.[item.id]}
              currency={form.currency}
              error={questionError(item)}
            />
          {:else}
            <FormQuestion
              {item}
              {index}
              bind:value={selections[item.id]}
              disabled={isNotOpenYet || isClosed || form.formFull || submitting}
              formId={form.id}
              currency={form.currency}
              optionModifier={(question, option) => optionModifierOf(price, question, option)}
              optionClosed={(option) => !!option.id && price.unavailableOptionIds.has(option.id)}
              error={questionError(item)}
            />
          {/if}
        {/each}
      </div>

      <!-- The combination answered into does not exist: theirs to undo, said where they look. -->
      {#if price.priceUnavailable}
        <div
          class="border-cn-border bg-cn-border/10 mt-4 flex items-start gap-3 rounded-2xl border px-5 py-4"
        >
          <div class="text-text-muted shrink-0 pt-0.5"><Ban size={18} /></div>
          <div class="min-w-0">
            <p class="text-text-main text-sm font-bold">{m.form_view_combination_closed_title()}</p>
            <p class="text-text-muted mt-1 text-xs">{m.form_view_combination_closed_desc()}</p>
          </div>
        </div>
      {/if}

      <!-- Only what the creator asked, after the questions and before how to pay: the e-mail here is
           the one Lydia uses, never asked twice. -->
      <GuestIdentityFields
        asked={askedFields}
        bind:values={guestIdentity}
        showErrors={guestIdentityChecked}
        emailPaysLydia={paysOnline}
        disabled={isNotOpenYet || isClosed || form.formFull || submitting}
      />

      {#if total > 0 && form.allowCashPayment && !cashOnly}
        <PaymentMethodChoice bind:method={paymentMethodChoice} />
      {/if}

      <!-- THE HONEYPOT. Off-screen and out of the tab order, so a person never meets it; a bot that
           fills every field it finds fills this one too, and the server drops that answer. -->
      <div class="absolute -left-[9999px] h-px w-px overflow-hidden" aria-hidden="true">
        <label>
          {m.form_guest_honeypot_label()}
          <input
            type="text"
            name="website"
            tabindex="-1"
            autocomplete="off"
            bind:value={honeypot}
          />
        </label>
      </div>

      <!-- The empty order: the form's, announced, gone once a unit is added. -->
      {#if orderMissing}
        <p
          id={ORDER_MISSING_ID}
          role="alert"
          class="text-red-err mt-4 text-center text-sm font-medium"
        >
          {m.form_view_error_order_empty()}
        </p>
      {/if}
      {#if error}
        <p class="text-red-err mt-4 text-center text-sm font-medium">{error}</p>
      {/if}

      {#if hasProductGrid && !price.priceUnavailable}
        <!-- An order is totalled where it is paid, stuck to the bottom from the first item. -->
        <div
          data-order-bar-wrap
          class="sticky bottom-0 z-50 mt-6 pb-[max(0.75rem,var(--safe-area-inset-bottom,0px))]"
        >
          <ProductGridOrderBar
            lines={price.gridLines}
            totalCents={total}
            currency={form.currency}
            items={form.items}
            action={guestPayButton}
          />
          {#if paysOnline}
            <p class="text-text-muted mt-2 text-center text-xs">{paymentNote}</p>
          {/if}
        </div>
      {:else}
        <div class="mt-6 flex flex-col items-center gap-2">
          {#if total > 0}
            <p class="text-text-muted text-xs font-medium">
              {m.form_view_total_to_pay()}{price.appliedLabel}
              <span class="text-cn-dark text-base font-bold">
                {formatAmount(total, form.currency)}
              </span>
            </p>
          {/if}
          {@render guestPayButton()}
          {#if paysOnline}
            <p class="text-text-muted max-w-sm text-center text-xs">
              {paymentNote}
            </p>
          {/if}
        </div>
      {/if}
    {/if}

    <p class="text-text-muted mt-10 pb-6 text-center text-xs">{m.form_guest_footer()}</p>
  {/if}
</PageContainer>
