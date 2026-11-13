<script lang="ts">
  import { safeInternalPath } from '$lib/utils/internalPath';
  import { gotoAppPath } from '$lib/navigation/gotoAppPath';
  import { resolve } from '$app/paths';
  import { Log } from '$lib/utils/Log';
  import { describeApiRefusal, refusalStatus } from '$lib/utils/apiRefusal';
  import { page } from '$app/state';
  import { onMount, untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { getToken } from '$lib/stores/auth';
  import { showToast } from '$lib/stores/toast.svelte';
  import { currentUserId, getSavedDisplayName } from '$lib/stores/user';
  import {
    FormNotFoundError,
    getForm,
    getFormDraft,
    submitForm as submitFormService,
    checkSubmission,
    type PricingView,
    getSubmission,
    cancelPendingSubmission,
    confirmSubmissionPayment,
    editFormAnswer,
    getMyEditableAnswers,
    type EditableAnswer,
    type Form,
  } from '$lib/forms/api';
  import { fillPriceState, optionModifierOf } from '$lib/forms/fillPricing';
  import type { ProductGridPrices } from '$lib/forms/productGridContract';
  import { appliedTierLabels, isProductGrid } from '$lib/forms/productGridFill';
  import { formatFormOpensAt, formOpensAtIso } from '$lib/posts/postComposerDraft';
  import {
    getCalendarEventLinkedToForm,
    getAssociation,
    type AssociationCalendarEvent,
  } from '$lib/associations/api';
  import {
    createPaymentReader,
    watchReturnsToApp,
    type PaymentReader,
  } from '$lib/forms/checkoutReturn';
  import { isMobileTauri } from '$lib/utils/checkoutCallbacks';
  import type { PaymentReturnOutcome } from '$lib/forms/paymentReturnPoll';
  import { useFormReminder } from '$lib/posts/useFormReminder.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import FormHeader from '$lib/components/forms/FormHeader.svelte';
  import FormQuestion from '$lib/components/forms/FormQuestion.svelte';
  import FormViewerTier from '$lib/components/forms/FormViewerTier.svelte';
  import ProductGridQuestion from '$lib/components/forms/ProductGridQuestion.svelte';
  import ProductGridOrderBar from '$lib/components/forms/ProductGridOrderBar.svelte';
  import PaymentMethodChoice from '$lib/components/forms/PaymentMethodChoice.svelte';
  import {
    allRequiredAnswered as allRequiredAnsweredOf,
    editedAnswers,
    firstMissingAnswer,
    formatAmount as formatCurrency,
    initialSelections,
    isOrderEmpty,
    ORDER_MISSING_ID,
    revealOrderMissing,
    selectionsFromAnswers,
    isItemAnswered,
    missingAnswerMessage,
    visibleAnswers,
    visibleItems as visibleItemsOf,
    type MissingAnswer,
  } from '$lib/forms/fillAnswers';
  import { gridRequiredSwitchOn } from '$lib/forms/gridRequiredGate';
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
    Pencil,
  } from '@lucide/svelte';
  import { formSharePath } from '$lib/forms/shareLink';
  import { copyPublicShareLink } from '$lib/utils/copyShareLink';
  import { publicAppUrl } from '$lib/utils/publicAppUrl';
  import QrCodeModal from '$lib/components/shared/QrCodeModal.svelte';
  import { m } from '$lib/paraglide/messages';
  import PayerEmailPrompt from '$lib/components/payments/PayerEmailPrompt.svelte';
  import {
    activePaymentProvider,
    loadActivePaymentProvider,
  } from '$lib/associations/activePaymentProvider.svelte';
  import { FORM_COTISATION_HELD } from '$lib/associations/paymentRefusal';
  import { formSubmitRefusalMessage } from '$lib/forms/answerBounds';
  import { offersAnswerEdit } from '$lib/forms/answerEditGate';
  import { serverFormAnswerEdit } from '$lib/stores/appVersionCheck.svelte';
  import { FORM_PREVIEW_PARAM, isDraftForm, isPreview, offersOnlyCash } from '$lib/forms/publish';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import { PAGE_WIDTHS } from '$lib/components/layout/pageWidth';

  const formId = $derived(page.params.id);
  const redirectTo = $derived(safeInternalPath(page.url.searchParams.get('redirect'), '/posts'));

  /** Leaves the form for `redirectTo`; a navigation that rejects is logged, never dropped. */
  function leaveForm(): void {
    gotoAppPath(redirectTo).catch((err: unknown) =>
      console.error('[forms] leaving the form for its redirect target failed:', err)
    );
  }

  let form = $state<Form | null>(null);
  const opensLaterIso = $derived(form?.opensAt ? formOpensAtIso(form.opensAt) : null);
  const isNotOpenYet = $derived(!!opensLaterIso);
  const reminder = useFormReminder(() => formId ?? '');
  let selections = $state<Record<string, any>>({});
  let submitted = $state(false);
  let paymentPending = $state(false);
  /**
   * Set when the request a pending answer waited on is dead (declined by the payer, or cancelled /
   * expired): the server released the answer, and the pay button is the retry.
   */
  let paymentRetry = $state<'declined' | 'ended' | null>(null);
  /**
   * The pending answer this page watches: its reader, and Lydia's payer page when THIS page handed
   * the payer to it (null when the pending answer was found on load: the page never had its
   * address). While set and pending, every return of the app to the screen reads the answer once.
   *
   * RAW, AND ITS IDENTITY IS THE CHECKOUT'S GENERATION. A read answers about the checkout it was
   * asked for: when it lands after the page moved on (the answer released by another read, then
   * paid again under the SAME answer id), its checkout is no longer this one and it is dropped.
   */
  let pendingCheckout = $state.raw<{
    submissionId: string;
    checkoutUrl: string | null;
    reader: PaymentReader;
  } | null>(null);
  /** The phones only: a desktop window switch fires no return edge, so it is never promised there. */
  const updatesOnReturn = isMobileTauri();
  /** The payment landed after the form filled up: final, and the organiser owes a refund. */
  let paidOverCapacity = $state(false);
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
  /** This member's prices on each priced grid (`product_grid`), their category resolved server-side. */
  let productGridPrices = $state<ProductGridPrices>({});
  /**
   * The required question the last send stopped on: its card says why, until it is answered. Kept
   * as the refusal rather than its sentence, so the card stops saying it the moment it is answered.
   */
  let missingAnswer = $state<MissingAnswer | null>(null);
  /** Questions a profile criterion hides from this submitter, whatever they answer. */
  let hiddenItemIds = $state<string[]>([]);
  /** False when a `submitCondition` excludes them from the form entirely. */
  let maySubmit = $state(true);
  /**
   * True when what excludes them is a cotisation they already hold and the form is for people
   * without it - typed by the server (`refusalCode`), so the notice says so instead of "not for you".
   */
  let cotisationHeld = $state(false);
  let submitting = $state(false);
  /**
   * The caller's answers they may still change (forms.md, "A respondent changes their own
   * answer"): empty unless the form allows it, is not anonymous and is open - the server decides.
   */
  let editableAnswers = $state<EditableAnswer[]>([]);
  /** The answer being changed, or null: the questions then draw IT, its price-setting ones locked. */
  let editing = $state<EditableAnswer | null>(null);
  /** The locked questions of the answer being changed: drawn read-only, never sent. */
  const editLocked = $derived(new Set(editing?.lockedItemIds ?? []));
  let loading = $state(true);
  let error = $state('');
  let successMessage = $state('');
  /** The line under the success banner: the redirect after a send, or what a confirmed payment means. */
  let successDetail = $state('');
  let userId = $state('');

  // Payment
  let askingPayerEmail = $state(false);
  let linkedAgendaEvent = $state<AssociationCalendarEvent | null>(null);
  let agendaAssociationSlug = $state('');
  let paymentMethodChoice = $state<'online' | 'cash'>('online');
  /** Whether the page draws an unpublished revision a manager read (never a respondent's view). */
  let revisionShown = $state(false);
  /**
   * A PREVIEW (a draft, or "Voir le formulaire" on unpublished changes): the questions are drawn and
   * nothing can be sent - the server would refuse a draft anyway (owner, 2026-11-08).
   */
  const preview = $derived(isPreview(form, revisionShown));
  /** Online is paused and cash is accepted: the answer is paid in cash, no online choice shown. */
  const cashOnly = $derived(offersOnlyCash(form));
  $effect(() => {
    if (cashOnly) paymentMethodChoice = 'cash';
  });

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

  /**
   * The one place this screen says where the form lives, shared by both share controls. A public
   * form is shared by its GUEST address, the one that opens without an account; a member opening
   * that link is sent back here.
   */
  const formPath = $derived(form ? formSharePath(form) : `/forms/${formId}`);
  let qrOpen = $state(false);

  function copyFormLink() {
    void copyPublicShareLink(formPath);
  }

  /**
   * The unpublished revision of `f`, for a preview (owner, 2026-11-08), or `null`. Only a manager
   * reads a revision: anyone else is refused it, and the page stays the live form.
   */
  async function unpublishedRevision(f: Form): Promise<Partial<Form> | null> {
    try {
      const revision = await getFormDraft(f.id);
      return (revision.document as Partial<Form> | null) ?? null;
    } catch (e) {
      Log.d(
        'FormView',
        `preview of ${f.id}: no revision readable (${refusalStatus(e) ?? 'no answer'})`
      );
      return null;
    }
  }

  onMount(() => {
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
  });

  /** The form id the page last started loading: a load for any other id is stale. */
  let loadedFormId: string | undefined;

  /**
   * ONE FORM PER LOAD. The route reuses this component from one form to the next (`/forms/A` to
   * `/forms/B`), so everything a load or a checkout wrote about A is cleared before B is read.
   */
  function resetFormState(): void {
    form = null;
    selections = {};
    submitted = false;
    paymentPending = false;
    paymentRetry = null;
    pendingCheckout = null;
    paidOverCapacity = false;
    formFull = false;
    pricing = null;
    productGridPrices = {};
    missingAnswer = null;
    hiddenItemIds = [];
    maySubmit = true;
    cotisationHeld = false;
    error = '';
    successMessage = '';
    successDetail = '';
    askingPayerEmail = false;
    linkedAgendaEvent = null;
    agendaAssociationSlug = '';
    revisionShown = false;
    paymentMethodChoice = 'online';
    reachedEnd = false;
    qrOpen = false;
    loading = true;
  }

  $effect(() => {
    const id = formId;
    untrack(() => {
      if (id === loadedFormId) return;
      Log.d('FormView', `loading form ${id ?? '(none)'}`);
      loadedFormId = id;
      resetFormState();
      void loadForm(id);
    });
  });

  async function loadForm(id: string | undefined): Promise<void> {
    const stale = () => loadedFormId !== id;
    try {
      if (!id) {
        error = m.form_view_not_found();
        loading = false;
        return;
      }
      const f = await getForm(id);
      if (stale()) return;
      form = f;
      selections = initialSelections(f.items);
      // A draft, or a link asking for the revision ("Voir le formulaire"): what the managers are
      // building is drawn when THIS reader may read it. The flag alone never shuts a published
      // form's send - a respondent handed such a link answers as usual.
      if (isDraftForm(f) || page.url.searchParams.get(FORM_PREVIEW_PARAM) === '1') {
        const revision = await unpublishedRevision(f);
        if (stale()) return;
        revisionShown = revision !== null;
        if (isPreview(f, revisionShown)) {
          // Nothing of the reader's own state is asked: a preview sends nothing, and a draft's
          // check answers as for an absent form (`respondentFormWhere`).
          const shown: Form = revision ? { ...f, ...revision } : f;
          form = shown;
          selections = initialSelections(shown.items);
          Log.d('FormView', `preview of ${f.id} (${f.status ?? 'published'})`);
          return;
        }
      }

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
        // A decoration, so a failure draws no banner - but it is SAID, with its status: a refusal
        // (the reader is outside the event's audience is `null`, not this) or a transport failure.
        getCalendarEventLinkedToForm(f.id).catch((err: unknown) => {
          console.warn(
            `[FormView] linked event read failed status=${refusalStatus(err) ?? 'transport'}`,
            err
          );
          return { linkedEvent: null };
        }),
        checkSubmission(f.id),
      ]);
      if (stale()) return;
      linkedAgendaEvent = linked.linkedEvent;
      if (linked.linkedEvent) {
        void getAssociation(linked.linkedEvent.associationId)
          .then((asso) => {
            agendaAssociationSlug = asso.slug;
          })
          .catch((err: unknown) => {
            console.warn(
              `[FormView] linked event's association read failed status=${refusalStatus(err) ?? 'transport'}`,
              err
            );
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
        refusalCode,
      } = submission;
      submitted = hasSubmitted;
      formFull = full;
      pricing = view;
      hiddenItemIds = hidden ?? [];
      maySubmit = allowed ?? true;
      cotisationHeld = refusalCode === FORM_COTISATION_HELD;
      productGridPrices = submission.productGridPrices ?? {};
      paymentPending = hasSubmitted && paymentStatus === 'pending';
      if (paymentPending && submission.submissionId) {
        watchCheckout(submission.submissionId, null);
        void readPending('load');
      }

      if (!hasSubmitted && formOpensAtIso(f.opensAt)) {
        void reminder.load();
      }
      if (offersAnswerEdit(f, !!userId, serverFormAnswerEdit())) void loadEditableAnswers(f.id);
      if (hasSubmitted) {
        try {
          const sub = await getSubmission(f.id);
          if (stale()) return;
          if (sub?.answers) selections = selectionsFromAnswers(f.items, sub.answers);
        } catch {
          // ignore
        }
      }
    } catch (e: any) {
      if (stale()) return;
      error =
        e instanceof FormNotFoundError
          ? m.form_view_not_found()
          : (describeApiRefusal(refusalStatus(e), m.form_view_load_action()) ??
            m.form_view_load_error());
    } finally {
      if (!stale()) loading = false;
    }
  }

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
    form && (maySubmit || editing)
      ? visibleItemsOf(form.items, selections, new Set(hiddenItemIds))
      : []
  );

  /**
   * Everything the page shows about the price, from the slice the server sent (`fillPriceState`,
   * shared with the guest's page): the cell their answers land on, whether it is decided or does
   * not exist, the options that would close it, and the total the pay button names.
   */
  const price = $derived(
    fillPriceState({
      basePrice: form?.basePrice ?? 0,
      pricing,
      items: form?.items ?? [],
      visibleItems,
      selections,
      productGridPrices,
    })
  );
  /** Whether the form holds a priced grid this member sees: the bar then totals the order. */
  const hasProductGrid = $derived(visibleItems.some(isProductGrid));
  /** The categories this member is charged under, for the read-only line under the header. */
  const tierLabels = $derived(appliedTierLabels(visibleItems, productGridPrices));
  const priceUnavailable = $derived(price.priceUnavailable);
  const appliedPricingLabel = $derived(price.appliedLabel);

  /** The supplement shown beside an option, in cents - zero where the grid prices the question. */
  function optionModifier(item: { id: string }, opt: { priceModifier: number }): number {
    return optionModifierOf(price, item, opt);
  }

  /** Whether choosing this option would land on a combination the manager marked as not existing. */
  function optionClosed(opt: { id?: string }): boolean {
    return !!opt.id && price.unavailableOptionIds.has(opt.id);
  }

  function calculateTotal(): number {
    return form ? price.total : 0;
  }

  /** What a question's card says after a refused send: why, while it is still unanswered. */
  function questionError(item: { id: string }): string | null {
    if (!missingAnswer || missingAnswer.itemId !== item.id) return null;
    const answered = visibleItems.find((i) => i.id === item.id);
    return answered && isItemAnswered(answered, selections[item.id])
      ? null
      : missingAnswerMessage(missingAnswer);
  }

  /** The FILE questions whose file is still travelling: the answer is not sent while any is. */
  const uploadingFiles = new SvelteSet<string>();

  /** Starts watching a pending answer: a new checkout, so a new reader (its generation). */
  function watchCheckout(submissionId: string, checkoutUrl: string | null): void {
    Log.d(
      'FormView',
      `watching the pending answer (${checkoutUrl ? 'handed to Lydia here' : 'found on load'})`
    );
    pendingCheckout = {
      submissionId,
      checkoutUrl,
      reader: createPaymentReader(() => confirmSubmissionPayment(submissionId)),
    };
  }

  /**
   * ONE read of the pending answer, through its checkout's reader: on load, on each return of the
   * app to the screen, and on "Vérifier le paiement". A pending answer is asked about on load because
   * a payer who declined on Lydia's page gets no callback and no link back, so this read is what
   * releases the answer. One read at a time across the three (`readOnce` answers null while one is
   * in flight), and an outcome whose checkout is no longer the page's is dropped.
   */
  async function readPending(why: 'load' | 'return' | 'tap'): Promise<void> {
    const checkout = pendingCheckout;
    if (!checkout || !paymentPending) return;
    Log.d('FormView', `pending answer read (${why})`);
    let outcome: PaymentReturnOutcome | null;
    try {
      outcome = await checkout.reader.readOnce();
    } catch (err) {
      // Unknown is not a verdict: the page keeps "pending", and the next return asks again.
      console.warn(
        `[FormView] could not read the pending answer (${why}) status=${refusalStatus(err) ?? 'transport'}`,
        err
      );
      return;
    }
    if (outcome === null) return;
    if (pendingCheckout !== checkout) {
      Log.d('FormView', `pending answer read (${why}) answered a checkout that ended, dropped`);
      return;
    }
    await applyPaymentOutcome(outcome);
  }

  /**
   * What one read of the pending answer changes on the page. Worded as the return page words it
   * (`/forms/success`): paid is said as a confirmed payment, a dead request releases the answer and
   * the pay button is the retry, and anything that can still change keeps "pending" with the way
   * back to Lydia's page.
   */
  async function applyPaymentOutcome(outcome: PaymentReturnOutcome): Promise<void> {
    Log.d('FormView', `pending answer outcome: ${outcome}`);
    if (outcome === 'pending') return;
    const formShown = form?.id;
    paymentPending = false;
    pendingCheckout = null;
    if (outcome === 'confirmed') {
      submitted = true;
      successMessage = m.form_success_confirmed_heading();
      successDetail = m.form_success_confirmed_desc();
    } else if (outcome === 'overCapacity') {
      submitted = true;
      paidOverCapacity = true;
    } else {
      if (outcome === 'declined' || outcome === 'ended') {
        paymentRetry = outcome;
        submitted = false;
      } else {
        // A final state that is neither paid nor a dead request (cancelled elsewhere): the
        // in-progress block goes, and the server's own answer says whether this person answered.
        Log.d('FormView', 'the pending answer read a final unpaid state, the answer is re-read');
      }
      if (!formShown) return;
      // The released answer gave its seat back: "full" was counted with it.
      const check = await checkSubmission(formShown);
      if (form?.id !== formShown) return;
      formFull = check.formFull;
      if (outcome === 'error') submitted = check.hasSubmitted;
    }
  }

  /** Reads which of the caller's answers they may still change; a failure offers no change. */
  async function loadEditableAnswers(id: string) {
    try {
      editableAnswers = await getMyEditableAnswers(id);
      Log.d('FormView', `editable answers: ${editableAnswers.length}`);
    } catch (err) {
      console.warn(
        `[FormView] editable answers read failed status=${refusalStatus(err) ?? 'transport'}`,
        err
      );
      editableAnswers = [];
    }
  }

  /** Opens one of the caller's answers for change: its values drawn, its locked questions shut. */
  function startEdit(answer: EditableAnswer) {
    if (!form) return;
    Log.d('FormView', `edit opened: ${answer.lockedItemIds.length} locked question(s)`);
    editing = answer;
    selections = selectionsFromAnswers(form.items, answer.answers as Record<string, any>);
    error = '';
    successMessage = '';
    missingAnswer = null;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /**
   * Leaves the change: a single-answer form keeps drawing the answer (as saved, or as it was), a
   * form taking several goes back to a blank answer.
   */
  function stopEdit(saved: Record<string, unknown> | null) {
    if (!form || !editing) return;
    Log.d('FormView', saved ? 'edit closed after a save' : 'edit cancelled');
    const shown = saved ?? editing.answers;
    editing = null;
    missingAnswer = null;
    error = '';
    selections = submitted
      ? selectionsFromAnswers(form.items, shown as Record<string, any>)
      : initialSelections(form.items);
  }

  /** Sends the changed answer; nothing about the price or the payment moves (server-enforced). */
  async function saveEdit() {
    if (!form || !editing) return;
    const answer = editing;
    error = '';
    submitting = true;
    try {
      const sent = editedAnswers(visibleItems, selections, answer.lockedItemIds);
      await editFormAnswer(form.id, answer.id, sent);
      Log.d('FormView', 'answer changed');
      showToast(m.form_view_edit_saved(), 'info');
      stopEdit({ ...selections });
      void loadEditableAnswers(form.id);
    } catch (e: unknown) {
      Log.d('FormView', `answer change refused status=${refusalStatus(e) ?? 'transport'}`);
      error = formSubmitRefusalMessage(e, m.form_guest_submit_failed());
    } finally {
      submitting = false;
    }
  }

  /** Lydia's payer page again, for a payer who came back before confirming. */
  async function reopenCheckout(): Promise<void> {
    const url = pendingCheckout?.checkoutUrl;
    Log.d('FormView', `reopen checkout: ${url ? 'yes' : 'no address kept'}`);
    if (!url) return;
    const { navigateExternal } = await import('$lib/utils/openExternal');
    await navigateExternal(url).catch((err: unknown) =>
      console.error('[FormView] reopening the payer page failed:', err)
    );
  }

  // While an answer is pending, each return of the app to the screen reads it once - the payer
  // confirms on Lydia's page or in the Lydia app and comes back BY HAND, so no return URL is relied on.
  $effect(() => {
    if (!paymentPending || !pendingCheckout) return;
    return watchReturnsToApp(() => {
      readPending('return').catch((err: unknown) =>
        console.warn('[FormView] applying the payment read failed:', err)
      );
    });
  });

  async function handleSubmit(payerEmail?: string) {
    if (!form || submitting) return;
    if (preview) {
      Log.d('FormView', 'submit held: a preview sends nothing');
      return;
    }
    if (uploadingFiles.size > 0) {
      // Refused, not queued: an optional file question would otherwise go out empty while the
      // member believes the file is attached.
      Log.d('FormView', `submit refused: ${uploadingFiles.size} file(s) still uploading`);
      error = m.form_file_wait_upload();
      return;
    }
    if (isNotOpenYet && form.opensAt) {
      error = m.form_view_error_not_open({ date: formatFormOpensAt(form.opensAt) });
      return;
    }
    if (!userId.trim()) {
      error = m.form_view_error_login_required();
      return;
    }

    const missing = firstMissingAnswer(visibleItems, selections, gridSwitch);
    missingAnswer = missing;
    if (missing?.itemId === null) {
      // An empty ORDER is the form's, no card's: said once, announced, and brought into view.
      Log.d('FormView', 'submit held: the order across the grids is empty');
      error = '';
      await revealOrderMissing();
      return;
    }
    if (missing) {
      // Said on the question's own card, which is brought into view: the bar is far from it.
      error = '';
      Log.d('FormView', `submit held: required question ${missing.itemId} (${missing.kind})`);
      document
        .getElementById(`q-${missing.itemId}`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (editing) {
      // A change neither prices nor pays: the payment steps below are not reached.
      await saveEdit();
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
      const { formCheckoutCallbacks } = await import('$lib/utils/checkoutCallbacks');
      const res = await submitFormService(form.id, {
        email: '',
        ...(payerEmail ? { payerEmail } : {}),
        answers: visibleAnswers(visibleItems, selections),
        ...formCheckoutCallbacks(),
        ...(total > 0 && form.allowCashPayment ? { paymentMethod: paymentMethodChoice } : {}),
      });
      if (res.checkoutUrl) {
        // On a native app the page stays behind the browser: it says the payment is in progress,
        // keeps Lydia's page to reopen, and reads the answer when the payer comes back. On the web
        // the window has already left for Lydia, and the return page takes over. The watch starts
        // BEFORE the hand-off: the browser may open and the call still reject, or resolve after the
        // app already returned to the screen - neither may lose it.
        if (res.submissionId) {
          Log.d('FormView', 'payer handed to Lydia, the answer waits for the return');
          paymentRetry = null;
          submitted = true;
          paymentPending = true;
          watchCheckout(res.submissionId, res.checkoutUrl);
        } else {
          console.warn('[FormView] a checkout came back without its submission id');
        }
        const { navigateExternal } = await import('$lib/utils/openExternal');
        await navigateExternal(res.checkoutUrl);
      } else {
        submitted = true;
        // The previous request of this answer was found PAID while settling it: no new one.
        successMessage = res.alreadyPaid
          ? m.form_view_submission_already_paid()
          : m.form_view_submission_success();
        successDetail = m.form_view_redirecting();
        setTimeout(leaveForm, 1500);
      }
    } catch (e: unknown) {
      Log.d('FormView', `submit refused status=${refusalStatus(e) ?? 'transport'}`);
      // Worded from the refusal's CODE, never from the server's English (D6).
      error = formSubmitRefusalMessage(e, m.form_guest_submit_failed());
    } finally {
      submitting = false;
    }
  }

  // ── Progress bar ─────────────────────────────────────────────────
  /**
   * The answer would pay ONLINE while the server reports the form's payments paused: the submit is
   * held and the reason shown, rather than a checkout refused after the answer is written. A cash
   * answer, where the form accepts one, is not paused - it never reaches an account.
   */
  const onlinePaymentPaused = $derived(
    !editing &&
      !!form?.paymentsPaused &&
      calculateTotal() > 0 &&
      !(form.allowCashPayment && paymentMethodChoice === 'cash')
  );
  const totalCount = $derived(visibleItems.length);
  const answeredCount = $derived.by(() => {
    if (!form) return 0;
    return visibleItems.filter((item) => isItemAnswered(item, selections[item.id])).length;
  });
  /**
   * Whether this estate stores each priced grid's own switch: off ([LEGACY], an estate older than
   * it), a grid's flag means nothing and the ORDER is held empty-or-not across the grids.
   */
  const gridSwitch = $derived(gridRequiredSwitchOn());
  /** What `reachedEnd` waits on: `handleSubmit`'s own validation as a yes/no - every visible
   * REQUIRED question answered - a required grid one unit of its own, or, before the switch
   * ([LEGACY] `gridSwitch` off), one unit across the grids. */
  const allRequiredAnswered = $derived(allRequiredAnsweredOf(visibleItems, selections, gridSwitch));
  /**
   * The empty-order sentence, shown after a send refused for it and only while the order is still
   * empty: it goes the moment a unit is added. The form's, no card's (`MissingAnswer` itemId null).
   */
  const orderMissing = $derived(
    missingAnswer?.itemId === null && isOrderEmpty(visibleItems, selections)
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

<!-- The send button, one markup for the plain bar and the order bar of a form with priced grids. -->
{#snippet payButton()}
  <Button
    variant="primary"
    class="shrink-0"
    disabled={preview ||
      submitting ||
      isNotOpenYet ||
      (!editing &&
        (submitted || formFull || !maySubmit || priceUnavailable || onlinePaymentPaused))}
    loading={submitting}
    onclick={() => void handleSubmit()}
  >
    {#if preview}
      {m.form_preview_submit_disabled()}
    {:else if editing}
      <Check size={16} class="mr-1.5" />{m.form_view_edit_save()}
    {:else if paymentPending}
      <Check size={16} class="mr-1.5" />{m.form_view_pending()}
    {:else if submitted}
      <Check size={16} class="mr-1.5" />{m.form_view_sent()}
    {:else if !maySubmit}
      {cotisationHeld ? m.form_view_cotisation_held_title() : m.form_view_not_open_to_you_title()}
    {:else if priceUnavailable}
      {m.form_view_combination_closed_title()}
    {:else if formFull}
      {m.form_view_full()}
    {:else if calculateTotal() > 0}
      <CreditCard size={16} class="mr-1.5" />{m.form_view_pay_button({
        amount: formatCurrency(calculateTotal(), form?.currency),
      })}
    {:else}
      <Check size={16} class="mr-1.5" />{m.form_view_submit()}
    {/if}
  </Button>
{/snippet}

<!-- Who is answering and at which price category: a form whose grids price by category. -->
{#snippet viewerTier()}
  <FormViewerTier name={getSavedDisplayName()} {tierLabels} />
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
      onclick={leaveForm}
    >
      <ArrowLeft size={15} />
      {m.common_back()}
    </button>
    {#if form}
      <div class="flex items-center gap-1">
        <button
          type="button"
          onclick={copyFormLink}
          class="text-text-muted hover:text-text-main hover:bg-cn-border/30 inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors"
        >
          <Link size={13} />{m.form_view_share()}
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
        class="border-accent-icon h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else if error && !form}
    <div class="border-cn-border space-y-3 rounded-3xl border bg-(--cn-surface) p-10 text-center">
      <p class="text-red-err font-semibold">{error}</p>
      <button class="text-text-muted text-sm hover:underline" onclick={leaveForm}
        >{m.common_back()}</button
      >
    </div>
  {:else if form}
    {#if preview}
      <p
        class="border-amber-warn/30 bg-amber-warn/10 text-text-main mb-4 rounded-2xl border-2 px-4 py-3 text-sm font-medium"
        data-testid="form-preview-banner"
        role="status"
      >
        {m.form_preview_banner()}
      </p>
    {/if}
    <!-- ── Header ── -->
    <FormHeader {form} {submitted} children={tierLabels.length > 0 ? viewerTier : undefined} />

    <!-- ── Progress bar ── -->
    {#if (!submitted || editing) && totalCount > 0}
      <div class="mb-5 flex items-center gap-3">
        <div class="bg-cn-border/60 h-2 flex-1 overflow-hidden rounded-full">
          <div
            class="bg-accent h-full rounded-full transition-all duration-500"
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
        data-form-linked-event
        href={resolve(
          agendaAssociationSlug
            ? `associations/${encodeURIComponent(agendaAssociationSlug)}`
            : 'associations'
        )}
        class="border-accent/35 bg-accent/10 hover:bg-accent/15 mb-4 flex items-center gap-3 rounded-2xl border px-4 py-3 transition-colors"
      >
        <div class="bg-accent/25 text-cn-dark shrink-0 rounded-xl p-2">
          <CalendarDays size={18} />
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-text-muted text-xs font-bold">
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
        class="border-accent/40 bg-accent/20 mb-4 flex items-center justify-between gap-4 rounded-2xl border px-4 py-4"
      >
        <p class="text-accent-text text-sm font-semibold">
          {m.form_view_opens_at({ date: formatFormOpensAt(form.opensAt) })}
        </p>
        {#if reminder.loaded}
          <button
            type="button"
            onclick={reminder.toggle}
            disabled={reminder.toggling}
            class="flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold transition-colors {reminder.subscribed
              ? 'text-on-accent bg-accent hover:bg-accent-hover'
              : 'bg-amber-warn/20 text-amber-warn-text hover:bg-amber-warn/30'}"
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
        <p class="text-text-main text-sm font-bold">
          {cotisationHeld
            ? m.form_view_cotisation_held_title()
            : m.form_view_not_open_to_you_title()}
        </p>
        <p class="text-text-muted mt-1 text-xs">
          {cotisationHeld ? m.form_view_cotisation_held_desc() : m.form_view_not_open_to_you_desc()}
        </p>
      </div>
    {/if}

    <!-- The combination they answered their way into does not exist. Separate from the block above
         on purpose: that one is about who they ARE and is fixed for the whole visit, this one moves
         as they answer and is theirs to undo. -->
    {#if maySubmit && priceUnavailable && !submitted && !editing}
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

    <!-- ── Changing an answer: what is changed, and the way out ── -->
    {#if editing}
      <div
        class="border-accent/40 bg-accent/10 mb-4 flex items-start justify-between gap-3 rounded-2xl border px-4 py-3"
        role="status"
        data-testid="form-edit-banner"
      >
        <p class="text-text-main text-sm font-medium">
          {m.form_view_edit_banner({ date: formatFormOpensAt(editing.createdAt) })}
        </p>
        <Button variant="ghost" size="compact" class="shrink-0" onclick={() => stopEdit(null)}>
          {m.form_view_edit_cancel()}
        </Button>
      </div>
    {:else if form.allowMultipleSubmissions && editableAnswers.length > 0}
      <!-- A form taking several answers: each is changed separately. -->
      <div class="border-cn-border mb-4 rounded-2xl border bg-(--cn-surface) px-4 py-3">
        <p class="text-text-main mb-2 text-sm font-bold">{m.form_view_my_answers_title()}</p>
        <ul class="space-y-1">
          {#each editableAnswers as answer (answer.id)}
            <li class="flex items-center justify-between gap-3">
              <span class="text-text-muted text-sm">
                {m.form_view_my_answer_row({ date: formatFormOpensAt(answer.createdAt) })}
              </span>
              <Button variant="soft" size="compact" onclick={() => startEdit(answer)}>
                <Pencil size={14} class="mr-1" />{m.form_view_edit_answer_short()}
              </Button>
            </li>
          {/each}
        </ul>
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
          {#if successDetail}
            <p class="mt-0.5 text-xs text-green-600/70 dark:text-green-400/70">
              {successDetail}
            </p>
          {/if}
        </div>
      </div>
    {/if}

    <!-- ── Questions ── -->
    <div class="space-y-3 sm:space-y-4">
      {#each visibleItems as item, qi (item.id)}
        <!-- A priced grid draws its own card: the product photo spans it, the price sits by the title. -->
        {#if isProductGrid(item) && item.productGrid}
          <ProductGridQuestion
            {item}
            grid={item.productGrid}
            bind:value={selections[item.id]}
            disabled={(submitted && !editing) || isNotOpenYet || editLocked.has(item.id)}
            prices={productGridPrices[item.id]}
            currency={form.currency}
            error={questionError(item)}
          />
        {:else}
          <FormQuestion
            {item}
            index={qi}
            bind:value={selections[item.id]}
            disabled={(submitted && !editing) || isNotOpenYet || editLocked.has(item.id)}
            formId={form.id}
            currency={form.currency}
            fileRetentionDays={form.fileRetentionDays}
            {optionModifier}
            {optionClosed}
            error={questionError(item)}
            onUploadingChange={(busy) =>
              busy ? uploadingFiles.add(item.id) : uploadingFiles.delete(item.id)}
          />
        {/if}
        <!-- A question that set the price stays as answered: no top-up, no partial refund. -->
        {#if editLocked.has(item.id)}
          <p class="text-text-muted -mt-1 flex items-center gap-1.5 px-1 text-xs">
            <Lock size={12} />{m.form_view_edit_locked_note()}
          </p>
        {/if}
      {/each}
    </div>

    <!-- ── Online payment paused: the organiser has no account to receive it right now ── -->
    {#if onlinePaymentPaused && !submitted && !editing}
      <div
        class="border-amber-warn/30 bg-amber-warn/10 text-amber-warn-text mt-4 rounded-2xl border px-4 py-3 text-sm"
        role="status"
      >
        <p class="font-semibold">{m.form_view_payments_paused_title()}</p>
        <p>{m.form_view_payments_paused_note()}</p>
      </div>
    {/if}

    <!-- ── Payment method (cash vs online) ── -->
    {#if calculateTotal() > 0 && form.allowCashPayment && !submitted && !cashOnly && !editing}
      <PaymentMethodChoice bind:method={paymentMethodChoice} />
    {/if}

    <!-- ── The empty order: the form's, announced, gone once a unit is added ── -->
    {#if orderMissing}
      <div
        id={ORDER_MISSING_ID}
        role="alert"
        class="border-red-err/30 bg-red-err/10 text-red-err mt-4 rounded-2xl border px-4 py-3 text-sm font-medium dark:bg-red-950/20"
      >
        {m.form_view_error_order_empty()}
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
    class="keyboard-aware-bottom mx-auto {PAGE_WIDTHS.reading} px-4 pb-3 md:px-8 {reachedEnd ||
    hasProductGrid
      ? 'sticky bottom-0 z-50 md:pb-5'
      : ''}"
  >
    <!-- AN ORDER IS TOTALLED WHERE IT IS PAID, from the first item (owner's mockup, 2026-11-06): a
         form with a priced grid keeps the bar stuck from the start, with the order's recap. -->
    {#if hasProductGrid && !submitted && !priceUnavailable && !editing}
      <ProductGridOrderBar
        lines={price.gridLines}
        totalCents={calculateTotal()}
        currency={form.currency}
        items={form.items}
        action={payButton}
      />
    {:else}
      <div
        class="border-cn-border/60 bg-cn-surface flex items-center gap-3 rounded-2xl border px-4 py-3 shadow-lg"
      >
        <div class="min-w-0 flex-1">
          {#if editing}
            <span class="text-text-main text-sm font-semibold">{m.form_view_edit_answer()}</span>
          {:else if submitted}
            <span class="text-green-ok flex items-center gap-1.5 text-sm font-bold"
              ><Check size={16} /> {m.form_view_response_sent()}</span
            >
            <!-- One answer to this form: it is reopened from here (several: the list above). -->
            {#if !form.allowMultipleSubmissions && editableAnswers.length > 0}
              <Button
                variant="link"
                size="compact"
                data-testid="form-edit-open"
                onclick={() => startEdit(editableAnswers[0])}
              >
                <Pencil size={14} class="mr-1" />{m.form_view_edit_answer()}
              </Button>
            {/if}
          {:else if priceUnavailable}
            <span class="text-text-muted text-sm">{m.form_view_combination_closed_title()}</span>
          {:else if calculateTotal() > 0}
            <div>
              <p class="text-text-muted text-xs font-medium">
                {m.form_view_total_to_pay()}{appliedPricingLabel}
              </p>
              <p class="text-cn-dark text-lg font-bold">
                {formatCurrency(calculateTotal(), form.currency)}
              </p>
            </div>
          {:else}
            <span class="text-text-muted text-sm">{m.form_view_submit()}</span>
          {/if}
        </div>
        {@render payButton()}
      </div>
    {/if}

    {#if paymentPending && pendingCheckout?.checkoutUrl}
      <!-- This page handed the payer to Lydia: they come back by hand, and the page reads on return. -->
      <div class="mt-2 flex flex-col items-center gap-2" role="status" data-payment-in-progress>
        <p class="text-amber-warn-text text-center text-sm font-medium">
          {updatesOnReturn
            ? m.form_view_payment_in_progress_note()
            : m.form_view_payment_in_progress_note_desktop()}
        </p>
        <div class="flex flex-wrap justify-center gap-2">
          <Button variant="secondary" onclick={() => void reopenCheckout()}>
            {m.form_view_payment_reopen()}
          </Button>
          {#if !updatesOnReturn}
            <Button variant="secondary" onclick={() => void readPending('tap')}>
              {m.form_view_payment_check()}
            </Button>
          {/if}
        </div>
      </div>
    {:else if paymentPending}
      <p class="text-amber-warn-text mt-2 text-center text-sm font-medium">
        {m.form_view_payment_pending_note()}
      </p>
    {:else if paidOverCapacity}
      <p class="text-amber-warn-text mt-2 text-center text-sm font-medium" role="status">
        {m.form_success_over_capacity_heading()} - {m.form_success_over_capacity_desc()}
      </p>
    {:else if paymentRetry && !submitted}
      <p class="text-amber-warn-text mt-2 text-center text-sm font-medium" role="status">
        {paymentRetry === 'declined'
          ? m.form_view_payment_declined_note()
          : m.form_view_payment_ended_note()}
      </p>
    {:else if formFull && !submitted && !editing}
      <p class="text-text-muted mt-2 text-center text-sm font-medium">
        {m.form_view_form_full_note()}
      </p>
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
