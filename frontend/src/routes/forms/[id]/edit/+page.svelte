<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    getForm,
    updateForm,
    uploadFormImage,
    uploadFormItemImage,
    deleteFormImage,
    type AudienceCondition,
    type CreateFormPayload,
    type Form,
  } from '$lib/forms/api';
  import {
    canAssociationReceiveFormPayments,
    getAssociation,
    type Association,
    type MembershipTier,
  } from '$lib/associations/api';
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
  } from '$lib/forms/cotisationSettings';
  import { matrixOf, matrixPayload, matrixProblem, type PriceMatrix } from '$lib/forms/priceMatrix';
  import { gridProblemMessage } from '$lib/forms/gridProblem';
  import { formSummary } from '$lib/forms/summary';
  import { fetchFormations, type FormationOption } from '$lib/forms/criteriaOptions';
  import { firstEmptyCondition } from '$lib/forms/audience';
  import { fromFormItems, toFormItemsPayload } from '$lib/forms/itemsPayload';
  import { CircleAlert, ArrowLeft, FileText, ImagePlus, Users, X } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  const formId = $derived(page.params.id as string);

  let form = $state<Form | null>(null);
  let loadError = $state('');

  // General
  let title = $state('');
  let description = $state('');
  let maxSubmissions = $state<number | undefined>(undefined);
  let opensAt = $state('');
  let allowMultipleSubmissions = $state(false);

  // Payment
  let basePrice = $state(0);
  let requiresPayment = $state(false);
  let allowCashPayment = $state(false);
  let cashPaymentExpiryDays = $state<number | undefined>(undefined);
  let cotisation = $state(emptyCotisationSettings());
  let priceMatrix = $state<PriceMatrix | null>(null);
  let formations = $state<FormationOption[]>([]);
  /** Who may answer at all; null means anybody. */
  let submitCondition = $state<AudienceCondition | null>(null);

  /**
   * The linked association, READ ONLY.
   *
   * A form is personal or an association's, decided once at creation and never after (user
   * decision, 2026-08-23): which one it is decides who owns it, and MANAGE_FORMS is a right over
   * the association's forms - so a manager who could cut the link could walk off with the form.
   * The server refuses a change; this screen does not offer one.
   */
  let association = $state<Association | null>(null);
  const associationCanBePaid = $derived(
    !!association && canAssociationReceiveFormPayments(association)
  );

  // Image
  let imageUrl = $state<string | null>(null);
  let uploadingImage = $state(false);
  let imageError = $state('');

  let items = $state<any[]>([]);
  let isSubmitting = $state(false);
  let error = $state('');

  /**
   * The association's tiers and whether this user may grant one.
   *
   * Loaded once alongside the form rather than in an effect: the association cannot change here, so
   * there is nothing to react to - and an effect that re-ran would have to forget the tier the
   * saved form already carries and then put it back.
   */
  let tiers = $state<MembershipTier[]>([]);
  let mayGrantCotisation = $state(false);

  const grantBlocker = $derived(
    cotisationGrantBlocker(requiresPayment, association?.id ?? '', tiers.length, mayGrantCotisation)
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
    const id = formId;
    if (!id) {
      loadError = m.form_edit_load_error();
      return;
    }
    try {
      const f = await getForm(id);
      form = f;

      // The form's own association, fetched by id rather than found in a list: the list of
      // associations the user belongs to would miss the one they have since left, and this form
      // stays that association's either way.
      if (f.associationId) {
        const [asso, options] = await Promise.all([
          getAssociation(f.associationId).catch(() => null),
          cotisationOptionsFor(f.associationId),
        ]);
        association = asso;
        tiers = options.tiers;
        mayGrantCotisation = options.mayGrant;
      }

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
      allowMultipleSubmissions = f.allowMultipleSubmissions ?? false;
      cashPaymentExpiryDays = f.cashPaymentExpiryDays ?? undefined;
      imageUrl = f.imageUrl ?? null;
      items = fromFormItems(f.items ?? [], requiresPayment);
      try {
        formations = await fetchFormations();
      } catch {
        // The formation criterion offers nothing, and says so. Every other criterion still works.
      }
    } catch (e: any) {
      loadError = e.message || m.form_edit_load_error();
    }
  });

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

  async function handleSave() {
    if (titleMissing) {
      error = m.form_error_title_required();
      return;
    }
    if (requiresPayment && !association) {
      error = m.form_error_association_required();
      return;
    }
    const empty = firstEmptyCondition(submitCondition, items);
    if (empty) {
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
      const payload: CreateFormPayload = {
        title,
        description,
        basePrice: requiresPayment ? Math.round(basePrice * 100) : 0,
        priceMatrix: matrixPayload(priceMatrix, requiresPayment),
        submitCondition,
        ...cotisationPayload(cotisation, requiresPayment),
        currency: 'eur',
        items: toFormItemsPayload(items),
        maxSubmissions,
        allowMultipleSubmissions,
        ...(opensAt ? { opensAt: new Date(opensAt).toISOString() } : {}),
        requiresPayment,
        // `associationId` is deliberately absent: it is fixed at creation and the API refuses a
        // value that differs from the stored one. Absent means "leave it".
        ...(requiresPayment ? { allowCashPayment } : {}),
        ...(requiresPayment && allowCashPayment && cashPaymentExpiryDays != null
          ? { cashPaymentExpiryDays }
          : {}),
      };
      await updateForm(formId, payload);
      goto('/forms');
    } catch (e: any) {
      error = e.message;
    } finally {
      isSubmitting = false;
    }
  }

  async function handleImageUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    uploadingImage = true;
    imageError = '';
    try {
      const updated = await uploadFormImage(formId, file);
      imageUrl = updated.imageUrl ?? null;
    } catch (err: any) {
      imageError = err.message || 'Error';
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
    } catch (err: any) {
      imageError = err.message || 'Error';
    } finally {
      uploadingImage = false;
    }
  }
</script>

<div class="mx-auto max-w-3xl px-3 py-5 sm:px-6">
  <div class="mb-8 flex items-center gap-3">
    <button
      onclick={() => goto('/forms')}
      class="text-text-muted hover:text-text-main hover:bg-cn-border/30 rounded-xl p-2 transition-colors"
      title={m.common_back()}
    >
      <ArrowLeft size={20} />
    </button>
    <div class="min-w-0 flex-1">
      <h1 class="text-text-main text-2xl font-extrabold tracking-tight">{m.form_edit_heading()}</h1>
      {#if form}
        <p class="text-text-muted mt-0.5 truncate text-sm">{form.title}</p>
      {/if}
    </div>
  </div>

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
        class="border-cn-yellow h-10 w-10 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else}
    {#if error}
      <div
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

      <div>
        <p class={CONTROL_LABEL_CLASS}>{m.form_association_label()}</p>
        <!-- Shown, never editable: the link is fixed at creation, and a disabled picker would
             suggest it could be changed by someone with more rights. There is no such someone. -->
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
        <p class={CONTROL_HINT_CLASS}>{m.form_association_locked_hint()}</p>
      </div>

      <div>
        <p class={CONTROL_LABEL_CLASS}>{m.form_image_section()}</p>
        {#if imageError}
          <p class="text-red-err mb-2 text-sm">{imageError}</p>
        {/if}
        {#if imageUrl}
          <div class="border-cn-border relative overflow-hidden rounded-xl border">
            <img
              src={imageUrl}
              alt={m.form_image_section()}
              class="max-h-56 w-full object-cover"
              loading="lazy"
            />
            <button
              type="button"
              onclick={handleImageRemove}
              disabled={uploadingImage}
              class="absolute top-2 right-2 rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80"
              title={m.form_image_remove_title()}
            >
              <X size={14} />
            </button>
          </div>
        {:else}
          <label
            class="border-cn-border bg-cn-bg/40 text-text-muted hover:border-cn-yellow/50 flex cursor-pointer items-center gap-2 rounded-xl border-2 border-dashed px-4 py-4 text-sm transition-colors {uploadingImage
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
      bind:basePrice
      bind:allowCashPayment
      bind:cashPaymentExpiryDays
      bind:priceMatrix
      {tiers}
      {formations}
      {items}
      associationName={association?.name ?? ''}
      {associationCanBePaid}
    />

    <!-- 3. Questions -->
    <FormQuestionsSection
      bind:items
      {requiresPayment}
      {gridQuestionIds}
      {tiers}
      {formations}
      imageUploadFn={async (file) => {
        const r = await uploadFormItemImage(formId, file);
        return r.imageUrl;
      }}
    />

    <!-- 4. Rarely wanted, and folded away -->
    <FormAdvancedSettings
      bind:maxSubmissions
      bind:allowMultipleSubmissions
      bind:opensAt
      bind:submitCondition
      bind:settings={cotisation}
      {tiers}
      {formations}
      {grantBlocker}
      associationName={association?.name ?? ''}
    />

    <FormSaveBar
      {titleMissing}
      {isSubmitting}
      {summary}
      saveLabel={m.form_save_changes_button()}
      onSave={handleSave}
    />
  {/if}
</div>
