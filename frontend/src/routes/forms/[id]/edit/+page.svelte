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
    addFormCoOwner,
    removeFormCoOwner,
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
  import { fetchUserProfile } from '$lib/stores/user';
  import FormSection from '$lib/components/forms/FormSection.svelte';
  import FormAdvancedSettings from '$lib/components/forms/FormAdvancedSettings.svelte';
  import FormAudienceSection from '$lib/components/forms/FormAudienceSection.svelte';
  import FormPaymentSection from '$lib/components/forms/FormPaymentSection.svelte';
  import FormQuestionsSection from '$lib/components/forms/FormQuestionsSection.svelte';
  import FormSaveBar from '$lib/components/forms/FormSaveBar.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import {
    CONTROL_HINT_CLASS,
    CONTROL_LABEL_CLASS,
    controlClass,
  } from '$lib/components/ui/controlClasses';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import UserAutocomplete from '$lib/components/shared/UserAutocomplete.svelte';
  import {
    canGrantCotisation,
    cotisationOptionsFor,
    cotisationPayload,
    cotisationSettingsOf,
    emptyCotisationSettings,
  } from '$lib/forms/cotisationSettings';
  import { matrixOf, matrixPayload, type PriceMatrix } from '$lib/forms/priceMatrix';
  import { fetchFormations, type FormationOption } from '$lib/forms/criteriaOptions';
  import { firstEmptyCondition } from '$lib/forms/audience';
  import { fromFormItems, toFormItemsPayload } from '$lib/forms/itemsPayload';
  import {
    AlertCircle,
    ArrowLeft,
    FileText,
    ImagePlus,
    MessageSquareReply,
    Trash2,
    Users,
    X,
  } from '@lucide/svelte';
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

  // Co-owners
  let coOwners = $state<{ id: string; displayName: string }[]>([]);
  let coOwnerInput = $state('');
  let addingCoOwner = $state(false);
  let coOwnerError = $state('');

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

  const grantOfferable = $derived(
    canGrantCotisation(requiresPayment, association?.id ?? '', tiers.length, mayGrantCotisation)
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
      const coOwnerIds = f.coOwners ?? [];
      const profiles = await Promise.allSettled(coOwnerIds.map((cid) => fetchUserProfile(cid)));
      coOwners = coOwnerIds.map((cid, i) => {
        const p = profiles[i].status === 'fulfilled' ? profiles[i].value : null;
        const name =
          (p?.displayName ?? `${p?.firstName ?? ''} ${p?.lastName ?? ''}`.trim()) ||
          cid.slice(0, 8) + '…';
        return { id: cid, displayName: name };
      });
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
  const questionCountLabel = $derived(
    items.length === 1
      ? m.form_questions_count_one()
      : m.form_questions_count({ count: items.length })
  );

  async function handleSave() {
    if (titleMissing) {
      error = m.form_error_title_required_short();
      return;
    }
    if (requiresPayment && !association) {
      error = m.form_error_association_required_short();
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
        submitLabel: requiresPayment ? 'Envoyer et payer' : 'Envoyer',
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

  async function handleAddCoOwner(userId: string, displayName?: string) {
    if (!userId || coOwners.some((c) => c.id === userId)) return;
    addingCoOwner = true;
    coOwnerError = '';
    try {
      await addFormCoOwner(formId, userId);
      let name = displayName;
      if (!name) {
        try {
          const p = await fetchUserProfile(userId);
          name = p.displayName ?? `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim();
        } catch {
          name = userId.slice(0, 8) + '…';
        }
      }
      coOwners = [...coOwners, { id: userId, displayName: name || userId.slice(0, 8) + '…' }];
      coOwnerInput = '';
    } catch (err: any) {
      coOwnerError = err.message || 'Error';
    } finally {
      addingCoOwner = false;
    }
  }

  async function handleRemoveCoOwner(userId: string) {
    try {
      await removeFormCoOwner(formId, userId);
      coOwners = coOwners.filter((c) => c.id !== userId);
    } catch (err: any) {
      coOwnerError = err.message || 'Error';
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
      <AlertCircle size={18} class="shrink-0" />
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
        <AlertCircle size={18} class="shrink-0" />
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

    <!-- 2. How answers are accepted -->
    <FormSection title={m.form_section_responses()} icon={MessageSquareReply}>
      <Input
        label={m.form_max_responses_label()}
        type="number"
        bind:value={maxSubmissions}
        placeholder={m.form_max_responses_placeholder()}
        min="1"
      />

      <Toggle
        bind:checked={allowMultipleSubmissions}
        label={m.form_allow_multiple_label()}
        hint={m.form_allow_multiple_hint()}
      />

      <div>
        <label for="form-opens-at" class={CONTROL_LABEL_CLASS}>{m.form_opens_at_label()}</label>
        <input
          id="form-opens-at"
          type="datetime-local"
          bind:value={opensAt}
          class={controlClass()}
        />
        <p class={CONTROL_HINT_CLASS}>{m.form_opens_at_hint()}</p>
      </div>
    </FormSection>

    <!-- 3. Who it is for -->
    <FormAudienceSection bind:submitCondition {tiers} {formations} />

    <!-- 4. Money -->
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

    <!-- 5. Questions -->
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

    <!-- 6. Who else may manage it -->
    <FormSection title={m.form_coowners_section()} icon={Users}>
      <p class="text-text-muted text-sm">{m.form_coowners_desc()}</p>
      {#if coOwnerError}
        <p class="text-red-err text-sm">{coOwnerError}</p>
      {/if}
      {#if coOwners.length > 0}
        <ul class="space-y-2">
          {#each coOwners as co (co.id)}
            <li
              class="border-cn-border bg-cn-bg/40 flex items-center justify-between gap-3 rounded-xl border px-3 py-2"
            >
              <span class="text-text-main truncate text-sm font-medium">{co.displayName}</span>
              <button
                type="button"
                onclick={() => handleRemoveCoOwner(co.id)}
                class="border-red-err/30 hover:bg-red-err/10 rounded-lg border p-1.5 text-red-500 transition-colors"
                title={m.common_remove_label()}
              >
                <Trash2 size={13} />
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      <div class="flex gap-2">
        <div class="min-w-0 flex-1">
          <UserAutocomplete
            value={coOwnerInput}
            onValueChange={(v) => (coOwnerInput = v)}
            placeholder={m.form_coowner_search_placeholder()}
            onSelect={(u) => handleAddCoOwner(u.id, u.displayName ?? undefined)}
          />
        </div>
        <button
          type="button"
          onclick={() => handleAddCoOwner(coOwnerInput.trim())}
          disabled={addingCoOwner || !coOwnerInput.trim()}
          class="border-cn-border hover:bg-cn-bg shrink-0 rounded-xl border px-3 py-2 text-sm font-semibold disabled:opacity-40"
        >
          {addingCoOwner ? '…' : m.form_coowner_add_button()}
        </button>
      </div>
    </FormSection>

    <!-- 7. Rarely wanted, and folded away -->
    <FormAdvancedSettings
      bind:settings={cotisation}
      {tiers}
      available={grantOfferable}
      associationName={association?.name ?? ''}
    />

    <FormSaveBar
      {titleMissing}
      {isSubmitting}
      summary={questionCountLabel}
      saveLabel={m.form_save_changes_button()}
      onSave={handleSave}
    />
  {/if}
</div>
