<script lang="ts">
  import { kindHasSection } from '$lib/associations/editSections';
  import { providerRefusalMessage } from '$lib/associations/paymentRefusal';
  import { questionImageRefusalMessage } from '$lib/forms/questionImage';
  import { formCodeMessage, formItemsProblem } from '$lib/forms/answerBounds';
  import { describeApiRefusal, refusalCode, refusalStatus } from '$lib/utils/apiRefusal';
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
    FormNotFoundError,
    discardFormDraft,
    getForm,
    getFormDraft,
    getSubmissions,
    publishFormDraft,
    saveFormDraft,
    updateForm,
    uploadFormImage,
    uploadFormItemImage,
    deleteFormImage,
    type AudienceCondition,
    type CreateFormPayload,
    type Form,
  } from '$lib/forms/api';
  import {
    associationLogoSrc,
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
  import FormAssociationPicker from '$lib/components/forms/FormAssociationPicker.svelte';
  import FormSection from '$lib/components/forms/FormSection.svelte';
  import FormAdvancedSettings from '$lib/components/forms/FormAdvancedSettings.svelte';
  import FormPaymentSection from '$lib/components/forms/FormPaymentSection.svelte';
  import FormQuestionsSection from '$lib/components/forms/FormQuestionsSection.svelte';
  import FormSaveBar from '$lib/components/forms/FormSaveBar.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import { CONTROL_HINT_CLASS, CONTROL_LABEL_CLASS } from '$lib/components/ui/controlClasses';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import {
    cotisationGrantBlocker,
    cotisationOptionsFor,
    cotisationPayload,
    cotisationSettingsOf,
    emptyCotisationSettings,
    forgetTierSelection,
  } from '$lib/forms/cotisationSettings';
  import {
    matrixOf,
    matrixPayload,
    matrixProblem,
    type PriceMatrix,
  } from '$lib/pricing/priceMatrix';
  import { gridProblemMessage } from '$lib/pricing/gridProblem';
  import { formSummary } from '$lib/forms/summary';
  import { fetchFormations, type FormationOption } from '$lib/pricing/criteriaOptions';
  import { firstEmptyCondition } from '$lib/forms/audience';
  import {
    firstEmptyConditionQuestion,
    firstItemsFaultQuestion,
    refusedProductGridFault,
  } from '$lib/forms/questionFault';
  import {
    gridRequiredPayload,
    fromFormItems,
    revisionItems,
    toFormItemsPayload,
  } from '$lib/forms/itemsPayload';
  import {
    firstProductGridProblem,
    multipleSubmissionsAfterGridAdded,
    multipleSubmissionsAfterGridGone,
    type GridMultipleSubmissions,
    profileTierCriterion,
    orderedProductGridCells,
  } from '$lib/forms/productGridEditor';
  import { PRODUCT_GRID_TYPE } from '$lib/forms/productGridContract';
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
  import { CircleAlert, ExternalLink, FileText, ImagePlus, Users, X } from '@lucide/svelte';
  import { askedGuestFields } from '$lib/forms/guestIdentity';
  import {
    draftRefusalMessage,
    formViewHref,
    isDraftForm,
    publishBlocker,
  } from '$lib/forms/publish';
  import Button from '$lib/components/ui/Button.svelte';
  import { FormAutosave } from '$lib/forms/autosave.svelte';
  import {
    copyAgainst,
    deviceCopyOf,
    formDraftCopyStore,
    holdFormEditor,
  } from '$lib/forms/draftCopies';
  import { tellCopyDropped } from '$lib/forms/draftResend';
  import { FORM_CHANGED_SINCE_REVISION } from '$lib/forms/publish';
  import { serverFormAnswerEdit, serverFormDrafts } from '$lib/stores/appVersionCheck.svelte';
  import { answerEditPayload } from '$lib/forms/answerEditGate';
  import { gridRequiredSwitchOn } from '$lib/forms/gridRequiredGate';
  import { currentUserId } from '$lib/stores/user';
  import { m } from '$lib/paraglide/messages';

  const formId = $derived(page.params.id as string);

  /**
   * Whether this estate stores revisions (`formDrafts` in `/api/version`). An older server has no
   * revision routes: the editor then saves as it always did, one "Enregistrer" that writes the form
   * (docs/wiki/legacy-compatibility.md).
   */
  const formDrafts = serverFormDrafts() === true;
  /** Whether this estate stores each priced grid's own switch ([LEGACY] gate, `gridRequiredGate.ts`). */
  const gridSwitch = $derived(gridRequiredSwitchOn());

  let form = $state<Form | null>(null);
  let loadError = $state('');

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
  let allowCashPayment = $state(false);
  /** Online payment accepted (owner, 2026-11-08); off with cash on is a cash-only form. */
  let allowOnlinePayment = $state(true);
  let cashPaymentExpiryDays = $state<number | undefined>(undefined);
  let fileRetentionDays = $state(FILE_RETENTION_DEFAULT_DAYS);
  let cotisation = $state(emptyCotisationSettings());
  let priceMatrix = $state<PriceMatrix | null>(null);
  let formations = $state<FormationOption[]>([]);
  /** Who may answer at all; null means anybody. */
  let submitCondition = $state<AudienceCondition | null>(null);

  /**
   * The form's association: its builder's choice while it is a DRAFT, fixed once it is published.
   *
   * A draft has no answer, payment or reminder yet, and its autosave must not lock it (owner,
   * 2026-11-09): the choice rides in the revision and the publication moves the draft, the server
   * asking membership of both sides. A PUBLISHED form stays with its association (user decision,
   * 2026-08-23, kept for published forms): its answers, payments and reminders are that
   * association's, so this screen shows it read-only and says why; the server refuses a change
   * (`FORM_ASSOCIATION_FIXED`).
   */
  let association = $state<Association | null>(null);
  /** The chosen association's id, `''` for a personal form. */
  let associationId = $state('');
  /** What a draft may be moved to: the builder's memberships, plus its own association. */
  let associations = $state<Association[]>([]);
  const associationCanBePaid = $derived(
    !!association && canAssociationReceiveFormPayments(association, activePaymentProvider.current)
  );

  // Image
  let imageUrl = $state<string | null>(null);
  let uploadingImage = $state(false);
  let imageError = $state('');

  let items = $state<any[]>([]);
  /** Per priced grid, the cells some answer ordered: removing their row or column warns first. */
  let orderedCells = $state<Record<string, string[]>>({});

  /**
   * Reads which grid cells were ordered, when the form holds a priced grid that has answers. A
   * failed read is logged and leaves the editor without warnings - it never blocks editing.
   */
  async function loadOrderedCells(id: string, f: Form) {
    const gridIds = (f.items ?? []).filter((i) => i.type === PRODUCT_GRID_TYPE).map((i) => i.id);
    if (gridIds.length === 0 || !f.submissionCount) return;
    try {
      orderedCells = orderedProductGridCells(await getSubmissions(id), gridIds);
    } catch (e) {
      console.warn('[forms] the ordered grid cells could not be read; removals will not warn:', e);
    }
  }
  let isSubmitting = $state(false);
  let error = $state('');

  /**
   * The association's tiers and whether this user may grant one.
   *
   * Loaded alongside the form, and again only when the builder picks another association for a
   * draft (`chooseAssociation`) - never in an effect, which would re-run on the load itself and have
   * to forget the tier the saved form already carries and then put it back.
   */
  let tiers = $state<MembershipTier[]>([]);
  let mayGrantCotisation = $state(false);

  const grantBlocker = $derived(
    cotisationGrantBlocker(
      requiresPayment,
      association?.id ?? '',
      tiers.length,
      mayGrantCotisation,
      isPublic
    )
  );

  function pad2(n: number) {
    return n < 10 ? `0${n}` : `${n}`;
  }
  function isoToDatetimeLocal(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  onMount(async () => {
    void loadActivePaymentProvider();
    const id = formId;
    if (!id) {
      loadError = m.form_edit_load_error();
      return;
    }
    try {
      const [stored, revision] = await Promise.all([
        getForm(id),
        formDrafts ? getFormDraft(id) : Promise.resolve(null),
      ]);
      form = stored;
      // The editor opens on what was last TYPED: what this device kept and no server holds yet,
      // else the unpublished revision, else the form as published (owner, 2026-11-08).
      const copy = revision ? await unsentCopy(id, revision) : null;
      const typed = copy?.document ?? revision?.document;
      // A revision an older editor saved carries `required: true` on every grid, meaning nothing:
      // each grid opens with the flag the form stores ([LEGACY], `revisionItems`).
      const f: Form = typed
        ? ({
            ...stored,
            ...typed,
            items: revisionItems(typed, stored.items) ?? stored.items,
          } as Form)
        : stored;
      const userId = currentUserId();
      if (revision) {
        autosave = new FormAutosave({
          save: (base, document, saveId, leaving) =>
            saveFormDraft(id, base, document, saveId, { leaving }),
          revision: revision.revision,
          hasChanges: !!revision.document,
          device: userId
            ? deviceCopyOf(userId, () => ({ formId: id, clientCreateId: null }))
            : null,
        });
        if (copy) autosave.resume(copy.document, copy.saveId, copy.after);
      }

      // The form's own association, fetched by id rather than found in a list: the list of
      // associations the user belongs to would miss the one they have since left, and this form
      // stays that association's either way.
      // A DRAFT's association is its builder's latest choice, the revision's; a PUBLISHED form's
      // is the stored one, always - a revision naming another (one an older server let through)
      // must neither show that name nor judge payment readiness on it (review of #3198).
      const ownAssociation = isDraftForm(stored) ? f.associationId : stored.associationId;
      associationId = ownAssociation ?? '';
      if (ownAssociation) {
        const [asso, options] = await Promise.all([
          getAssociation(ownAssociation).catch(() => null),
          cotisationOptionsFor(ownAssociation),
        ]);
        association = asso;
        tiers = options.tiers;
        mayGrantCotisation = options.mayGrant;
      }
      if (isDraftForm(stored)) associations = await draftAssociationChoices();

      applyContent(f);
      void loadOrderedCells(id, stored);
      try {
        formations = await fetchFormations();
      } catch {
        // The formation criterion offers nothing, and says so. Every other criterion still works.
      }
    } catch (e: unknown) {
      console.warn(`[forms-editor] form ${id} not loaded: ${e}`);
      loadError =
        e instanceof FormNotFoundError
          ? m.form_view_not_found()
          : (describeApiRefusal(refusalStatus(e), m.form_edit_load_action()) ??
            m.form_edit_load_error());
    }
  });

  /**
   * The associations a draft may be moved to: those whose forms the builder manages (the server asks
   * MANAGE_FORMS of both sides, `formManagedAssociations`), with the draft's own one even when it is not among them - a global admin's, or
   * one the builder has left - so the picker always names where the draft is.
   */
  async function draftAssociationChoices(): Promise<Association[]> {
    let mine: Association[] = [];
    try {
      mine = formManagedAssociations(await listMyAssociations());
    } catch (e) {
      console.warn(
        `[forms-editor] memberships not loaded; the draft's own association alone is offered: ${e}`
      );
    }
    const own = association;
    return withRequestedAssociation(mine, associationId, (id) =>
      own?.id === id ? Promise.resolve(own) : getAssociation(id)
    );
  }

  /** Token of the latest association pick: an older pick's tiers answering late are dropped. */
  let associationPick = 0;

  /**
   * The builder picked `id` for this draft: the payment section and the cotisation settings follow
   * it at once, and the next autosave carries it. The tier chosen for the old association means
   * nothing to the new one, so it is forgotten.
   */
  async function chooseAssociation(id: string) {
    if (id === associationId) return;
    const pick = ++associationPick;
    Log.d('forms-editor', `draft ${formId} association picked: ${id || 'none'}`);
    associationId = id;
    association = associations.find((a) => a.id === id) ?? null;
    tiers = [];
    mayGrantCotisation = false;
    forgetTierSelection(cotisation);
    const options = await cotisationOptionsFor(id);
    if (pick !== associationPick) return;
    tiers = options.tiers;
    mayGrantCotisation = options.mayGrant;
  }

  /**
   * What this device kept of `formId` and the server does not hold - a page closed before its save
   * landed - when it is built on the revision the server holds, or on one a save it records as sent
   * before it wrote (`after`: re-based then, a predecessor whose answer was lost). One the server
   * holds already (its save id is the revision's) is cleared; one built on a revision another
   * writer moved past is dropped, and the member TOLD.
   */
  async function unsentCopy(
    formId: string,
    revision: { revision: number; saveId?: string | null; recentSaveIds?: string[] }
  ) {
    const userId = currentUserId();
    if (!userId) return null;
    try {
      const store = formDraftCopyStore(userId);
      const copy = await store.get(formId);
      if (!copy) return null;
      const against = copyAgainst(copy, revision);
      if (against.verdict === 'landed') {
        await store.deleteIfSent([formId], copy.saveId);
        Log.d('forms-editor', `device copy of ${formId} had landed: cleared`);
        return null;
      }
      if (against.verdict === 'stale') {
        console.warn(
          `[forms-editor] device copy of ${formId} built on revision ${copy.baseRevision} DROPPED: the server is at ${revision.revision}`
        );
        await store.delete([formId]);
        tellCopyDropped(copy);
        return null;
      }
      if (against.copy.baseRevision !== copy.baseRevision) {
        Log.d(
          'forms-editor',
          `device copy of ${formId} re-based on revision ${revision.revision}, written by its predecessor`
        );
      }
      Log.d('forms-editor', `device copy of ${formId} found: the editor opens on it`);
      return against.copy;
    } catch (e) {
      console.warn(`[forms-editor] device copy of ${formId} unreadable: ${e}`);
      return null;
    }
  }

  /** Fills the editor from `f`: the form as published, or with its unpublished revision over it. */
  function applyContent(f: Form) {
    title = f.title;
    description = f.description ?? '';
    requiresPayment = f.requiresPayment ?? false;
    basePrice = requiresPayment ? (f.basePrice ?? 0) / 100 : 0;
    cotisation = cotisationSettingsOf(f);
    priceMatrix = matrixOf(f.priceMatrix);
    submitCondition = f.submitCondition ?? null;
    maxSubmissions = f.maxSubmissions;
    opensAt = isoToDatetimeLocal(f.opensAt);
    allowCashPayment = f.allowCashPayment ?? false;
    allowOnlinePayment = f.allowOnlinePayment ?? true;
    allowMultipleSubmissions = f.allowMultipleSubmissions ?? false;
    allowAnswerEdit = f.allowAnswerEdit ?? false;
    anonymous = f.anonymous ?? false;
    isPublic = f.isPublic ?? false;
    guestFields = askedGuestFields(f.guestFields);
    cashPaymentExpiryDays = f.cashPaymentExpiryDays ?? undefined;
    fileRetentionDays = f.fileRetentionDays ?? FILE_RETENTION_DEFAULT_DAYS;
    imageUrl = f.imageUrl ?? null;
    items = fromFormItems(f.items ?? [], requiresPayment);
    // What was just loaded is the baseline: only an edit after it is saved. Taken once the
    // question cards have mounted - a card completes its question's defaults (a scale's bounds) on
    // mounting, which is the loaded form as drawn, not an edit.
    autosaveBaseline = null;
    void tick().then(() => {
      autosaveBaseline = JSON.stringify(buildPayload());
    });
  }

  /** The autosave of this form's unpublished revision; created once the form and its revision load. */
  let autosave = $state<FormAutosave | null>(null);
  /** The payload last handed to the autosave, as JSON: an effect re-run without an edit sends nothing. */
  let autosaveBaseline: string | null = null;

  const titleMissing = $derived(!title.trim());
  /** Questions the grid prices on: their per-option supplements are hidden, not silently ignored. */
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

  /** A draft is built and published from here; a published form's edits wait in its revision. */
  const isDraft = $derived(isDraftForm(form));
  /** Why "Publier" is shut: a paid form whose association cannot collect yet. */
  const blockedReason = $derived(
    publishBlocker({
      form: buildPayload(),
      associationId: association?.id,
      associationCanBePaid,
    })
  );
  let isPublishing = $state(false);
  /** The form was written outside its revision: the next "Publier" confirms the overwrite. */
  let overwriteOffered = $state(false);

  /**
   * "Publier" / "Publier les modifications" (owner, 2026-11-08): the page's own checks first, in the
   * reader's language, then the revision is published - the server judges it again with the edit's
   * rules. Edits are saved as they are typed; there is no other save.
   */
  async function handlePublish() {
    if (titleMissing) {
      error = m.form_error_title_required();
      return;
    }
    if (requiresPayment && !association) {
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
      if (formDrafts) {
        await publishRevision();
      } else {
        // An estate older than revisions: the form is written as the editor always wrote it.
        await updateForm(formId, buildPayload());
        Log.d('forms-editor', `saved ${formId} (an estate without revisions)`);
        goto(resolve('/forms'));
      }
    } catch (e: any) {
      // Written outside the revision since it started: publishing would undo that unseen. Said,
      // and "Publier" becomes "Publier quand meme" for the manager who has read it.
      if (refusalCode(e) === FORM_CHANGED_SINCE_REVISION) overwriteOffered = true;
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

  /**
   * Saves what is pending, then publishes the revision the server holds - applying it, and for a
   * draft form publishing the form with it, in one transaction (`publishFormDraft`). Nothing is
   * published while an edit has not reached the server: the status line says why.
   */
  async function publishRevision() {
    if (!autosave) return;
    await autosave.flush();
    if (!autosave.settled) {
      error =
        autosave.status === 'conflict'
          ? m.form_draft_conflict_refusal()
          : m.form_publish_blocked_unsaved();
      return;
    }
    isPublishing = true;
    const result = await publishFormDraft(formId, autosave.revision, overwriteOffered);
    overwriteOffered = false;
    autosave.closed(result.revision, 'published');
    Log.d('forms-editor', `published ${formId} at revision ${result.revision}`);
    goto(resolve('/forms'));
  }

  /** The editor's payload: what the autosave stores and the publication applies. */
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
      isPublic,
      // Asked of a guest only on a public form that keeps names; otherwise nothing is asked.
      guestFields: isPublic && !anonymous ? askedGuestFields(guestFields) : [],
      ...(opensAt ? { opensAt: new Date(opensAt).toISOString() } : {}),
      requiresPayment,
      ...(requiresPayment ? { allowCashPayment, allowOnlinePayment } : {}),
      ...(requiresPayment && allowCashPayment && cashPaymentExpiryDays != null
        ? { cashPaymentExpiryDays }
        : {}),
      ...(formHasFile ? { fileRetentionDays } : {}),
      // A draft has no answer yet: its anonymity and its association are still its builder's
      // choice (server-checked). A published form's association is absent - "leave it" - as the
      // server refuses another (`FORM_ASSOCIATION_FIXED`); `''` names none.
      ...(isDraft ? { anonymous, associationId } : {}),
    };
  }

  // Every edit is saved as the unpublished revision, debounced (`FormAutosave`).
  $effect(() => {
    const document = buildPayload();
    const json = JSON.stringify(document);
    untrack(() => {
      if (!autosave || autosaveBaseline === null || json === autosaveBaseline) return;
      autosaveBaseline = json;
      autosave.schedule(document);
    });
  });

  // Hidden, left or torn down: saved at once; back online: an edit that reached no server is sent
  // again. The cleanup saves too - an in-app navigation fires no `pagehide`.
  $effect(() => {
    if (!autosave) return;
    return autosave.attach(window);
  });
  // A navigation that keeps this page (another form's editor) tears nothing down: saved here.
  beforeNavigate(() => {
    void autosave?.flush();
  });
  // While this editor is open, the background resend leaves this form's device copy to it.
  $effect(() => (formDrafts ? holdFormEditor(formId) : undefined));

  /**
   * "Voir le formulaire" opens what the respondents would see: the pending edit is saved first, so
   * the preview draws it. The tab is opened at the press (a popup opened after an await is blocked)
   * and pointed at the form once the save returns.
   */
  async function openView(e: MouseEvent) {
    if (!form || !autosave || autosave.settled) return;
    e.preventDefault();
    const tab = window.open('', '_blank');
    await autosave.flush();
    const href = formViewHref(form, autosave.hasChanges);
    if (tab) {
      tab.opener = null;
      tab.location.href = href;
    } else {
      console.warn('[forms-editor] the preview tab was not opened (blocked)');
    }
  }

  let isDiscarding = $state(false);

  /** "Abandonner les modifications": the revision is emptied and the editor shows the form as published. */
  async function handleDiscard() {
    if (!autosave || !form) return;
    isDiscarding = true;
    error = '';
    try {
      await autosave.flush();
      const result = await discardFormDraft(formId, autosave.revision);
      autosave.closed(result.revision, 'discarded');
      applyContent(form);
      Log.d('forms-editor', `revision of ${formId} discarded`);
    } catch (e: any) {
      error =
        draftRefusalMessage(refusalCode(e)) ??
        describeApiRefusal(refusalStatus(e), m.form_action_discard()) ??
        m.form_discard_failed();
    } finally {
      isDiscarding = false;
    }
  }

  /** Why "Publier" is shut beyond payments: an edit the server does not hold yet. */
  const unsavedReason = $derived(
    autosave && ['offline', 'error'].includes(autosave.status)
      ? m.form_publish_blocked_unsaved()
      : autosave?.status === 'conflict'
        ? m.form_draft_conflict_refusal()
        : null
  );
  /** A published form with edits the respondents do not see yet. */
  const hasUnpublishedChanges = $derived(!isDraft && !!autosave?.hasChanges);

  async function handleImageUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    uploadingImage = true;
    imageError = '';
    try {
      const updated = await uploadFormImage(formId, file);
      imageUrl = updated.imageUrl ?? null;
    } catch (err: unknown) {
      console.warn(`[forms-editor] form image not uploaded: ${err}`);
      imageError = m.form_builder_image_upload_failed();
    } finally {
      uploadingImage = false;
      input.value = '';
    }
  }

  async function handleImageRemove() {
    uploadingImage = true;
    try {
      await deleteFormImage(formId);
      imageUrl = null;
    } catch (err: unknown) {
      console.warn(`[forms-editor] form image not removed: ${err}`);
      imageError = m.form_image_remove_failed();
    } finally {
      uploadingImage = false;
    }
  }
</script>

<!-- Same width as the create page: it is the same form, and it carries the same grid. -->
<PageContainer width="tool">
  <PageHeader
    title={m.form_edit_heading()}
    subtitle={form?.title}
    backHref="/forms"
    backLabel={m.common_back()}
  >
    {#snippet actions()}
      {#if form}
        <!-- The respondent view, in a new tab: a preview while anything is unpublished. -->
        <Button
          variant="secondary"
          href={formViewHref(form, !!autosave?.hasChanges)}
          target="_blank"
          rel="noopener"
          onclick={openView}
          data-testid="form-view-link"
        >
          <ExternalLink size={16} />
          {m.form_view_open_button()}
        </Button>
      {/if}
    {/snippet}
  </PageHeader>

  {#if loadError}
    <div
      class="bg-red-err/10 border-red-err/30 text-red-err mb-6 flex items-center gap-2 rounded-2xl border-2 px-4 py-3 text-sm font-medium"
    >
      <CircleAlert size={18} class="shrink-0" />
      {loadError}
    </div>
  {:else if !form}
    <div class="flex justify-center py-16">
      <div
        class="border-accent-icon h-10 w-10 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else}
    {#if isDraft}
      <p
        class="border-cn-border text-text-muted mb-4 flex items-center gap-2 rounded-2xl border-2 border-dashed px-4 py-3 text-sm"
        data-testid="form-draft-notice"
      >
        <span class="bg-cn-border/40 text-text-main rounded-full px-2 py-0.5 text-xs font-bold">
          {m.form_status_draft_badge()}
        </span>
        {m.form_draft_notice()}
      </p>
    {/if}
    {#if hasUnpublishedChanges}
      <p
        class="border-cn-border text-text-muted mb-4 flex items-center gap-2 rounded-2xl border-2 border-dashed px-4 py-3 text-sm"
        data-testid="form-unpublished-notice"
      >
        <span class="bg-cn-border/40 text-text-main rounded-full px-2 py-0.5 text-xs font-bold">
          {m.form_unpublished_changes_badge()}
        </span>
        {m.form_unpublished_changes_notice()}
      </p>
    {/if}
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

      {#if isDraft && associations.length > 0}
        <FormAssociationPicker
          {associations}
          value={associationId}
          pendingMove={associationId !== (form.associationId ?? '')}
          onValueChange={(v) => void chooseAssociation(v)}
        />
      {:else}
        <div>
          <p class={CONTROL_LABEL_CLASS}>{m.form_association_label()}</p>
          <!-- Shown, never editable once published: the link holds the answers, payments and
             reminders, and a disabled picker would suggest someone with more rights could change it.
             There is no such someone; the hint says why, and what to do instead. -->
          <p
            class="border-cn-border text-text-main flex items-center gap-2 rounded-2xl border-2 border-dashed px-4 py-3 text-base"
          >
            {#if association}
              <Users size={16} class="text-text-muted shrink-0" />
              {association.name}
            {:else}
              <span class="text-text-muted">{m.form_association_none()}</span>
            {/if}
          </p>
          {#if !isDraft}
            <p class={CONTROL_HINT_CLASS} data-testid="form-association-locked">
              {m.form_association_locked_hint()}
            </p>
          {/if}
        </div>
      {/if}

      <div>
        <p class={CONTROL_LABEL_CLASS}>{m.form_image_section()}</p>
        {#if imageError}
          <p class="text-red-err mb-2 text-sm">{imageError}</p>
        {/if}
        {#if imageUrl}
          <div class="border-cn-border relative overflow-hidden rounded-xl border">
            <img
              src={associationLogoSrc(imageUrl) ?? ''}
              alt={m.form_image_section()}
              class="max-h-56 w-full object-cover"
              loading="lazy"
            />
            <button
              type="button"
              onclick={handleImageRemove}
              disabled={uploadingImage}
              class="ui-icon-button absolute top-2 right-2 rounded-full bg-black/60 text-white hover:bg-black/80"
              title={m.form_image_remove_title()}
            >
              <X size={14} />
            </button>
          </div>
        {:else}
          <label
            class="border-cn-border bg-cn-bg text-text-muted hover:border-accent/50 flex cursor-pointer items-center gap-2 rounded-xl border-2 border-dashed px-4 py-4 text-sm transition-colors {uploadingImage
              ? 'pointer-events-none opacity-50'
              : ''}"
          >
            <ImagePlus size={18} class="text-text-muted/60 shrink-0" />
            {uploadingImage ? m.form_image_uploading() : m.form_image_add_label()}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              class="sr-only"
              onchange={handleImageUpload}
            />
          </label>
        {/if}
      </div>
    </FormSection>

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
      associationName={association?.name ?? ''}
      {associationCanBePaid}
      associationSells={!association || kindHasSection(association.type, 'payments')}
    />

    <!-- 3. Questions -->
    <FormQuestionsSection
      bind:items
      {reveal}
      {requiresPayment}
      {gridQuestionIds}
      {tiers}
      {formations}
      {formTiers}
      {isPublic}
      {gridFault}
      {orderedCells}
      onPricedGridAdded={() =>
        applyMultipleSubmissions(multipleSubmissionsAfterGridAdded(multipleSubmissions()))}
      onPricedGridGone={() =>
        applyMultipleSubmissions(multipleSubmissionsAfterGridGone(multipleSubmissions(), items))}
      imageUploadFn={async (file) => {
        const r = await uploadFormItemImage(formId, file);
        return r.imageUrl;
      }}
    />

    <!-- 4. Rarely wanted, and folded away -->
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
      anonymousFixed={!isDraft}
      bind:isPublic
      bind:guestFields
      {optionState}
      bind:opensAt
      bind:submitCondition
      bind:settings={cotisation}
      {tiers}
      {formations}
      {grantBlocker}
      associationName={association?.name ?? ''}
      hasFileQuestion={formHasFile}
      bind:fileRetentionDays
    />

    <FormSaveBar
      {titleMissing}
      {isSubmitting}
      {summary}
      autosaveStatus={autosave?.status ?? null}
      saveLabel={m.form_save_changes_button()}
      onSave={formDrafts ? null : handlePublish}
      publish={formDrafts && (isDraft || hasUnpublishedChanges)
        ? {
            onPublish: handlePublish,
            blockedReason: blockedReason ?? unsavedReason,
            busy: isPublishing,
            label: overwriteOffered
              ? m.form_publish_overwrite_button()
              : isDraft
                ? m.form_publish_button()
                : m.form_publish_changes_button(),
          }
        : null}
      discard={hasUnpublishedChanges ? { onDiscard: handleDiscard, busy: isDiscarding } : null}
    />
  {/if}
</PageContainer>
