<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { getToken } from '$lib/stores/auth';
  import { showToast } from '$lib/stores/toast.svelte';
  import {
    currentUserId,
    listPaymentMethods,
    chargeWithSavedMethod,
    setupPaymentMethod,
    type PaymentMethod,
  } from '$lib/stores/user';
  import {
    getForm,
    submitForm as submitFormService,
    checkSubmission,
    type PricingView,
    getSubmission,
    cancelPendingSubmission,
    type Form,
    type FormItem,
    type AnswerDimensionView,
  } from '$lib/forms/api';
  import { OTHERS_BUCKET_ID, cellKey, hasCell, type CellValue } from '$lib/forms/priceMatrix';
  import { formatFormOpensAt, formOpensAtIso } from '$lib/posts/postComposerDraft';
  import {
    getCalendarEventLinkedToForm,
    getAssociation,
    type AssociationCalendarEvent,
  } from '$lib/associations/api';
  import { useFormReminder } from '$lib/posts/useFormReminder.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import PaymentModal from '$lib/components/ui/PaymentModal.svelte';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';
  import {
    ArrowLeft,
    ClipboardList,
    Check,
    CalendarDays,
    Bell,
    BellOff,
    CreditCard,
    Link,
    Lock,
    Ban,
    QrCode,
  } from '@lucide/svelte';
  import { copyPublicShareLink } from '$lib/utils/copyShareLink';
  import { publicAppUrl } from '$lib/utils/publicAppUrl';
  import QrCodeModal from '$lib/components/shared/QrCodeModal.svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  const formId = $derived(page.params.id);
  const redirectTo = $derived(page.url.searchParams.get('redirect') || '/posts');

  let form = $state<Form | null>(null);
  const opensLaterIso = $derived(form?.opensAt ? formOpensAtIso(form.opensAt) : null);
  const isNotOpenYet = $derived(!!opensLaterIso);
  const reminder = useFormReminder(page.params.id ?? '');
  let selections = $state<Record<string, any>>({});
  let submitted = $state(false);
  let paymentPending = $state(false);
  let formFull = $state(false);
  /**
   * This submitter's slice of the pricing grid, from the server. Null when the form has one price.
   *
   * The page derives no pricing RULE of its own: everything about who the person is has already been
   * resolved server-side (cotisation, promo, formation - none of which a browser can be trusted
   * with), and what is left is their own answers, which the page resolves as they click. The server
   * recomputes the whole thing at submit and that figure is what gets charged.
   */
  let pricing = $state<PricingView | null>(null);
  /** Questions a profile criterion hides from this submitter, whatever they answer. */
  let hiddenItemIds = $state<string[]>([]);
  /** False when a `submitCondition` excludes them from the form entirely. */
  let maySubmit = $state(true);
  let submitting = $state(false);
  let savingCard = $state(false);
  let loading = $state(true);
  let error = $state('');
  let successMessage = $state('');
  let userId = $state('');

  // Payment
  let paymentMethods = $state<PaymentMethod[]>([]);
  let showPaymentModal = $state(false);
  let pendingCheckoutUrl = $state('');
  let pendingSubmissionId = $state('');
  let linkedAgendaEvent = $state<AssociationCalendarEvent | null>(null);
  let agendaAssociationSlug = $state('');
  let paymentMethodChoice = $state<'stripe' | 'cash'>('stripe');
  let copiedLink = $state(false);

  // ── Submit bar: sits at the end by default, sticks for good once earned ─────
  /** Marks the bar's natural position - placed AFTER the bar (not before), so it only becomes
   * visible once the submitter has scrolled PAST the whole bar, not merely up to its edge. */
  let barSentinel: HTMLDivElement | undefined = $state();
  /** Whether the sentinel is currently within the scrollable viewport. */
  let barSentinelVisible = $state(false);
  /** One-way latch: true once the submitter has scrolled far enough to see the whole bar AND
   * every required question was answered at that moment. Never resets - reaching the end is a
   * milestone, not a live state. Once true, the bar sticks to the bottom of the screen FOR GOOD -
   * `position: sticky` (unlike `fixed`) never leaves the document flow, so it still settles back
   * into its own natural spot, right after the last question, once scrolled all the way down;
   * nothing needs to manually reserve space for it. There is nothing useful for it to guard
   * before `reachedEnd`, and stopping short of it looks like an intrusive floating panel over
   * content still being filled in - but once earned there is no scroll position where un-pinning
   * it again would help the submitter. */
  let reachedEnd = $state(false);
  /** BottomNav's real rendered height (mobile only; 0 on desktop where it does not mount) -
   * shrinks the sentinel's effective intersection root by that much, so scrolling past the bar
   * is required to also clear the nav sitting below it, not just the bar's own edge. Measured in
   * $effect rather than as a top-level const: top-level script runs during construction, before
   * the DOM is mounted and laid out, so `clientHeight` would read 0 there regardless of CSS. */
  let bottomNavHeight = $state(0);
  $effect(() => {
    bottomNavHeight = document.querySelector('#bottom-nav')?.clientHeight ?? 0;
  });

  async function handleSaveCard() {
    savingCard = true;
    try {
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      const current = `${origin}/forms/${formId}`;
      const result = await setupPaymentMethod({ successUrl: current, cancelUrl: current });
      if (result.url) {
        const { navigateExternal } = await import('$lib/utils/openExternal');
        await navigateExternal(result.url);
      }
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : m.form_card_registration_error());
    } finally {
      savingCard = false;
    }
  }

  /** The one place this screen says where the form lives, shared by both share controls. */
  const formPath = $derived(`/forms/${formId}`);
  let qrOpen = $state(false);

  function copyFormLink() {
    void copyPublicShareLink(formPath);
    copiedLink = true;
    setTimeout(() => (copiedLink = false), 2000);
  }

  onMount(async () => {
    const savedUser = currentUserId();
    if (savedUser) {
      userId = savedUser;
      await getToken().catch(() => {
        // Silently ignore - the form loads fine without a pre-fetched token;
        // apiFetch will retry on the first API call.
      });
    }

    try {
      const id = formId;
      if (!id) {
        error = 'Form not found.';
        loading = false;
        return;
      }
      const f = await getForm(id);
      form = f;
      initSelections(f.items);

      linkedAgendaEvent = null;
      agendaAssociationSlug = '';
      try {
        const { linkedEvent } = await getCalendarEventLinkedToForm(f.id);
        linkedAgendaEvent = linkedEvent;
        if (linkedEvent) {
          try {
            const asso = await getAssociation(linkedEvent.associationId);
            agendaAssociationSlug = asso.slug;
          } catch {
            agendaAssociationSlug = '';
          }
        }
      } catch {
        linkedAgendaEvent = null;
      }

      const {
        hasSubmitted,
        paymentStatus,
        formFull: full,
        pricing: view,
        hiddenItemIds: hidden,
        maySubmit: allowed,
      } = await checkSubmission(f.id);
      submitted = hasSubmitted;
      formFull = full;
      pricing = view;
      hiddenItemIds = hidden ?? [];
      maySubmit = allowed ?? true;
      paymentPending = hasSubmitted && paymentStatus === 'pending';

      if (!hasSubmitted && formOpensAtIso(f.opensAt)) {
        void reminder.load();
      }
      if (hasSubmitted) {
        try {
          const sub = await getSubmission(f.id);
          if (sub?.answers) selections = sub.answers;
        } catch {
          // ignore
        }
      }

      // Pre-load saved payment methods for paid forms
      if (f.requiresPayment && userId) {
        try {
          const methods = await listPaymentMethods();
          paymentMethods = methods;
        } catch {
          // Stripe may not be configured
        }
      }
    } catch (e: any) {
      error = e.message || 'Unable to load the form.';
    } finally {
      loading = false;
    }
  });

  function initSelections(items: FormItem[]) {
    const initial: Record<string, any> = {};
    for (const item of items) {
      if (item.type === 'multiple_choice') {
        initial[item.id] = [];
      } else if (['matrix_single', 'matrix_multiple'].includes(item.type)) {
        initial[item.id] = {};
        for (const row of item.rows ?? []) {
          initial[item.id][row] = item.type === 'matrix_multiple' ? [] : '';
        }
      } else {
        initial[item.id] = '';
      }
    }
    selections = initial;
  }

  function formatCurrency(amountCents: number | undefined, currency = 'eur') {
    if (amountCents === undefined) return '';
    return new Intl.NumberFormat(getLocale() === 'en' ? 'en-US' : 'fr-FR', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amountCents / 100);
  }

  /**
   * Questions that pass their display check.
   *
   * The PROFILE half was already decided by the server (`hiddenItemIds`) - a browser cannot be
   * trusted with someone's cotisation or promo, and would have to be told them to evaluate it. What
   * is left is the answer half, which is what this page has always evaluated.
   */
  const visibleItems = $derived.by(() => {
    if (!form) return [];
    // Nothing to fill in when the form is not open to this person - the questions would only invite
    // an answer the server is going to refuse.
    if (!maySubmit) return [];
    const hidden = new Set(hiddenItemIds);
    return form.items.filter((item) => {
      if (hidden.has(item.id)) return false;
      const condition = item.showIf?.answer
        ? { questionId: item.showIf.answer.questionId, optionIds: item.showIf.answer.optionIds }
        : item.dependsOn
          ? { questionId: item.dependsOn, optionIds: [item.dependsValue ?? ''] }
          : null;
      if (!condition) return true;
      if (hidden.has(condition.questionId)) return false;
      const dep = selections[condition.questionId];
      if (dep === undefined || dep === null || dep === '') return false;
      if (Array.isArray(dep)) return (dep as string[]).some((v) => condition.optionIds.includes(v));
      return condition.optionIds.includes(String(dep));
    });
  });

  /**
   * Which group of one answer criterion an answer falls in - `others` when it matches none.
   *
   * Named because the price and the per-option availability below ask the same question, and two
   * copies of it is how an option offered here lands on a cell the server refuses.
   */
  function bucketIdOf(dimension: AnswerDimensionView, answer: unknown): string {
    const chosen = Array.isArray(answer) ? (answer as string[]) : answer ? [String(answer)] : [];
    return (
      dimension.buckets.find((b) => chosen.some((v) => b.values.includes(v)))?.id ??
      OTHERS_BUCKET_ID
    );
  }

  /**
   * One cell of this submitter's slice: a price, or `null` for a combination that does not exist.
   *
   * A key the slice does not carry is not a cheaper price - it is a broken invariant, since the
   * server sends every combination and completeness is enforced when the grid is saved. So it is
   * logged and reported as unavailable rather than falling back to a figure nobody chose: charging
   * a plausible number is how a wrong price ships quietly.
   */
  function cellOf(view: PricingView, bucketIdsInOrder: string[]): CellValue {
    const key = cellKey(bucketIdsInOrder);
    if (!hasCell(view.cells, key)) {
      console.error(`[FORMS] pricing slice carries no cell "${key}" - treated as unavailable`);
      return null;
    }
    return view.cells[key];
  }

  /**
   * The base price for this submitter, given what they have answered so far.
   *
   * With a grid, it is the cell their answers land in - looked up in the slice the server sent,
   * never computed from a rule here. Without one, the form's single price. `null` means their
   * combination is unavailable, which the page shows instead of a total.
   */
  const baseCents = $derived.by<CellValue>(() => {
    if (!form) return 0;
    if (!pricing) return form.basePrice ?? 0;
    return cellOf(
      pricing,
      pricing.answerDimensions.map((d) => bucketIdOf(d, selections[d.questionId]))
    );
  });

  /**
   * The combination they have landed on does not exist, so there is nothing to pay and nothing to
   * submit. Distinct from `!maySubmit`, which is about who they ARE: this one moves as they answer.
   */
  const priceUnavailable = $derived(baseCents === null);

  /** The price, once known to exist. Zero for a free form, so the display stays arithmetic. */
  const priceCents = $derived(baseCents ?? 0);

  /**
   * Options that would land this submitter on a cell the manager marked as not existing.
   *
   * Computed rather than hidden: an option removed without a word reads as a bug, and the person
   * needs to see that the combination exists but is closed to them. Only the questions the grid
   * prices on can do this - every other answer leaves the cell where it was.
   */
  const unavailableOptionIds = $derived.by(() => {
    const view = pricing;
    if (!view) return new Set<string>();
    const current = view.answerDimensions.map((d) => bucketIdOf(d, selections[d.questionId]));
    return new Set(
      view.answerDimensions.flatMap((dimension, index) => {
        const item = form?.items.find((i) => i.id === dimension.questionId);
        const closed: string[] = [];
        for (const option of item?.options ?? []) {
          if (!option.id) continue;
          const candidate = [...current];
          candidate[index] = bucketIdOf(dimension, option.id);
          if (cellOf(view, candidate) === null) closed.push(option.id);
        }
        return closed;
      })
    );
  });

  /**
   * A question the grid prices on adds no supplement: its answer already chose the cell. Adding one
   * would charge the same choice twice - and the page would then disagree with the invoice.
   */
  const pricedByGrid = $derived(new Set(pricing?.ignoredModifierQuestionIds ?? []));

  /**
   * Why this price and not another - "Cotisant, ICM", from the groups the server matched.
   *
   * A price a person cannot account for is a support request, and this is the whole reason the
   * server sends the labels rather than only the number.
   */
  const appliedPricingLabel = $derived(
    pricing?.appliedLabels.length ? ` (${pricing.appliedLabels.join(', ')})` : ''
  );

  /**
   * The supplement shown beside an option, in cents.
   *
   * Zero for a question the grid prices on: its answer selects a cell rather than adding to one, so
   * showing a supplement there would describe a charge that does not happen.
   */
  function optionModifier(item: { id: string }, opt: { priceModifier: number }): number {
    return pricedByGrid.has(item.id) ? 0 : opt.priceModifier;
  }

  /** Whether choosing this option would land on a combination the manager marked as not existing. */
  function optionClosed(opt: { id?: string }): boolean {
    return !!opt.id && unavailableOptionIds.has(opt.id);
  }

  function calculateTotal(): number {
    // Nothing to total on an unavailable combination: there is no price, and showing zero would
    // read as free on a form that is going to refuse the submission.
    if (!form || baseCents === null) return 0;
    let total = baseCents;
    for (const item of visibleItems) {
      const val = selections[item.id];
      if (!val || pricedByGrid.has(item.id)) continue;
      if (['single_choice', 'dropdown'].includes(item.type)) {
        const opt = item.options?.find((o) => o.id === val);
        if (opt) total += opt.priceModifier;
      } else if (item.type === 'multiple_choice' && Array.isArray(val)) {
        for (const id of val) {
          const opt = item.options?.find((o) => o.id === id);
          if (opt) total += opt.priceModifier;
        }
      }
    }
    return Math.max(0, total);
  }

  async function handleSubmit() {
    if (!form || submitting) return;
    if (isNotOpenYet && form.opensAt) {
      error = m.form_view_error_not_open({ date: formatFormOpensAt(form.opensAt) });
      return;
    }
    if (!userId.trim()) {
      error = m.form_view_error_login_required();
      return;
    }

    // Validate only visible (non-conditional-hidden) questions
    for (const item of visibleItems) {
      const val = selections[item.id];
      if (item.required) {
        if (['matrix_single', 'matrix_multiple'].includes(item.type)) {
          if (!val) {
            error = m.form_view_error_complete_matrix({ label: item.label });
            return;
          }
          for (const row of item.rows ?? []) {
            const rowVal = val[row];
            if (
              rowVal === undefined ||
              rowVal === null ||
              rowVal === '' ||
              (Array.isArray(rowVal) && rowVal.length === 0)
            ) {
              error = m.form_view_error_complete_row({ row, label: item.label });
              return;
            }
          }
        } else if (Array.isArray(val)) {
          if (val.length === 0) {
            error = m.form_view_error_select_option({ label: item.label });
            return;
          }
        } else if (!val) {
          error = m.form_view_error_answer({ label: item.label });
          return;
        }
      }
    }

    error = '';
    submitting = true;
    try {
      const { formCheckoutCallbacks } = await import('$lib/utils/stripeCallbacks');
      const total = calculateTotal();
      // Only submit answers for visible questions
      const visibleIds = new Set(visibleItems.map((i) => i.id));
      const visibleAnswers = Object.fromEntries(
        Object.entries(selections).filter(([id]) => visibleIds.has(id))
      );
      const res = await submitFormService(form.id, {
        email: '',
        answers: visibleAnswers,
        ...formCheckoutCallbacks(),
        ...(total > 0 && form.allowCashPayment ? { paymentMethod: paymentMethodChoice } : {}),
      });
      if (res.checkoutUrl) {
        // Payment required - check if user has saved payment methods
        if (paymentMethods.length > 0 && res.submissionId) {
          pendingCheckoutUrl = res.checkoutUrl;
          pendingSubmissionId = res.submissionId;
          showPaymentModal = true;
        } else {
          const { navigateExternal } = await import('$lib/utils/openExternal');
          await navigateExternal(res.checkoutUrl);
        }
      } else {
        submitted = true;
        successMessage = res.message || m.form_view_submission_success();
        setTimeout(() => goto(redirectTo), 1500);
      }
    } catch (e: any) {
      error = e.message || m.form_view_error_payment_failed();
    } finally {
      submitting = false;
    }
  }

  async function handlePayWithSaved(paymentMethodId: string) {
    const result = await chargeWithSavedMethod(pendingSubmissionId, paymentMethodId);
    if (result.ok) {
      submitted = true;
      successMessage = m.form_view_payment_success();
      showPaymentModal = false;
      setTimeout(() => goto(redirectTo), 1500);
    }
    // If requiresAction, PaymentModal handles 3DS inline and calls onSuccess
    return result;
  }

  function handlePaySuccess() {
    submitted = true;
    successMessage = m.form_view_payment_success();
    showPaymentModal = false;
    setTimeout(() => goto(redirectTo), 1500);
  }

  async function handlePayWithNew() {
    showPaymentModal = false;
    const { navigateExternal } = await import('$lib/utils/openExternal');
    await navigateExternal(pendingCheckoutUrl);
  }

  async function handlePaymentFailed() {
    if (!pendingSubmissionId) return;
    try {
      await cancelPendingSubmission(pendingSubmissionId);
    } catch {
      // charge-saved-method may have already cancelled server-side
    }
    pendingSubmissionId = '';
    pendingCheckoutUrl = '';
    showPaymentModal = false;
    error = m.form_view_error_payment_failed();
  }

  // ── Progress bar ─────────────────────────────────────────────────
  /** Shared by the progress bar (all visible items) and `allRequiredAnswered` (required ones
   * only) - the same "does this item have a value" check `handleSubmit`'s own validation loop
   * uses per item, so the three never drift into disagreeing about what counts as answered. */
  function isItemAnswered(item: FormItem): boolean {
    const val = selections[item.id];
    if (item.type === 'multiple_choice') return Array.isArray(val) && val.length > 0;
    if (['matrix_single', 'matrix_multiple'].includes(item.type)) {
      if (!val || typeof val !== 'object') return false;
      return (item.rows ?? []).every((row) => {
        const rv = (val as Record<string, any>)[row];
        return (
          rv !== '' && rv !== undefined && rv !== null && (!Array.isArray(rv) || rv.length > 0)
        );
      });
    }
    return val !== '' && val !== undefined && val !== null;
  }
  const totalCount = $derived(visibleItems.length);
  const answeredCount = $derived.by(() => {
    if (!form) return 0;
    return visibleItems.filter(isItemAnswered).length;
  });
  /** What `reachedEnd` waits on: every visible REQUIRED question answered - optional ones do not
   * gate it, matching `handleSubmit`'s own validation, which only ever refuses on `item.required`. */
  const allRequiredAnswered = $derived(
    visibleItems.every((item) => !item.required || isItemAnswered(item))
  );
  const progressPct = $derived(totalCount > 0 ? Math.round((answeredCount / totalCount) * 100) : 0);

  $effect(() => {
    if (!barSentinel) return;
    const root = barSentinel.closest('.page-scroll-wrap');
    const observer = new IntersectionObserver(
      ([entry]) => {
        barSentinelVisible = entry?.isIntersecting ?? false;
      },
      { root, rootMargin: `0px 0px ${-bottomNavHeight}px 0px` }
    );
    observer.observe(barSentinel);
    return () => observer.disconnect();
  });

  $effect(() => {
    if (barSentinelVisible && allRequiredAnswered) reachedEnd = true;
  });
</script>

{#if showPaymentModal && pendingSubmissionId}
  <PaymentModal
    {paymentMethods}
    totalCents={calculateTotal()}
    currency={form?.currency ?? 'eur'}
    onPayWithSaved={handlePayWithSaved}
    onPayWithNew={handlePayWithNew}
    onSuccess={handlePaySuccess}
    onPaymentFailed={handlePaymentFailed}
    onClose={() => (showPaymentModal = false)}
  />
{/if}

<div class="mx-auto max-w-2xl px-4 pt-6">
  <!-- Back + Share -->
  <div class="mb-6 flex items-center justify-between">
    <button
      class="text-text-muted hover:text-text-main inline-flex items-center gap-1.5 text-sm font-semibold transition-colors"
      onclick={() => goto(redirectTo)}
    >
      <ArrowLeft size={15} />
      {m.common_back()}
    </button>
    {#if form}
      <div class="flex items-center gap-1">
        <button
          type="button"
          onclick={copyFormLink}
          class="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors {copiedLink
            ? 'text-green-ok bg-green-50 dark:bg-green-950/20'
            : 'text-text-muted hover:text-text-main hover:bg-cn-border/30'}"
        >
          {#if copiedLink}
            <Check size={13} />{m.form_view_link_copied()}
          {:else}
            <Link size={13} />{m.form_view_share()}
          {/if}
        </button>
        <button
          type="button"
          onclick={() => (qrOpen = true)}
          class="text-text-muted hover:text-text-main hover:bg-cn-border/30 inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors"
        >
          <QrCode size={13} />{m.qr_button()}
        </button>
      </div>
    {/if}
  </div>

  {#if loading}
    <div class="flex justify-center py-24">
      <div
        class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else if error && !form}
    <div class="border-cn-border space-y-3 rounded-3xl border bg-(--cn-surface) p-10 text-center">
      <p class="text-red-err font-semibold">{error}</p>
      <button class="text-text-muted text-sm hover:underline" onclick={() => goto(redirectTo)}
        >{m.common_back()}</button
      >
    </div>
  {:else if form}
    <!-- ── Header ── -->
    <div
      class="border-cn-border mb-5 overflow-hidden rounded-3xl border bg-(--cn-surface) shadow-sm"
    >
      {#if form.imageUrl}
        <div class="relative">
          <img src={form.imageUrl} alt="" class="max-h-72 w-full object-cover" loading="lazy" />
          <div
            class="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-black/60 to-transparent"
          ></div>
          <div class="absolute inset-x-0 bottom-0 flex items-end gap-3 p-5">
            <div class="min-w-0 flex-1">
              <h1 class="text-2xl leading-tight font-extrabold text-white">{form.title}</h1>
              {#if !priceUnavailable && priceCents > 0}
                <span
                  class="bg-cn-yellow text-cn-ink mt-1.5 inline-block rounded-full px-2.5 py-1 text-xs font-bold"
                >
                  {m.form_view_from_price({ price: formatCurrency(priceCents, form.currency) })}
                  {#if appliedPricingLabel}{appliedPricingLabel}{/if}
                </span>
              {/if}
            </div>
            {#if submitted}
              <div class="shrink-0 rounded-xl bg-green-500 p-2 text-white">
                <Check size={20} />
              </div>
            {/if}
          </div>
        </div>
      {:else}
        <div
          class="from-cn-yellow/10 flex items-start gap-4 bg-gradient-to-br via-transparent to-transparent px-6 pt-6 pb-4"
        >
          <div class="bg-cn-yellow/20 text-cn-dark shrink-0 rounded-2xl p-3">
            <ClipboardList size={26} />
          </div>
          <div class="min-w-0 flex-1">
            <h1 class="text-text-main text-2xl leading-tight font-extrabold">{form.title}</h1>
            {#if !priceUnavailable && priceCents > 0}
              <span
                class="bg-cn-yellow text-cn-ink mt-1.5 inline-block rounded-full px-2.5 py-1 text-xs font-bold"
              >
                {m.form_view_from_price({ price: formatCurrency(priceCents, form.currency) })}
                {#if appliedPricingLabel}{appliedPricingLabel}{/if}
              </span>
            {/if}
          </div>
          {#if submitted}
            <div class="bg-green-ok/15 text-green-ok shrink-0 rounded-xl p-2">
              <Check size={20} />
            </div>
          {/if}
        </div>
      {/if}
      {#if form.description?.trim()}
        <div class="border-cn-border/60 border-t px-6 py-4">
          <ProfileBioMarkdown source={form.description} />
        </div>
      {/if}
    </div>

    <!-- ── Progress bar ── -->
    {#if !submitted && totalCount > 0}
      <div class="mb-5 flex items-center gap-3">
        <div class="bg-cn-border/60 h-2 flex-1 overflow-hidden rounded-full">
          <div
            class="bg-cn-yellow h-full rounded-full transition-all duration-500"
            style="width:{progressPct}%"
          ></div>
        </div>
        <span class="text-text-muted shrink-0 text-xs font-bold tabular-nums">
          {answeredCount} / {totalCount}
        </span>
      </div>
    {/if}

    <!-- ── Linked agenda event ── -->
    {#if linkedAgendaEvent}
      <a
        href={agendaAssociationSlug
          ? `/associations/${encodeURIComponent(agendaAssociationSlug)}`
          : '/associations'}
        class="border-cn-yellow/35 bg-cn-yellow/10 hover:bg-cn-yellow/15 mb-4 flex items-center gap-3 rounded-2xl border px-4 py-3 transition-colors"
      >
        <div class="bg-cn-yellow/25 text-cn-dark shrink-0 rounded-xl p-2">
          <CalendarDays size={18} />
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-text-muted text-xs font-bold tracking-wide uppercase">
            {m.form_view_event_linked()}
          </p>
          <p class="text-text-main truncate text-sm font-semibold">{linkedAgendaEvent.title}</p>
        </div>
        <span class="text-cn-dark shrink-0 text-xs font-semibold">{m.form_view_event_see()}</span>
      </a>
    {/if}

    <!-- ── Not open yet ── -->
    {#if isNotOpenYet && form.opensAt}
      <div
        class="mb-4 flex items-center justify-between gap-4 rounded-2xl border border-amber-300/60 bg-amber-50/80 px-4 py-4 dark:bg-amber-950/20"
      >
        <p class="text-sm font-semibold text-amber-800 dark:text-amber-300">
          {m.form_view_opens_at({ date: formatFormOpensAt(form.opensAt) })}
        </p>
        {#if reminder.loaded}
          <button
            type="button"
            onclick={reminder.toggle}
            disabled={reminder.toggling}
            class="flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold transition-colors {reminder.subscribed
              ? 'bg-amber-600 text-white hover:bg-amber-700'
              : 'bg-amber-warn/20 text-amber-warn hover:bg-amber-warn/30'}"
          >
            {#if reminder.subscribed}
              <BellOff size={13} />{m.form_view_reminder_active()}
            {:else}
              <Bell size={13} />{m.form_view_remind_me()}
            {/if}
          </button>
        {/if}
      </div>
    {/if}

    <!-- ── Not open to this person ── -->
    {#if !maySubmit}
      <div class="border-cn-border mb-4 rounded-2xl border bg-(--cn-surface) px-5 py-5 text-center">
        <div
          class="bg-cn-border/40 text-text-muted mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl"
        >
          <Lock size={20} />
        </div>
        <p class="text-text-main text-sm font-bold">{m.form_view_not_open_to_you_title()}</p>
        <p class="text-text-muted mt-1 text-xs">{m.form_view_not_open_to_you_desc()}</p>
      </div>
    {/if}

    <!-- The combination they answered their way into does not exist. Separate from the block above
         on purpose: that one is about who they ARE and is fixed for the whole visit, this one moves
         as they answer and is theirs to undo. -->
    {#if maySubmit && priceUnavailable && !submitted}
      <div
        class="border-cn-border bg-cn-border/10 mb-4 flex items-start gap-3 rounded-2xl border px-5 py-4"
      >
        <div class="text-text-muted shrink-0 pt-0.5"><Ban size={18} /></div>
        <div class="min-w-0">
          <p class="text-text-main text-sm font-bold">{m.form_view_combination_closed_title()}</p>
          <p class="text-text-muted mt-1 text-xs">{m.form_view_combination_closed_desc()}</p>
        </div>
      </div>
    {/if}

    <!-- ── Success ── -->
    {#if successMessage}
      <div
        class="border-green-ok/30 bg-green-ok/10 mb-4 flex items-center gap-3 rounded-2xl border px-5 py-4"
      >
        <div class="text-green-ok shrink-0 rounded-xl bg-green-100 p-2 dark:bg-green-900/40">
          <Check size={20} />
        </div>
        <div>
          <p class="font-bold text-green-700 dark:text-green-300">{successMessage}</p>
          <p class="mt-0.5 text-xs text-green-600/70 dark:text-green-400/70">
            {m.form_view_redirecting()}
          </p>
        </div>
      </div>
    {/if}

    <!-- ── Questions ── -->
    <div class="space-y-3">
      {#each visibleItems as item, qi (item.id)}
        <div class="border-cn-border rounded-2xl border bg-(--cn-surface) p-5 shadow-sm">
          <!-- svelte-ignore a11y_label_has_associated_control -->
          <label class="mb-1.5 flex items-start gap-2">
            <span
              class="text-text-muted bg-cn-border/50 mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold tabular-nums"
            >
              {qi + 1}
            </span>
            <span class="text-text-main text-sm leading-snug font-bold">
              {item.label}
              {#if item.required}<span class="ml-0.5 text-red-500">*</span>{/if}
            </span>
          </label>

          {#if item.description}
            <p class="text-text-muted mb-3 ml-6 text-xs leading-relaxed">{item.description}</p>
          {/if}

          {#if item.imageUrl}
            <div class="border-cn-border/60 mb-3 ml-6 overflow-hidden rounded-xl border">
              <img src={item.imageUrl} alt="" class="max-h-48 w-full object-cover" loading="lazy" />
            </div>
          {/if}

          {#if item.type === 'short_text'}
            <input
              type="text"
              class="border-cn-border text-text-main bg-cn-bg placeholder:text-text-muted/50 focus:border-cn-yellow w-full rounded-2xl border-2 px-4 py-3 text-sm transition-all outline-none focus:shadow-[0_0_0_4px_rgba(250,204,21,0.12)] disabled:opacity-50"
              bind:value={selections[item.id]}
              placeholder={m.form_view_answer_placeholder()}
              disabled={submitted || isNotOpenYet}
            />
          {:else if item.type === 'long_text'}
            <textarea
              rows="4"
              class="border-cn-border text-text-main bg-cn-bg placeholder:text-text-muted/50 focus:border-cn-yellow w-full resize-y rounded-2xl border-2 px-4 py-3 text-sm transition-all outline-none focus:shadow-[0_0_0_4px_rgba(250,204,21,0.12)] disabled:opacity-50"
              bind:value={selections[item.id]}
              placeholder={m.form_view_answer_placeholder()}
              disabled={submitted || isNotOpenYet}></textarea>
          {:else if item.type === 'dropdown' || item.type === 'single'}
            <select
              class="border-cn-border text-text-main bg-cn-bg focus:border-cn-yellow w-full appearance-none rounded-2xl border-2 px-4 py-3 text-sm transition-all outline-none focus:shadow-[0_0_0_4px_rgba(250,204,21,0.12)] disabled:opacity-50"
              bind:value={selections[item.id]}
              disabled={submitted || isNotOpenYet}
            >
              <option value="" disabled>{m.form_view_select_placeholder()}</option>
              {#each item.options ?? [] as opt (opt.id)}
                <option value={opt.id} disabled={optionClosed(opt)}>
                  {opt.label}{optionClosed(opt)
                    ? ` - ${m.form_grid_cell_unavailable()}`
                    : optionModifier(item, opt) > 0
                      ? ` (+${formatCurrency(optionModifier(item, opt), form.currency)})`
                      : optionModifier(item, opt) < 0
                        ? ` (${formatCurrency(optionModifier(item, opt), form.currency)})`
                        : ''}
                </option>
              {/each}
            </select>
          {:else if item.type === 'single_choice'}
            <div class="space-y-2">
              {#each item.options ?? [] as opt (opt.id)}
                <label
                  class="flex cursor-pointer items-center gap-3 rounded-2xl border-2 px-4 py-3 transition-all select-none
                  {selections[item.id] === opt.id
                    ? 'border-cn-yellow bg-cn-yellow/8'
                    : 'border-cn-border hover:border-cn-yellow/60 bg-cn-bg'}
                  {submitted || isNotOpenYet || optionClosed(opt)
                    ? 'cursor-not-allowed opacity-60'
                    : ''}"
                >
                  <input
                    type="radio"
                    name={`radio-${form.id}-${item.id}`}
                    value={opt.id}
                    bind:group={selections[item.id]}
                    class="accent-cn-yellow h-4 w-4 shrink-0"
                    disabled={submitted || isNotOpenYet || optionClosed(opt)}
                  />
                  <span class="text-text-main flex-1 text-sm font-medium">{opt.label}</span>
                  {#if optionClosed(opt)}
                    <!-- Shown rather than hidden: an option that vanishes reads as a bug, and the
                         person needs to see the choice exists but is closed to them. -->
                    <span
                      class="text-text-muted bg-cn-border/50 flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold"
                    >
                      <Ban size={11} />{m.form_grid_cell_unavailable()}
                    </span>
                  {:else if optionModifier(item, opt) !== 0}
                    <span
                      class="text-cn-dark bg-cn-yellow/20 shrink-0 rounded-full px-2 py-0.5 text-xs font-bold"
                    >
                      {optionModifier(item, opt) > 0 ? '+' : ''}{formatCurrency(
                        optionModifier(item, opt),
                        form.currency
                      )}
                    </span>
                  {/if}
                </label>
              {/each}
            </div>
          {:else if item.type === 'multiple_choice'}
            <div class="space-y-2">
              {#each item.options ?? [] as opt (opt.id)}
                <label
                  class="flex cursor-pointer items-center gap-3 rounded-2xl border-2 px-4 py-3 transition-all select-none
                  {(selections[item.id] ?? []).includes(opt.id)
                    ? 'border-cn-yellow bg-cn-yellow/8'
                    : 'border-cn-border hover:border-cn-yellow/60 bg-cn-bg'}
                  {submitted || isNotOpenYet || optionClosed(opt)
                    ? 'cursor-not-allowed opacity-60'
                    : ''}"
                >
                  <input
                    type="checkbox"
                    value={opt.id}
                    bind:group={selections[item.id]}
                    class="accent-cn-yellow h-4 w-4 shrink-0 rounded"
                    disabled={submitted || isNotOpenYet || optionClosed(opt)}
                  />
                  <span class="text-text-main flex-1 text-sm font-medium">{opt.label}</span>
                  {#if optionClosed(opt)}
                    <!-- Shown rather than hidden: an option that vanishes reads as a bug, and the
                         person needs to see the choice exists but is closed to them. -->
                    <span
                      class="text-text-muted bg-cn-border/50 flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold"
                    >
                      <Ban size={11} />{m.form_grid_cell_unavailable()}
                    </span>
                  {:else if optionModifier(item, opt) !== 0}
                    <span
                      class="text-cn-dark bg-cn-yellow/20 shrink-0 rounded-full px-2 py-0.5 text-xs font-bold"
                    >
                      {optionModifier(item, opt) > 0 ? '+' : ''}{formatCurrency(
                        optionModifier(item, opt),
                        form.currency
                      )}
                    </span>
                  {/if}
                </label>
              {/each}
            </div>
          {:else if item.type === 'linear_scale'}
            <div>
              <div class="text-text-muted mb-2 flex justify-between px-1 text-xs font-semibold">
                <span>{item.scale?.minLabel || item.scale?.min}</span>
                <span>{item.scale?.maxLabel || item.scale?.max}</span>
              </div>
              <div
                class="border-cn-border bg-cn-bg flex items-stretch gap-1 overflow-hidden rounded-2xl border-2"
              >
                {#each Array.from({ length: (item.scale?.max || 5) - (item.scale?.min || 1) + 1 }, (_, i) => (item.scale?.min || 1) + i) as val (val)}
                  <label
                    class="flex flex-1 cursor-pointer flex-col items-center justify-center gap-1.5 py-3 transition-all select-none
                    {selections[item.id] === val ? 'bg-cn-yellow/15' : 'hover:bg-cn-border/30'}
                    {submitted || isNotOpenYet ? 'cursor-not-allowed opacity-60' : ''}"
                  >
                    <input
                      type="radio"
                      name={`scale-${form.id}-${item.id}`}
                      value={val}
                      bind:group={selections[item.id]}
                      class="accent-cn-yellow h-4 w-4"
                      disabled={submitted || isNotOpenYet}
                    />
                    <span class="text-text-muted text-xs font-bold">{val}</span>
                  </label>
                {/each}
              </div>
            </div>
          {:else if ['matrix_single', 'matrix_multiple'].includes(item.type)}
            <div class="border-cn-border overflow-x-auto rounded-2xl border-2">
              <table class="w-full border-separate border-spacing-0 text-sm">
                <thead>
                  <tr class="bg-cn-border/20">
                    <th class="sticky left-0 z-10 w-1/3 min-w-[120px] bg-(--cn-surface) p-3"></th>
                    {#each item.options ?? [] as col (col.id)}
                      <th
                        class="text-text-muted min-w-[80px] px-3 py-3 text-center text-xs font-bold tracking-wide uppercase"
                        >{col.label}</th
                      >
                    {/each}
                  </tr>
                </thead>
                <tbody>
                  {#each item.rows ?? [] as row (row)}
                    <tr class="hover:bg-cn-border/10 transition-colors">
                      <td
                        class="text-text-main border-cn-border sticky left-0 z-10 border-t bg-(--cn-surface) px-3 py-3 text-sm font-medium"
                        >{row}</td
                      >
                      {#each item.options ?? [] as col (col.id)}
                        <td class="border-cn-border border-t py-3 text-center">
                          {#if item.type === 'matrix_single'}
                            <input
                              type="radio"
                              name={`matrix-${form.id}-${item.id}-${row}`}
                              value={col.id}
                              bind:group={selections[item.id][row]}
                              class="accent-cn-yellow h-4 w-4"
                              disabled={submitted || isNotOpenYet}
                            />
                          {:else}
                            <input
                              type="checkbox"
                              value={col.id}
                              bind:group={selections[item.id][row]}
                              class="accent-cn-yellow h-4 w-4"
                              disabled={submitted || isNotOpenYet}
                            />
                          {/if}
                        </td>
                      {/each}
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else}
            <div class="bg-red-err/10 text-red-err border-red-err/30 rounded-xl border p-3 text-xs">
              Unsupported type: <strong>{item.type}</strong>
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <!-- ── Payment method (cash vs Stripe) ── -->
    {#if calculateTotal() > 0 && form.allowCashPayment && !submitted}
      <div class="border-cn-border mt-4 rounded-2xl border bg-(--cn-surface) p-5">
        <p class="text-text-muted mb-3 text-xs font-bold tracking-wide uppercase">
          {m.form_view_payment_mode_heading()}
        </p>
        <div class="grid grid-cols-2 gap-2">
          <label
            class="flex cursor-pointer items-center gap-2.5 rounded-2xl border-2 px-4 py-3 transition-all select-none {paymentMethodChoice ===
            'stripe'
              ? 'border-cn-yellow bg-cn-yellow/8'
              : 'border-cn-border hover:border-cn-yellow/50'}"
          >
            <input
              type="radio"
              bind:group={paymentMethodChoice}
              value="stripe"
              class="accent-cn-yellow"
            />
            <div>
              <p class="text-text-main text-sm font-semibold">{m.form_view_online_label()}</p>
              <p class="text-text-muted text-xs">{m.form_view_online_desc()}</p>
            </div>
          </label>
          <label
            class="flex cursor-pointer items-center gap-2.5 rounded-2xl border-2 px-4 py-3 transition-all select-none {paymentMethodChoice ===
            'cash'
              ? 'border-cn-yellow bg-cn-yellow/8'
              : 'border-cn-border hover:border-cn-yellow/50'}"
          >
            <input
              type="radio"
              bind:group={paymentMethodChoice}
              value="cash"
              class="accent-cn-yellow"
            />
            <div>
              <p class="text-text-main text-sm font-semibold">{m.form_view_cash_label()}</p>
              <p class="text-text-muted text-xs">{m.form_view_cash_desc()}</p>
            </div>
          </label>
        </div>
      </div>
    {/if}

    <!-- ── Error ── -->
    {#if error}
      <div
        class="border-red-err/30 bg-red-err/10 text-red-err mt-4 rounded-2xl border px-4 py-3 text-sm font-medium dark:bg-red-950/20"
      >
        {error}
      </div>
    {/if}
  {/if}
</div>

<!-- ── Submit bar: sits at the end by default, sticks for good once earned ── -->
{#if form && !loading}
  <!-- `position: sticky`, never `fixed`: .page-scroll-wrap (the ancestor this bar renders
       inside) has `will-change: transform` (app.css, for swipe-nav-between-tabs), which makes
       it the containing block for `position: fixed` descendants - and on real mobile browsers,
       a `fixed` descendant of a `will-change: transform` ancestor can lose its own compositing
       layer mid-scroll and disappear entirely until the next reflow (measured on-device: it
       vanished after a scroll and never came back on its own). `sticky` is not redirected by a
       transformed ancestor the same way and is computed against the actual scrolling viewport,
       so it does not carry that failure mode.

       Only this OUTER wrapper's position/spacing changes between the two states - the card
       inside keeps the exact same look either way, so detaching from the flow at `reachedEnd`
       reads as the same bar continuing to float, never as a swap to a different-looking element.

       No `calc(4rem + safe-area)` clearance and no manually measured/reserved height either:
       `position: sticky` never leaves the document flow the way `fixed` does, so the browser
       already reserves this bar's own natural spot on its own - reaching the true bottom always
       settles it back there, right after the last question, for free. -->
  <div
    class="keyboard-aware-bottom mx-auto max-w-2xl px-4 {reachedEnd
      ? 'sticky bottom-0 z-50 pb-3 md:pb-5'
      : 'mt-6'}"
  >
    <div
      class="border-cn-border/60 flex items-center gap-3 rounded-2xl border bg-(--cn-surface)/90 px-4 py-3 shadow-lg backdrop-blur-xl"
    >
      <div class="min-w-0 flex-1">
        {#if submitted}
          <span class="text-green-ok flex items-center gap-1.5 text-sm font-bold"
            ><Check size={16} /> {m.form_view_response_sent()}</span
          >
        {:else if priceUnavailable}
          <span class="text-text-muted text-sm">{m.form_view_combination_closed_title()}</span>
        {:else if calculateTotal() > 0}
          <div>
            <p class="text-text-muted text-xs font-medium">{m.form_view_total_to_pay()}</p>
            <p class="text-cn-dark text-lg font-extrabold">
              {formatCurrency(calculateTotal(), form.currency)}
            </p>
          </div>
        {:else}
          <span class="text-text-muted text-sm">{m.form_view_submit()}</span>
        {/if}
      </div>
      <Button
        variant="primary"
        class="shrink-0 px-6"
        disabled={submitted ||
          formFull ||
          submitting ||
          isNotOpenYet ||
          !maySubmit ||
          priceUnavailable}
        loading={submitting}
        onclick={handleSubmit}
      >
        {#if paymentPending}
          <Check size={16} class="mr-1.5" />{m.form_view_pending()}
        {:else if submitted}
          <Check size={16} class="mr-1.5" />{m.form_view_sent()}
        {:else if !maySubmit}
          {m.form_view_not_open_to_you_title()}
        {:else if priceUnavailable}
          {m.form_view_combination_closed_title()}
        {:else if formFull}
          {m.form_view_full()}
        {:else if calculateTotal() > 0}
          <CreditCard size={16} class="mr-1.5" />{m.form_view_pay_button({
            amount: formatCurrency(calculateTotal(), form.currency),
          })}
        {:else}
          <Check size={16} class="mr-1.5" />{m.form_view_submit()}
        {/if}
      </Button>
    </div>

    {#if paymentPending}
      <p class="text-amber-warn mt-2 text-center text-sm font-medium">
        {m.form_view_payment_pending_note()}
      </p>
    {:else if formFull && !submitted}
      <p class="text-text-muted mt-2 text-center text-sm font-medium">
        {m.form_view_form_full_note()}
      </p>
    {/if}

    {#if !submitted && form.requiresPayment && paymentMethods.length === 0 && userId}
      <div class="mt-2 flex justify-center">
        <button
          type="button"
          onclick={() => void handleSaveCard()}
          disabled={savingCard}
          class="text-text-muted hover:text-text-main inline-flex items-center gap-1.5 text-xs underline underline-offset-2 disabled:opacity-50"
        >
          <CreditCard size={13} />
          {savingCard ? m.form_view_saving_card() : m.form_view_save_card()}
        </button>
      </div>
    {/if}
  </div>

  <div bind:this={barSentinel}></div>
{/if}

{#if form && qrOpen}
  <QrCodeModal
    open
    url={publicAppUrl(formPath)}
    label={form.title}
    owner={form.associationName}
    intro={m.form_qr_intro()}
    onClose={() => (qrOpen = false)}
  />
{/if}
