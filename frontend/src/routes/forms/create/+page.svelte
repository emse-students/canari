<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { createForm, type CreateFormPayload } from '$lib/forms/api';
  import { POST_NEW_FORM_ID_KEY, loadPostComposerDraft } from '$lib/posts/postComposerDraft';
  import {
    canAssociationReceiveFormPayments,
    listMyAssociations,
    type Association,
    type MembershipTier,
  } from '$lib/associations/api';
  import FormSection from '$lib/components/forms/FormSection.svelte';
  import FormAdvancedSettings from '$lib/components/forms/FormAdvancedSettings.svelte';
  import FormPaymentSection from '$lib/components/forms/FormPaymentSection.svelte';
  import FormQuestionsSection from '$lib/components/forms/FormQuestionsSection.svelte';
  import FormSaveBar from '$lib/components/forms/FormSaveBar.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import {
    CONTROL_HINT_CLASS,
    CONTROL_LABEL_CLASS,
    controlClass,
  } from '$lib/components/ui/controlClasses';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import {
    canGrantCotisation,
    canOfferMemberPrice,
    cotisationOptionsFor,
    cotisationPayload,
    emptyCotisationSettings,
    forgetTierSelection,
  } from '$lib/forms/cotisationSettings';
  import { toFormItemsPayload } from '$lib/forms/itemsPayload';
  import { AlertCircle, ArrowLeft, FileText, MessageSquareReply } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  // General
  let title = $state('');
  let description = $state('');
  let maxSubmissions = $state<number | undefined>(undefined);
  let opensAt = $state('');
  let allowMultipleSubmissions = $state(false);

  // Payment
  let basePrice = $state(0);
  let requiresPayment = $state(false);
  let associationId = $state('');
  let allowCashPayment = $state(false);
  let cashPaymentExpiryDays = $state<number | undefined>(undefined);
  let cotisation = $state(emptyCotisationSettings());

  const returnTo = $derived(page.url.searchParams.get('returnTo') || '/forms');
  const fromPostComposer = $derived(
    returnTo === '/posts' && page.url.searchParams.get('attach') === 'form'
  );
  const contentMaxWidth = $derived(fromPostComposer ? 'max-w-xl' : 'max-w-3xl');

  /**
   * The associations the user belongs to - not every association there is.
   *
   * Creating a form for an association requires MEMBERSHIP of it, so listing all of them offered a
   * choice the save would then refuse: pick, save, 403. The list is not filtered on Stripe
   * readiness either, because a FREE form may be linked to any association it belongs to; the
   * payment section says so when a chosen association cannot take money yet.
   */
  let associations = $state<Association[]>([]);
  const selectedAssociation = $derived(associations.find((a) => a.id === associationId));
  const associationCanBePaid = $derived(
    !!selectedAssociation && canAssociationReceiveFormPayments(selectedAssociation)
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

  const memberPriceOfferable = $derived(
    canOfferMemberPrice(requiresPayment, associationId, tiers.length)
  );
  const grantOfferable = $derived(
    canGrantCotisation(requiresPayment, associationId, tiers.length, mayGrantCotisation)
  );

  onMount(async () => {
    const draft = loadPostComposerDraft();
    if (draft?.scheduledAt && !opensAt) {
      opensAt = draft.scheduledAt;
    }
    try {
      associations = await listMyAssociations();
    } catch {
      // Ignore - the user may belong to none, which simply means personal forms only.
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
  const showMemberPricing = $derived(requiresPayment && cotisation.memberPriceEnabled);

  const questionCountLabel = $derived(
    items.length === 1
      ? m.form_questions_count_one()
      : m.form_questions_count({ count: items.length })
  );
  const summary = $derived.by(() => {
    if (!requiresPayment) return `${questionCountLabel} · ${m.form_free_label()}`;
    if (basePrice <= 0) return questionCountLabel;
    const price = basePrice.toLocaleString(getLocale() === 'en' ? 'en-US' : 'fr-FR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
    return `${questionCountLabel} · ${price} €`;
  });

  async function handleSave() {
    if (titleMissing) {
      error = m.form_error_title_required();
      return;
    }
    if (requiresPayment && !associationId) {
      error = m.form_error_association_required();
      return;
    }
    isSubmitting = true;
    error = '';
    try {
      const payload: CreateFormPayload = {
        title,
        description,
        basePrice: requiresPayment ? Math.round(basePrice * 100) : 0,
        ...cotisationPayload(cotisation, requiresPayment),
        currency: 'eur',
        submitLabel: requiresPayment ? 'Envoyer et payer' : 'Envoyer',
        items: toFormItemsPayload(items),
        maxSubmissions,
        allowMultipleSubmissions,
        ...(opensAt ? { opensAt: new Date(opensAt).toISOString() } : {}),
        requiresPayment,
        associationId: requiresPayment && associationId ? associationId : undefined,
        ...(requiresPayment ? { allowCashPayment } : {}),
        ...(requiresPayment && allowCashPayment && cashPaymentExpiryDays != null
          ? { cashPaymentExpiryDays }
          : {}),
      };
      const created = await createForm(payload);
      if (fromPostComposer) {
        sessionStorage.setItem(POST_NEW_FORM_ID_KEY, created.id);
        goto('/posts');
      } else {
        goto(returnTo);
      }
    } catch (e: any) {
      error = e.message;
    } finally {
      isSubmitting = false;
    }
  }
</script>

<div class="px-3 py-5 sm:px-6 {contentMaxWidth} mx-auto">
  <div class="mb-8 flex items-center gap-3">
    <button
      onclick={() => goto(fromPostComposer ? '/posts' : returnTo)}
      class="text-text-muted hover:text-text-main hover:bg-cn-border/30 rounded-xl p-2 transition-colors"
      title={m.common_back()}
    >
      <ArrowLeft size={20} />
    </button>
    <div class="min-w-0 flex-1">
      <h1 class="text-text-main text-2xl font-extrabold tracking-tight">
        {m.form_create_heading()}
      </h1>
      <p class="text-text-muted mt-0.5 text-sm">{m.form_create_subtitle()}</p>
    </div>
  </div>

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

    {#if associations.length > 0}
      <Select
        id="association-select"
        label={m.form_association_label()}
        hint={m.form_association_hint()}
        value={associationId}
        options={[
          { value: '', label: m.form_association_none() },
          ...associations.map((a) => ({ value: a.id, label: a.name })),
        ]}
        onValueChange={(v) => (associationId = v)}
      />
    {/if}

    <p class={CONTROL_HINT_CLASS}>{m.form_image_add_after_create()}</p>
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
      <input id="form-opens-at" type="datetime-local" bind:value={opensAt} class={controlClass()} />
      <p class={CONTROL_HINT_CLASS}>{m.form_opens_at_hint()}</p>
    </div>
  </FormSection>

  <!-- 3. Money -->
  <FormPaymentSection
    bind:requiresPayment
    bind:basePrice
    bind:allowCashPayment
    bind:cashPaymentExpiryDays
    bind:cotisation
    {tiers}
    associationName={selectedAssociation?.name ?? ''}
    {associationCanBePaid}
    canOfferMemberPrice={memberPriceOfferable}
  />

  <!-- 4. Questions -->
  <FormQuestionsSection bind:items {requiresPayment} showMemberPriceModifier={showMemberPricing} />

  <!-- 5. Rarely wanted, and folded away -->
  <FormAdvancedSettings
    bind:settings={cotisation}
    {tiers}
    available={grantOfferable}
    associationName={selectedAssociation?.name ?? ''}
  />

  <FormSaveBar
    {titleMissing}
    {isSubmitting}
    {summary}
    saveLabel={m.form_save_button()}
    onSave={handleSave}
  />
</div>
