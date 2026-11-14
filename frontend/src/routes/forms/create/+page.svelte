<script lang="ts">
  import { guideAnchor } from '$lib/guidance/guideAnchors.svelte';
  import { kindHasSection } from '$lib/associations/editSections';
  import { providerRefusalMessage } from '$lib/associations/paymentRefusal';
  import { formCodeMessage, formItemsProblem } from '$lib/forms/answerBounds';
  import { describeApiRefusal, refusalCode, refusalStatus } from '$lib/utils/apiRefusal';
  import { safeInternalPath } from '$lib/utils/internalPath';
  import { gotoAppPath } from '$lib/navigation/gotoAppPath';
  import { resolve } from '$app/paths';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import { onMount, tick, untrack } from 'svelte';
  import {
    activePaymentProvider,
    loadActivePaymentProvider,
  } from '$lib/associations/activePaymentProvider.svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    createForm,
    publishFormDraft,
    saveFormDraft,
    uploadFormItemImage,
    type AudienceCondition,
    type CreateFormPayload,
  } from '$lib/forms/api';
  import { draftRefusalMessage, FORM_CREATE_KEY_REUSED, publishBlocker } from '$lib/forms/publish';
  import { serverFormAnswerEdit, serverFormDrafts } from '$lib/stores/appVersionCheck.svelte';
  import { answerEditPayload } from '$lib/forms/answerEditGate';
  import { gridRequiredSwitchOn } from '$lib/forms/gridRequiredGate';
  import { deviceCopyOf, formDraftCopyStore, holdFormEditor } from '$lib/forms/draftCopies';
  import { currentUserId } from '$lib/stores/user';
  import { FormAutosave } from '$lib/forms/autosave.svelte';
  import { questionImageRefusalMessage } from '$lib/forms/questionImage';
  import { POST_NEW_FORM_ID_KEY, loadPostComposerDraft } from '$lib/posts/postComposerDraft';
  import {
    canAssociationReceiveFormPayments,
    getAssociation,
    listMyAssociations,
    type Association,
    type MembershipTier,
  } from '$lib/associations/api';
  import {
    formManagedAssociations,
    withRequestedAssociation,
  } from '$lib/associations/requestedAssociation';
  import FormSection from '$lib/components/forms/FormSection.svelte';
  import FormAdvancedSettings from '$lib/components/forms/FormAdvancedSettings.svelte';
  import FormPaymentSection from '$lib/components/forms/FormPaymentSection.svelte';
  import FormQuestionsSection from '$lib/components/forms/FormQuestionsSection.svelte';
  import FormSaveBar from '$lib/components/forms/FormSaveBar.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import FormAssociationPicker from '$lib/components/forms/FormAssociationPicker.svelte';
  import { CONTROL_HINT_CLASS, CONTROL_LABEL_CLASS } from '$lib/components/ui/controlClasses';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import {
    cotisationGrantBlocker,
    cotisationOptionsFor,
    cotisationPayload,
    emptyCotisationSettings,
    forgetTierSelection,
  } from '$lib/forms/cotisationSettings';
  import { matrixPayload, matrixProblem, type PriceMatrix } from '$lib/pricing/priceMatrix';
  import { gridProblemMessage } from '$lib/pricing/gridProblem';
  import { formSummary } from '$lib/forms/summary';
  import { fetchFormations, type FormationOption } from '$lib/pricing/criteriaOptions';
  import { firstEmptyCondition } from '$lib/forms/audience';
  import {
    firstEmptyConditionQuestion,
    firstItemsFaultQuestion,
    refusedProductGridFault,
  } from '$lib/forms/questionFault';
  import { gridRequiredPayload, toFormItemsPayload } from '$lib/forms/itemsPayload';
  import {
    firstProductGridProblem,
    multipleSubmissionsAfterGridAdded,
    multipleSubmissionsAfterGridGone,
    profileTierCriterion,
    type GridMultipleSubmissions,
  } from '$lib/forms/productGridEditor';
  import {
    FILE_RETENTION_DEFAULT_DAYS,
    fileQuestionProblem,
    hasFileQuestion,
  } from '$lib/forms/fileQuestion';
  import { formConfigConflicts, type GuestPricedGrid } from '$lib/forms/formOptionRules';
  import {
    conflictCodeMessage,
    editorOptionState,
    formConflictMessage,
  } from '$lib/forms/formOptionConflict';
  import { Log } from '$lib/utils/Log';
  import { CircleAlert, FileText } from '@lucide/svelte';
  import { askedGuestFields } from '$lib/forms/guestIdentity';
  import { m } from '$lib/paraglide/messages';

  // General
  let title = $state('');
  let description = $state('');
  let maxSubmissions = $state<number | undefined>(undefined);
  let opensAt = $state('');
  let allowMultipleSubmissions = $state(false);
  /** Whether a respondent may change their own answer while the form is open (migration 166). */
  let allowAnswerEdit = $state(false);
  /** Whether this estate serves it (`formAnswerEdit`): an older server drops the switch. */
  const answerEditAvailable = serverFormAnswerEdit() === true;
  let anonymous = $state(false);
  let isPublic = $state(false);
  /** What a public form asks a guest (`guestIdentity.ts`); none by default. */
  let guestFields = $state<string[]>([]);

  // Payment
  let basePrice = $state(0);
  let requiresPayment = $state(false);
  /** Pre-selected by a "create a form" link from that association's own tab, e.g. `EditFormsTab`. */
  let associationId = $state(page.url.searchParams.get('association') ?? '');
  let allowCashPayment = $state(false);
  /** Online payment accepted (owner, 2026-11-08); off with cash on is a cash-only form. */
  let allowOnlinePayment = $state(true);
  let cashPaymentExpiryDays = $state<number | undefined>(undefined);
  let fileRetentionDays = $state(FILE_RETENTION_DEFAULT_DAYS);
  let cotisation = $state(emptyCotisationSettings());
  let priceMatrix = $state<PriceMatrix | null>(null);
  /** Formation values in use, for the formation criterion. Loaded once. */
  let formations = $state<FormationOption[]>([]);
  /** Who may answer at all; null means anybody. */
  let submitCondition = $state<AudienceCondition | null>(null);

  const returnTo = $derived(safeInternalPath(page.url.searchParams.get('returnTo'), '/forms'));
  const fromPostComposer = $derived(
    returnTo === '/posts' && page.url.searchParams.get('attach') === 'form'
  );
  /**
   * The builder is the widest screen the app has - a pricing grid is a table - so it is allowed
   * past the `max-w-4xl` the other management pages use. The composer variant stays narrower
   * because it is opened as a step inside a post, but it was too narrow to read a grid in at all.
   */

  /**
   * The associations whose forms the user manages - not every association there is, nor every
   * membership.
   *
   * Creating a form for an association requires MANAGE_FORMS in it (owner, 2026-11-14), so listing
   * any other offered a choice the save would then refuse: pick, save, 403. The list is not filtered on Stripe
   * readiness either, because a FREE form may be linked to any association it belongs to; the
   * payment section says so when a chosen association cannot take money yet.
   */
  let associations = $state<Association[]>([]);
  const selectedAssociation = $derived(associations.find((a) => a.id === associationId));
  const associationCanBePaid = $derived(
    !!selectedAssociation &&
      canAssociationReceiveFormPayments(selectedAssociation, activePaymentProvider.current)
  );

  // The chosen association's tiers, and whether this user may grant one. Reloaded on every change.
  let tiers = $state<MembershipTier[]>([]);
  let mayGrantCotisation = $state(false);
  $effect(() => {
    const id = associationId;
    let current = true;
    tiers = [];
    mayGrantCotisation = false;
    forgetTierSelection(cotisation);
    cotisationOptionsFor(id).then((options) => {
      if (!current) return;
      tiers = options.tiers;
      mayGrantCotisation = options.mayGrant;
    });
    return () => {
      current = false;
    };
  });

  const grantBlocker = $derived(
    cotisationGrantBlocker(
      requiresPayment,
      associationId,
      tiers.length,
      mayGrantCotisation,
      isPublic
    )
  );

  onMount(async () => {
    void loadActivePaymentProvider();
    const draft = loadPostComposerDraft();
    if (draft?.scheduledAt && !opensAt) {
      opensAt = draft.scheduledAt;
    }
    try {
      associations = await withRequestedAssociation(
        formManagedAssociations(await listMyAssociations()),
        associationId,
        getAssociation
      );
    } catch {
      // Ignore - the user may belong to none, which simply means personal forms only.
    }
    try {
      formations = await fetchFormations();
    } catch {
      // The formation criterion offers nothing, and says so. Every other criterion still works.
    }
  });

  let items = $state<any[]>([
    {
      id: crypto.randomUUID(),
      label: '',
      required: true,
      type: 'short_text',
      options: [],
      rows: [],
    },
  ]);

  let isSubmitting = $state(false);
  let error = $state('');

  const titleMissing = $derived(!title.trim());
  /** Questions the grid prices on: their per-option supplements are hidden, not ignored silently. */
  const gridQuestionIds = $derived(
    (priceMatrix?.dimensions ?? [])
      .filter((d) => d.kind === 'answer' && d.questionId)
      .map((d) => d.questionId as string)
  );

  const summary = $derived(
    formSummary({
      questionCount: items.length,
      requiresPayment,
      basePrice,
      priceMatrix,
    })
  );

  const formHasFile = $derived(hasFileQuestion(items));
  /** The options as the shared rule reads them: what every switch and the save are judged by. */
  const optionState = $derived(
    editorOptionState({
      anonymous,
      isPublic,
      requiresPayment,
      grantsCotisation: cotisation.grantsCotisation,
      submitCondition,
      items,
      allowAnswerEdit,
    })
  );

  /** A save refused on a question opens that question: a folded card hides its own error. */
  let reveal = $state<{ id: string } | null>(null);
  /** The priced grid a refused save is about, and its sentence, drawn under that grid. */
  let gridFault = $state<{ itemId: string; message: string } | null>(null);
  /**
   * Whether a priced grid - not the manager - switched "several answers" on: only then does removing
   * the last grid switch it back off. Any choice made on the switch itself clears it.
   */
  let multipleTurnedOnByGrid = $state(false);
  const multipleSubmissions = (): GridMultipleSubmissions => ({
    allow: allowMultipleSubmissions,
    turnedOnByGrid: multipleTurnedOnByGrid,
  });
  function applyMultipleSubmissions(next: GridMultipleSubmissions) {
    allowMultipleSubmissions = next.allow;
    multipleTurnedOnByGrid = next.turnedOnByGrid;
  }
  /** A priced grid may copy the registration price grid's categories in one click. */
  const formTiers = $derived(profileTierCriterion(priceMatrix, requiresPayment));
  function revealQuestion(id: string | null) {
    if (id) reveal = { id };
  }
  /** The banner sits at the top: a refusal about settings must be seen from the save bar. */
  let errorBanner = $state<HTMLElement | null>(null);
  async function scrollToError() {
    await tick();
    errorBanner?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /** Why "Publier" is shut: a paid form whose association cannot collect yet (it saves as a draft). */
  const blockedReason = $derived(
    publishBlocker({ form: buildPayload(), associationId, associationCanBePaid })
  );
  let isPublishing = $state(false);

  /**
   * Whether this estate builds forms as drafts (`formDrafts` in `/api/version`). An older server
   * strips `draft` and publishes at once, and has no publish route: the builder then saves as it
   * always did, one "Enregistrer" that publishes (docs/wiki/legacy-compatibility.md).
   */
  const formDrafts = serverFormDrafts() === true;
  /** Whether this estate stores each priced grid's own switch ([LEGACY] gate, `gridRequiredGate.ts`). */
  const gridSwitch = $derived(gridRequiredSwitchOn());

  /**
   * The draft this page is building, created at the first autosave once the form has a title
   * (owner, 2026-11-08): a shell holding its association and its title; everything else is its
   * unpublished revision, saved as it is typed. The association stays the builder's choice after
   * that first autosave (owner, 2026-11-09): it rides in the revision, and the publication moves the
   * draft to it.
   */
  /**
   * The create's idempotency key, minted HERE (the client post id pattern): a create whose answer
   * was lost is sent again as the same create, and the server answers the form it stored - never a
   * second draft. Never the form's id: the server mints that.
   */
  const createKey = crypto.randomUUID();
  /** Set once the server holds the draft (its shell answered). */
  let createdId = $state<string | null>(null);
  /**
   * The association the create NAMED (`''`: none), set at the FIRST create sent and kept while that
   * create MAY have landed: no answer, a 5xx, or the server's own word that a form already sits under
   * this key (`FORM_CREATE_KEY_REUSED`). Such a create may have stored the form under it, and its
   * replay must name the SAME one - the create is idempotent on its key, and a replay naming another
   * association is refused. Any other 4xx is a verdict that nothing was stored: the next create
   * names the choice of that moment. The PICKER never waits on it: a later choice is the revision's,
   * and the publication moves the draft (`null` here: no create sent).
   */
  let createAssociation = $state<string | null>(null);

  async function draftId(): Promise<string> {
    if (createdId) return createdId;
    createAssociation ??= associationId;
    let created;
    try {
      created = await createForm({
        clientCreateId: createKey,
        draft: true,
        title,
        basePrice: 0,
        currency: 'eur',
        items: [],
        associationId: createAssociation || undefined,
      });
    } catch (e) {
      const status = refusalStatus(e);
      if (status !== null && status < 500 && refusalCode(e) !== FORM_CREATE_KEY_REUSED) {
        Log.d('forms-editor', `draft create refused status=${status}: nothing stored`);
        createAssociation = null;
      }
      throw e;
    }
    Log.d('forms-editor', `draft created ${created.id}`);
    createdId = created.id;
    // The device copy is the form's from now on: an editor of it finds it under its id.
    if (formDrafts && userId) {
      await formDraftCopyStore(userId)
        .rekey(createKey, created.id)
        .catch((e: unknown) =>
          console.warn(`[forms-editor] device copy not re-keyed to ${created.id}: ${e}`)
        );
    }
    return created.id;
  }

  const userId = currentUserId();
  const autosave = new FormAutosave({
    save: async (base, document, saveId, leaving) =>
      saveFormDraft(await draftId(), base, document, saveId, { leaving }),
    // Kept on the device until a save lands: a page closed first loses nothing, and the background
    // resend creates the draft and sends it (`draftResend.ts`).
    device:
      formDrafts && userId
        ? deviceCopyOf(userId, () => ({
            formId: createdId,
            clientCreateId: createKey,
            // What the create names when the resend sends it: the one already sent, else the choice.
            createAssociationId: createAssociation ?? associationId,
          }))
        : null,
  });

  // Every edit is saved, debounced, once the form has a title to be listed under.
  let lastSaved: string | null = null;
  $effect(() => {
    const document = buildPayload();
    const json = JSON.stringify(document);
    const named = !titleMissing;
    untrack(() => {
      if (!formDrafts || !named || json === lastSaved) return;
      lastSaved = json;
      autosave.schedule(document);
    });
  });

  // Hidden, left or torn down: saved at once; back online: an edit that reached no server is sent
  // again. The cleanup saves too - an in-app navigation fires no `pagehide`.
  $effect(() => (formDrafts ? autosave.attach(window) : undefined));
  beforeNavigate(() => {
    if (formDrafts) void autosave.flush();
  });
  // While this page is open, the background resend leaves its device copy to it.
  $effect(() => (formDrafts ? holdFormEditor(createKey) : undefined));
  $effect(() => (formDrafts && createdId ? holdFormEditor(createdId) : undefined));

  /** The new form's payload: what the autosave stores and the publication applies. */
  function buildPayload(): CreateFormPayload {
    return {
      // Each priced grid's "Obligatoire" switch is the manager's, on an estate that stores it.
      ...gridRequiredPayload(gridSwitch),
      title,
      description,
      basePrice: requiresPayment ? Math.round(basePrice * 100) : 0,
      priceMatrix: matrixPayload(priceMatrix, requiresPayment),
      submitCondition,
      ...cotisationPayload(cotisation, requiresPayment),
      currency: 'eur',
      items: toFormItemsPayload(items, gridSwitch),
      maxSubmissions,
      allowMultipleSubmissions,
      ...answerEditPayload(answerEditAvailable, allowAnswerEdit),
      anonymous,
      isPublic,
      // Asked of a guest only on a public form that keeps names; otherwise nothing is asked.
      guestFields: isPublic && !anonymous ? askedGuestFields(guestFields) : [],
      ...(opensAt ? { opensAt: new Date(opensAt).toISOString() } : {}),
      requiresPayment,
      // NEVER conditioned on `requiresPayment` - a free form belongs to the association it was
      // created for exactly as a paid one does (the comment on `associations` above already said
      // so; this line contradicted it, and a free form created from an association's own "create
      // a form" button would otherwise vanish from that association's list the moment it saved).
      // ALWAYS present, `''` for none: the revision is an edit, where an absent field means "leave
      // it", so a draft moved to "personal" must say so (owner, 2026-11-09).
      associationId,
      ...(requiresPayment ? { allowCashPayment, allowOnlinePayment } : {}),
      ...(requiresPayment && allowCashPayment && cashPaymentExpiryDays != null
        ? { cashPaymentExpiryDays }
        : {}),
      ...(formHasFile ? { fileRetentionDays } : {}),
    };
  }

  /** Why "Publier" is shut beyond payments: an edit the server does not hold yet. */
  const unsavedReason = $derived(
    autosave.status === 'offline' || autosave.status === 'error'
      ? m.form_publish_blocked_unsaved()
      : autosave.status === 'conflict'
        ? m.form_draft_conflict_refusal()
        : null
  );

  /**
   * "Publier" (owner, 2026-11-08): the page's own checks first, in the reader's language; then what
   * is typed is saved and the draft published with it, in one transaction on the server
   * (`publishFormDraft`). Refused, the draft stays saved and this page says why.
   */
  async function handlePublish() {
    if (titleMissing) {
      error = m.form_error_title_required();
      return;
    }
    if (requiresPayment && !associationId) {
      error = m.form_error_association_required();
      return;
    }
    const itemsProblem = formItemsProblem(items);
    if (itemsProblem) {
      error = itemsProblem;
      revealQuestion(firstItemsFaultQuestion(items));
      return;
    }
    // The server's refusal, said first and in the reader's language: the same rule, whichever
    // switch was turned on last (`formOptionRules.ts`).
    const [conflict] = formConfigConflicts(
      optionState,
      matrixPayload(priceMatrix, requiresPayment) as GuestPricedGrid | null
    );
    if (conflict) {
      Log.d('forms-editor', `save refused before sending: ${conflict}`);
      error = formConflictMessage(conflict);
      return;
    }
    // A priced grid is judged by the contract the server judges it by, on the payload it will send.
    gridFault = firstProductGridProblem(items, { isPublic, requiresPayment });
    if (gridFault) {
      error = gridFault.message;
      revealQuestion(gridFault.itemId);
      return;
    }
    const fileProblem = fileQuestionProblem({ items, fileRetentionDays, submitCondition });
    if (fileProblem) {
      // A form-level refusal (public, anonymous, retention): no question is at fault, the
      // settings are, so the banner is brought into view instead of opening a card.
      error = fileProblem;
      await scrollToError();
      return;
    }
    const empty = firstEmptyCondition(submitCondition, items);
    if (empty) {
      revealQuestion(firstEmptyConditionQuestion(items));
      error =
        empty.scope === 'form'
          ? m.form_error_audience_empty()
          : m.form_error_question_condition_empty({ label: empty.label });
      return;
    }
    const gridProblem = requiresPayment ? matrixProblem(priceMatrix) : null;
    if (gridProblem) {
      error = gridProblemMessage(gridProblem);
      return;
    }
    isSubmitting = true;
    error = '';
    try {
      let publishedId: string;
      if (!formDrafts) {
        // An estate older than drafts: one create that publishes, as this page always did.
        // A create names an association or nothing: `''` is an edit's word for none.
        const created = await createForm({
          ...buildPayload(),
          associationId: associationId || undefined,
        });
        Log.d('forms-editor', `created and published ${created.id} (an estate without drafts)`);
        publishedId = created.id;
      } else {
        // What is on the page now is what is published: saved first, whatever the debounce holds.
        lastSaved = JSON.stringify(buildPayload());
        autosave.schedule(buildPayload());
        await autosave.flush();
        if (!autosave.settled || !createdId) {
          error = unsavedReason ?? m.form_publish_blocked_unsaved();
          return;
        }
        isPublishing = true;
        const result = await publishFormDraft(createdId, autosave.revision);
        autosave.closed(result.revision, 'published');
        Log.d('forms-editor', `created and published ${createdId}`);
        publishedId = createdId;
      }
      if (fromPostComposer) {
        sessionStorage.setItem(POST_NEW_FORM_ID_KEY, publishedId);
        goto(resolve('/posts'));
      } else {
        gotoAppPath(returnTo).catch((err: unknown) =>
          console.error('[forms] the form is saved, but leaving the builder failed:', err)
        );
      }
    } catch (e: any) {
      // A grid the server alone could refuse (a cotisation tier it does not sell) is drawn under
      // that grid and its card opened, as the page's own check does.
      gridFault = refusedProductGridFault(e, items);
      if (gridFault) revealQuestion(gridFault.itemId);
      error =
        gridFault?.message ??
        questionImageRefusalMessage(e) ??
        formCodeMessage(refusalCode(e)) ??
        conflictCodeMessage(refusalCode(e)) ??
        draftRefusalMessage(refusalCode(e)) ??
        providerRefusalMessage(e) ??
        describeApiRefusal(refusalStatus(e), m.form_action_publish()) ??
        m.form_publish_failed();
    } finally {
      isSubmitting = false;
      isPublishing = false;
    }
  }
</script>

<PageContainer width={fromPostComposer ? 'reading' : 'tool'}>
  <PageHeader
    title={m.form_create_heading()}
    subtitle={m.form_create_subtitle()}
    backHref={fromPostComposer ? '/posts' : returnTo}
    backLabel={m.common_back()}
  />

  {#if error}
    <div
      bind:this={errorBanner}
      class="bg-red-err/10 border-red-err/30 text-red-err mb-6 flex items-center gap-2 rounded-2xl border-2 px-4 py-3 text-sm font-medium"
    >
      <CircleAlert size={18} class="shrink-0" />
      {error}
    </div>
  {/if}

  <!-- 1. What the form is -->
  <div use:guideAnchor={'forms.create.general'}>
    <FormSection title={m.form_section_general()} icon={FileText}>
      <Input
        label={m.form_title_label()}
        bind:value={title}
        placeholder={m.form_title_placeholder()}
        required
      />

      <div>
        <p class={CONTROL_LABEL_CLASS}>{m.form_description_label()}</p>
        <MarkdownComposerField
          bind:value={description}
          placeholder={m.form_description_placeholder()}
          minHeight="7rem"
        />
      </div>

      {#if associations.length > 0}
        <FormAssociationPicker
          {associations}
          value={associationId}
          pendingMove={createdId !== null && createAssociation !== associationId}
          onValueChange={(v) => (associationId = v)}
        />
      {/if}

      <p class={CONTROL_HINT_CLASS}>{m.form_image_add_after_create()}</p>
    </FormSection>
  </div>

  <!-- 2. Money -->
  <FormPaymentSection
    bind:requiresPayment
    {optionState}
    {isPublic}
    bind:basePrice
    bind:allowCashPayment
    bind:allowOnlinePayment
    bind:cashPaymentExpiryDays
    bind:priceMatrix
    {tiers}
    {formations}
    bind:items
    associationName={selectedAssociation?.name ?? ''}
    {associationCanBePaid}
    associationSells={!selectedAssociation || kindHasSection(selectedAssociation.type, 'payments')}
  />

  <!-- 3. Questions -->
  <div use:guideAnchor={'forms.create.questions'}>
    <FormQuestionsSection
      bind:items
      {requiresPayment}
      {gridQuestionIds}
      {tiers}
      {formations}
      {formTiers}
      {isPublic}
      {gridFault}
      onPricedGridAdded={() =>
        applyMultipleSubmissions(multipleSubmissionsAfterGridAdded(multipleSubmissions()))}
      onPricedGridGone={() =>
        applyMultipleSubmissions(multipleSubmissionsAfterGridGone(multipleSubmissions(), items))}
      {reveal}
      imageUploadFn={async (file) => (await uploadFormItemImage(createdId, file)).imageUrl}
    />
  </div>

  <!-- 4. Rarely wanted, and folded away -->
  <div use:guideAnchor={'forms.create.settings'}>
    <FormAdvancedSettings
      bind:maxSubmissions
      bind:allowMultipleSubmissions={
        () => allowMultipleSubmissions,
        (on) => {
          allowMultipleSubmissions = on;
          multipleTurnedOnByGrid = false;
        }
      }
      bind:allowAnswerEdit
      {answerEditAvailable}
      bind:anonymous
      anonymousFixed={false}
      bind:isPublic
      bind:guestFields
      {optionState}
      bind:opensAt
      bind:submitCondition
      bind:settings={cotisation}
      {tiers}
      {formations}
      {grantBlocker}
      associationName={selectedAssociation?.name ?? ''}
      hasFileQuestion={formHasFile}
      bind:fileRetentionDays
    />
  </div>

  <FormSaveBar
    {titleMissing}
    {isSubmitting}
    {summary}
    autosaveStatus={formDrafts ? autosave.status : null}
    saveLabel={m.form_save_button()}
    onSave={formDrafts ? null : handlePublish}
    publish={formDrafts
      ? {
          onPublish: handlePublish,
          blockedReason: blockedReason ?? unsavedReason,
          busy: isPublishing,
        }
      : null}
  />
</PageContainer>
