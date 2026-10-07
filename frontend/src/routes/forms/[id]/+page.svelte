<script lang="ts">
  import { internalPath, safeInternalPath } from '$lib/utils/internalPath';
  import { resolve } from '$app/paths';
  import { Log } from '$lib/utils/Log';
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
    FormNotFoundError,
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
  import { OTHERS_BUCKET_ID, cellKey, hasCell, type CellValue } from '$lib/pricing/priceMatrix';
  import { formatFormOpensAt, formOpensAtIso } from '$lib/posts/postComposerDraft';
  import {
    getCalendarEventLinkedToForm,
    getAssociation,
    type AssociationCalendarEvent,
  } from '$lib/associations/api';
  import { useFormReminder } from '$lib/posts/useFormReminder.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import PaymentModal from '$lib/components/ui/PaymentModal.svelte';
  import FormHeader from '$lib/components/forms/FormHeader.svelte';
  import FormQuestion from '$lib/components/forms/FormQuestion.svelte';
  import {
    firstMissingAnswer,
    formatAmount as formatCurrency,
    initialSelections,
    isItemAnswered,
    missingAnswerMessage,
    visibleAnswers,
    visibleItems as visibleItemsOf,
  } from '$lib/forms/fillAnswers';
  import {
    ArrowLeft,
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
  import PayerEmailPrompt from '$lib/components/payments/PayerEmailPrompt.svelte';
  import {
    activePaymentProvider,
    loadActivePaymentProvider,
  } from '$lib/associations/activePaymentProvider.svelte';
  import { supportsSavedCards } from '$lib/associations/paymentProviderCopy';
  import { providerRefusalMessage } from '$lib/associations/paymentRefusal';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import { PAGE_WIDTHS } from '$lib/components/layout/pageWidth';

  const formId = $derived(page.params.id);
  const redirectTo = $derived(safeInternalPath(page.url.searchParams.get('redirect'), '/posts'));

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
  let askingPayerEmail = $state(false);
  let pendingCheckoutUrl = $state('');
  let pendingSubmissionId = $state('');
  let linkedAgendaEvent = $state<AssociationCalendarEvent | null>(null);
  let agendaAssociationSlug = $state('');
  let paymentMethodChoice = $state<'stripe' | 'cash'>('stripe');
  let copiedLink = $state(false);

  // ── Submit bar: sits at the end by default, sticks for good once earned ─────
  /** Marks the bar's natural position - placed AFTER the bar (not before), so reaching it means
   * the submitter has scrolled PAST the whole bar, not merely up to its edge. */
  let barSentinel: HTMLDivElement | undefined = $state();
  /** One-way latch: true once the submitter has scrolled far enough to see the whole bar AND
   * every required question was answered at that moment. Never resets - reaching the end is a
   * milestone, not a live state. Once true, the bar sticks to the bottom of the screen FOR GOOD -
   * `position: sticky` (unlike `fixed`) never leaves the document flow, so it still settles back
   * into its own natural spot, right after the last question, once scrolled all the way down;
   * nothing needs to manually reserve space for it. */
  let reachedEnd = $state(false);
  /** BottomNav's real rendered height (mobile only; 0 on desktop where it does not mount) - the
   * sentinel must also clear this to count as "reached", not just its own edge. Measured in
   * $effect rather than as a top-level const: top-level script runs during construction, before
   * the DOM is mounted and laid out, so `clientHeight` would read 0 there regardless of CSS.
   *
   * AND THAT IS WHY `prefer-writable-derived` IS WRONG HERE, rather than unaddressed. A `$derived`
   * is evaluated on first READ, which happens during the first render - before mount - and it has
   * no reactive dependency on the DOM, so it would latch 0 and never recompute. Taking the lint's
   * advice would turn a working measurement into a constant zero. */
  // oxlint-disable-next-line svelte/prefer-writable-derived
  let bottomNavHeight = $state(0);
  $effect(() => {
    bottomNavHeight = document.querySelector('#bottom-nav')?.clientHeight ?? 0;
  });

  /** Whether the sentinel has scrolled far enough up to also clear `BottomNav` below it. Computed
   * fresh from the DOM every call, deliberately NOT cached in reactive state - see the effect
   * below for why that distinction is what makes this whole mechanism work. */
  function sentinelReached(): boolean {
    if (!barSentinel) return false;
    const root = barSentinel.closest('.page-scroll-wrap');
    if (!root) return false;
    // Tolerance, not exactness: `bottomNavHeight` (a measured `clientHeight`) and
    // `.page-scroll-wrap`'s own reserved end-of-content padding (a CSS `calc()` of nominally the
    // SAME `4rem + safe-area`) are computed independently and never land bit-for-bit identical -
    // measured on-device, the sentinel's own top sat 0.05px short of the threshold at the actual
    // maximum scroll position, meaning an exact comparison could never be satisfied at all, even
    // scrolled as far as the page physically allows. A few pixels of slack costs nothing semantic
    // (the sentinel still has to have scrolled essentially all the way up) and admits the
    // sub-pixel rounding every browser's layout engine introduces.
    const TOLERANCE_PX = 4;
    return (
      barSentinel.getBoundingClientRect().top <=
      root.getBoundingClientRect().bottom - bottomNavHeight + TOLERANCE_PX
    );
  }
  /** `totalCount` as of the last genuine scroll (or the initial mount check). Gates the reactive
   * fallback below: a form short enough to need only ONE scroll to see everything can have its
   * LAST required answer arrive as a click, with the submitter already parked at the bottom - no
   * further scroll ever happens to run the check above, so nothing would ever latch. But that
   * same click can ALSO be the one that reveals a further `showIf`-conditional question, and that
   * must still wait for a real scroll (the original bug this whole mechanism exists to avoid).
   * The two are told apart by whether `totalCount` moved since the last scroll: unchanged means
   * nothing new rendered, so it is safe to check immediately; changed means it is not. */
  let lastScrollTotalCount = $state(0);

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
      Log.d('handleSaveCard failed', err);
      showToast(m.form_card_registration_error());
    } finally {
      savingCard = false;
    }
  }

  /**
   * The one place this screen says where the form lives, shared by both share controls. A public
   * form is shared by its GUEST address, the one that opens without an account; a member opening
   * that link is sent back here.
   */
  const formPath = $derived(form?.isPublic ? `/f/${formId}` : `/forms/${formId}`);
  let qrOpen = $state(false);

  function copyFormLink() {
    void copyPublicShareLink(formPath);
    copiedLink = true;
    setTimeout(() => (copiedLink = false), 2000);
  }

  onMount(async () => {
    void loadActivePaymentProvider();
    const savedUser = currentUserId();
    if (savedUser) {
      userId = savedUser;
      // NOT AWAITED, AND IT NEVER HAD TO BE. The comment below has always said the form loads fine
      // without a pre-fetched token, so awaiting it put a silent refresh - a full round trip -
      // in front of the form itself. `refresh()` holds one request in flight for every caller, so
      // the `apiFetch` right after joins this one rather than starting a second.
      void getToken().catch(() => {
        // Silently ignore - the form loads fine without a pre-fetched token;
        // apiFetch will retry on the first API call.
      });
    }

    try {
      const id = formId;
      if (!id) {
        error = m.form_view_not_found();
        loading = false;
        return;
      }
      const f = await getForm(id);
      form = f;
      selections = initialSelections(f.items);

      linkedAgendaEvent = null;
      agendaAssociationSlug = '';

      /**
       * THE BANNER AND THE FORM'S OWN STATE ARE INDEPENDENT, SO THEY ARE ASKED FOR TOGETHER.
       *
       * `getCalendarEventLinkedToForm` decides whether a "see the event" banner appears, and it
       * used to be awaited BEFORE `checkSubmission` - which decides whether the reader may submit
       * at all, what it costs and which items are hidden. A decoration was holding the form's
       * controls, and when the banner did exist it held them through a SECOND round trip for the
       * association's slug. That one still follows its event, because it needs its id - but it
       * follows it behind the page rather than in front of it.
       */
      const [linked, submission] = await Promise.all([
        getCalendarEventLinkedToForm(f.id).catch(() => ({ linkedEvent: null })),
        checkSubmission(f.id),
      ]);
      linkedAgendaEvent = linked.linkedEvent;
      if (linked.linkedEvent) {
        void getAssociation(linked.linkedEvent.associationId)
          .then((asso) => {
            agendaAssociationSlug = asso.slug;
          })
          .catch(() => {
            agendaAssociationSlug = '';
          });
      }

      const {
        hasSubmitted,
        paymentStatus,
        formFull: full,
        pricing: view,
        hiddenItemIds: hidden,
        maySubmit: allowed,
      } = submission;
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
      error =
        e instanceof FormNotFoundError
          ? m.form_view_not_found()
          : e.message || m.form_view_load_error();
    } finally {
      loading = false;
    }
  });

  /**
   * Questions that pass their display check.
   *
   * The PROFILE half was already decided by the server (`hiddenItemIds`) - a browser cannot be
   * trusted with someone's cotisation or promo, and would have to be told them to evaluate it. What
   * is left is the answer half, which is what this page has always evaluated.
   */
  const visibleItems = $derived(
    // Nothing to fill in when the form is not open to this person - the questions would only
    // invite an answer the server is going to refuse.
    form && maySubmit ? visibleItemsOf(form.items, selections, new Set(hiddenItemIds)) : []
  );

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

  async function handleSubmit(payerEmail?: string) {
    if (!form || submitting) return;
    if (isNotOpenYet && form.opensAt) {
      error = m.form_view_error_not_open({ date: formatFormOpensAt(form.opensAt) });
      return;
    }
    if (!userId.trim()) {
      error = m.form_view_error_login_required();
      return;
    }

    const missing = firstMissingAnswer(visibleItems, selections);
    if (missing) {
      error = missingAnswerMessage(missing);
      return;
    }

    // Lydia's request/do needs the payer's address and Canari stores none, so the payer types it.
    const total = calculateTotal();
    const paysOnline = total > 0 && !(form.allowCashPayment && paymentMethodChoice === 'cash');
    if (paysOnline && !payerEmail && activePaymentProvider.current === 'lydia') {
      askingPayerEmail = true;
      return;
    }

    error = '';
    submitting = true;
    try {
      const { formCheckoutCallbacks } = await import('$lib/utils/stripeCallbacks');
      const res = await submitFormService(form.id, {
        email: '',
        ...(payerEmail ? { payerEmail } : {}),
        answers: visibleAnswers(visibleItems, selections),
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
        successMessage = m.form_view_submission_success();
        setTimeout(() => goto(resolve(internalPath(redirectTo))), 1500);
      }
    } catch (e: any) {
      error = providerRefusalMessage(e) ?? (e.message || m.form_view_error_payment_failed());
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
      setTimeout(() => goto(resolve(internalPath(redirectTo))), 1500);
    }
    // If requiresAction, PaymentModal handles 3DS inline and calls onSuccess
    return result;
  }

  function handlePaySuccess() {
    submitted = true;
    successMessage = m.form_view_payment_success();
    showPaymentModal = false;
    setTimeout(() => goto(resolve(internalPath(redirectTo))), 1500);
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
  const totalCount = $derived(visibleItems.length);
  const answeredCount = $derived.by(() => {
    if (!form) return 0;
    return visibleItems.filter((item) => isItemAnswered(item, selections[item.id])).length;
  });
  /** What `reachedEnd` waits on: every visible REQUIRED question answered - optional ones do not
   * gate it, matching `handleSubmit`'s own validation, which only ever refuses on `item.required`. */
  const allRequiredAnswered = $derived(
    visibleItems.every((item) => !item.required || isItemAnswered(item, selections[item.id]))
  );
  const progressPct = $derived(totalCount > 0 ? Math.round((answeredCount / totalCount) * 100) : 0);

  $effect(() => {
    const root = barSentinel?.closest('.page-scroll-wrap');
    if (!root) return;
    // Deliberately event-driven, not reactive to `allRequiredAnswered`: answering a question -
    // including the one that reveals a further `showIf`-conditional question right above this
    // sentinel - is a click, never a `scroll` event, so it can never run this check by itself.
    // Only an actual scroll action re-evaluates the CURRENT, live DOM state, which is why this
    // reads live geometry (`sentinelReached()`) rather than a cached `$state` flag updated by an
    // IntersectionObserver: that flag is only as fresh as the browser's own async scheduling of
    // the observer callback, and a fresh reading can still say "still visible" if the new content
    // fit inside existing slack - reintroducing the same premature latch one tick later. The
    // one-off call right after attaching the listener is what still lets a form short enough to
    // need no scrolling at all latch once its last required answer comes in - and also seeds
    // `lastScrollTotalCount` for the reactive fallback below, before any scroll has happened yet.
    const check = () => {
      lastScrollTotalCount = totalCount;
      if (!reachedEnd && allRequiredAnswered && sentinelReached()) reachedEnd = true;
    };
    root.addEventListener('scroll', check, { passive: true });
    check();
    return () => root.removeEventListener('scroll', check);
  });

  $effect(() => {
    // Reactive fallback for a form short enough that seeing everything only ever takes ONE
    // scroll: the submitter can answer the LAST required question - a click - while already
    // parked at the bottom, and no further scroll would ever happen to run the check above.
    // Gated on `totalCount` matching its value as of the last real scroll: unchanged means this
    // answer did not also reveal a new question, so nothing here relies on a stale reading the
    // way the scroll-driven check's own comment warns against - it means there is nothing NEW
    // to have missed since that last scroll actually measured this same layout.
    if (
      !reachedEnd &&
      allRequiredAnswered &&
      totalCount === lastScrollTotalCount &&
      sentinelReached()
    ) {
      reachedEnd = true;
    }
  });
</script>

{#if askingPayerEmail}
  <PayerEmailPrompt
    onSubmit={(email) => {
      askingPayerEmail = false;
      void handleSubmit(email);
    }}
    onClose={() => (askingPayerEmail = false)}
  />
{/if}

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

<!--
  THE PAGE COLUMN IS DECLARED. This was `mx-auto max-w-2xl` - 672px, eight pixels off the reading
  measure and belonging to no scale, which is the same thing `/legal/*` was carrying when the width
  sweep reached it. A form being filled in is a column of prose with inputs in it, so it takes the
  measure the feed sets rather than one this page chose for itself.
-->
<PageContainer width="reading">
  <!-- Back + Share -->
  <div class="mb-6 flex items-center justify-between">
    <button
      class="text-text-muted hover:text-text-main inline-flex items-center gap-1.5 text-sm font-semibold transition-colors"
      onclick={() => goto(resolve(internalPath(redirectTo)))}
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
      <button
        class="text-text-muted text-sm hover:underline"
        onclick={() => goto(resolve(internalPath(redirectTo)))}>{m.common_back()}</button
      >
    </div>
  {:else if form}
    <!-- ── Header ── -->
    <FormHeader
      {form}
      priceLabel={!priceUnavailable && priceCents > 0
        ? m.form_view_from_price({ price: formatCurrency(priceCents, form.currency) }) +
          appliedPricingLabel
        : null}
      {submitted}
    />

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
        href={resolve(
          agendaAssociationSlug
            ? `/associations/${encodeURIComponent(agendaAssociationSlug)}`
            : '/associations'
        )}
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
              ? 'text-cn-ink bg-amber-600 hover:bg-amber-700'
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
        <FormQuestion
          {item}
          index={qi}
          bind:value={selections[item.id]}
          disabled={submitted || isNotOpenYet}
          formId={form.id}
          currency={form.currency}
          {optionModifier}
          {optionClosed}
        />
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
</PageContainer>

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
  <!--
    THE STICKY BAR LINES UP WITH THE COLUMN ABOVE IT, and takes its width from the same declaration
    rather than repeating a number. It cannot simply live INSIDE the column: it is rendered outside
    it so that it can stick to the viewport, so the alignment has to be restated - but restating the
    VALUE is what let the two drift apart in the first place. The padding matches `PageContainer`'s
    at every breakpoint for the same reason.
  -->
  <div
    class="keyboard-aware-bottom mx-auto {PAGE_WIDTHS.reading} px-4 pb-3 md:px-8 {reachedEnd
      ? 'sticky bottom-0 z-50 md:pb-5'
      : ''}"
  >
    <div
      class="border-cn-border/60 bg-cn-surface flex items-center gap-3 rounded-2xl border px-4 py-3 shadow-lg"
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
            <p class="text-cn-dark text-lg font-bold">
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
        onclick={() => void handleSubmit()}
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

    {#if !submitted && form.requiresPayment && paymentMethods.length === 0 && userId && supportsSavedCards(activePaymentProvider.current)}
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
