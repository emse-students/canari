<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { createForm, type CreateFormPayload } from '$lib/forms/api';
  import { POST_NEW_FORM_ID_KEY, loadPostComposerDraft } from '$lib/posts/postComposerDraft';
  import {
    canAssociationReceiveFormPayments,
    listAssociations,
    type Association,
  } from '$lib/associations/api';
  import FormBuilder from '$lib/components/forms/FormBuilder.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import StripeNetPayoutHint from '$lib/components/payments/StripeNetPayoutHint.svelte';
  import AssociationTagAutocomplete from '$lib/components/shared/AssociationTagAutocomplete.svelte';
  import { ArrowLeft, Save, Plus, FileText, CreditCard, ListChecks } from '@lucide/svelte';
  import { QUESTION_TYPES } from '$lib/forms/questionTypes';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  // State
  let title = $state('');
  let description = $state('');
  let basePrice = $state(0);
  let basePriceMember = $state<number | ''>('');
  let pricingTagName = $state('');
  let maxSubmissions = $state<number | undefined>(undefined);
  let opensAt = $state('');
  let requiresPayment = $state(false);
  let associationId = $state('');
  let allowCashPayment = $state(false);
  let allowMultipleSubmissions = $state(false);
  let cashPaymentExpiryDays = $state<number | undefined>(undefined);

  const returnTo = $derived(page.url.searchParams.get('returnTo') || '/forms');
  const fromPostComposer = $derived(
    returnTo === '/posts' && page.url.searchParams.get('attach') === 'form'
  );
  const contentMaxWidth = $derived(fromPostComposer ? 'max-w-xl' : 'max-w-3xl');

  // Associations with Stripe Connect active (eligible as payment recipients)
  let associations = $state<Association[]>([]);

  onMount(async () => {
    const draft = loadPostComposerDraft();
    if (draft?.scheduledAt && !opensAt) {
      opensAt = draft.scheduledAt;
    }
    try {
      const all = await listAssociations('association');
      associations = all.filter((a) => canAssociationReceiveFormPayments(a));
    } catch {
      // Ignore - user may not have access
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

  // Drag-and-drop reordering
  let dragIndex = $state(-1);
  let dropIndex = $state(-1);

  // Type picker
  let showTypePicker = $state(false);

  let titleMissing = $derived(!title.trim());
  const showMemberPricing = $derived(requiresPayment && !!pricingTagName.trim());

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
        ...(requiresPayment && pricingTagName.trim()
          ? { pricingTagName: pricingTagName.trim() }
          : {}),
        ...(requiresPayment && basePriceMember !== ''
          ? { basePriceMember: Math.round(Number(basePriceMember) * 100) }
          : {}),
        currency: 'eur',
        submitLabel: requiresPayment ? 'Envoyer et payer' : 'Envoyer',
        items: items.map((item) => {
          const hasOpts = !['short_text', 'long_text', 'linear_scale'].includes(item.type);
          return {
            ...item,
            options: hasOpts
              ? (item.options ?? [])
                  .filter((opt: any) => opt.label?.trim())
                  .map((opt: any) => ({
                    ...opt,
                    priceModifier:
                      opt.priceModifier != null ? Math.round(opt.priceModifier * 100) : 0,
                    ...(opt.priceModifierMember != null && opt.priceModifierMember !== ''
                      ? {
                          priceModifierMember: Math.round(Number(opt.priceModifierMember) * 100),
                        }
                      : {}),
                  }))
              : [],
            rows: (item.rows ?? [])
              .map((r: any) => (typeof r === 'string' ? r : r.value))
              .filter(Boolean),
          };
        }),
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

  function addItem(type: string = 'short_text') {
    items = [
      ...items,
      {
        id: crypto.randomUUID(),
        label: '',
        required: false,
        type,
        options: [{ label: '', priceModifier: undefined }],
        rows: [],
      },
    ];
    showTypePicker = false;
  }

  function removeItem(index: number) {
    items = items.filter((_, i) => i !== index);
  }

  function moveItem(index: number, direction: 'up' | 'down') {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= items.length) return;
    const copy = [...items];
    [copy[index], copy[newIndex]] = [copy[newIndex], copy[index]];
    items = copy;
  }

  function handleDragStart(index: number) {
    dragIndex = index;
  }

  function handleDragOver(e: DragEvent, index: number) {
    e.preventDefault();
    dropIndex = index;
  }

  function handleDrop(index: number) {
    if (dragIndex === -1 || dragIndex === index) {
      dragIndex = -1;
      dropIndex = -1;
      return;
    }
    const copy = [...items];
    const [moved] = copy.splice(dragIndex, 1);
    copy.splice(index, 0, moved);
    items = copy;
    dragIndex = -1;
    dropIndex = -1;
  }

  function handleDragEnd() {
    dragIndex = -1;
    dropIndex = -1;
  }
</script>

<div class="px-3 py-5 sm:px-6 {contentMaxWidth} mx-auto">
  <!-- Header -->
  <div class="flex items-center gap-3 mb-8">
    <button
      onclick={() => goto(fromPostComposer ? '/posts' : returnTo)}
      class="p-2 rounded-xl text-text-muted hover:text-text-main hover:bg-cn-border/30 transition-colors"
      title={m.common_back()}
    >
      <ArrowLeft size={20} />
    </button>
    <div class="flex-1 min-w-0">
      <h1 class="text-2xl font-extrabold text-text-main tracking-tight">
        {m.form_create_heading()}
      </h1>
      <p class="text-sm text-text-muted mt-0.5">{m.form_create_subtitle()}</p>
    </div>
  </div>

  {#if error}
    <div
      class="rounded-2xl bg-red-50 border-2 border-red-200 text-red-700 px-4 py-3 mb-6 text-sm font-medium flex items-center gap-2"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="shrink-0"
      >
        <circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line
          x1="12"
          x2="12.01"
          y1="16"
          y2="16"
        />
      </svg>
      {error}
    </div>
  {/if}

  <!-- Section 1: General Settings -->
  <section
    class="rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)] p-4 sm:p-6 mb-4 sm:mb-5"
  >
    <div class="flex items-center gap-2.5 mb-4 sm:mb-5">
      <div class="p-2 rounded-xl bg-cn-yellow/15 text-cn-dark">
        <FileText size={20} />
      </div>
      <h2 class="text-lg font-bold text-text-main">{m.form_section_general()}</h2>
    </div>

    <div class="space-y-4">
      <Input
        label={m.form_title_label()}
        bind:value={title}
        placeholder={m.form_title_placeholder()}
        required
      />

      <div>
        <p class="block text-sm font-bold text-text-main mb-1 ml-1">{m.form_description_label()}</p>
        <MarkdownComposerField
          bind:value={description}
          placeholder={m.form_description_placeholder()}
          minHeight="80px"
        />
      </div>

      <Input
        label={m.form_max_responses_label()}
        type="number"
        bind:value={maxSubmissions}
        placeholder={m.form_max_responses_placeholder()}
        min="1"
      />

      <label class="flex items-center gap-3 cursor-pointer select-none group">
        <div class="relative">
          <input type="checkbox" bind:checked={allowMultipleSubmissions} class="peer sr-only" />
          <div
            class="w-11 h-6 bg-cn-border rounded-full peer-checked:bg-cn-yellow transition-colors"
          ></div>
          <div
            class="absolute left-1 top-1 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-5"
          ></div>
        </div>
        <div>
          <span class="text-sm font-semibold text-text-main">{m.form_allow_multiple_label()}</span>
          <p class="text-xs text-text-muted">{m.form_allow_multiple_hint()}</p>
        </div>
      </label>

      <div>
        <label for="form-opens-at" class="block text-sm font-bold text-text-main mb-2 ml-1">
          {m.form_opens_at_label()}
        </label>
        <input
          id="form-opens-at"
          type="datetime-local"
          bind:value={opensAt}
          class="w-full px-4 py-3 border-2 border-cn-border rounded-2xl text-base text-text-main bg-[var(--cn-surface)] outline-none transition-all focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)]"
        />
        <p class="text-xs text-text-muted mt-1.5 ml-1">
          {m.form_opens_at_hint()}
        </p>
      </div>
    </div>
  </section>

  <!-- Section 2: Payment -->
  <section
    class="rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)] p-4 sm:p-6 mb-4 sm:mb-5"
  >
    <div class="flex items-center gap-2.5 mb-4 sm:mb-5">
      <div class="p-2 rounded-xl bg-cn-yellow/15 text-cn-dark">
        <CreditCard size={20} />
      </div>
      <h2 class="text-lg font-bold text-text-main">{m.form_section_payment()}</h2>
    </div>

    <label class="flex items-center gap-3 cursor-pointer select-none group">
      <div class="relative">
        <input type="checkbox" bind:checked={requiresPayment} class="peer sr-only" />
        <div
          class="w-11 h-6 bg-cn-border rounded-full peer-checked:bg-cn-yellow transition-colors"
        ></div>
        <div
          class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform peer-checked:translate-x-5"
        ></div>
      </div>
      <span class="text-sm font-semibold text-text-main">{m.form_requires_payment_label()}</span>
    </label>

    {#if requiresPayment}
      <div class="mt-5 pt-5 border-t-2 border-cn-border">
        <Input
          label={m.form_base_price_label()}
          type="number"
          bind:value={basePrice}
          min="0"
          step="0.01"
          placeholder="0.00"
        />
      </div>

      <!-- Recipient Association -->
      <div class="mt-4">
        <label for="association-select" class="block text-sm font-bold text-text-main mb-2 ml-1"
          >{m.form_association_label()}</label
        >
        {#if associations.length > 0}
          <select
            id="association-select"
            bind:value={associationId}
            class="w-full px-4 py-3 border-2 border-cn-border rounded-2xl text-base text-text-main bg-[var(--cn-surface)] outline-none transition-all focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)]"
          >
            <option value="">{m.form_association_placeholder()}</option>
            {#each associations as a (a.id)}
              <option value={a.id}>{a.name}</option>
            {/each}
          </select>
          <p class="text-xs text-text-muted mt-1 ml-1">
            {m.form_association_payments_hint()}
          </p>
        {:else}
          <div
            class="rounded-2xl border-2 border-amber-200 bg-amber-50/60 dark:bg-amber-950/20 px-4 py-3 space-y-2"
          >
            <p class="text-sm font-semibold text-amber-900 dark:text-amber-100">
              {m.form_no_stripe_title()}
            </p>
            <p class="text-xs text-amber-800/80 dark:text-amber-200/70">
              {m.form_no_stripe_desc()}
            </p>
            <button
              type="button"
              onclick={() => {
                requiresPayment = false;
              }}
              class="inline-flex items-center gap-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-900 dark:text-amber-100 px-3 py-1.5 text-xs font-bold transition-colors"
            >
              {m.form_no_stripe_create_free_button()}
            </button>
          </div>
        {/if}
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
        <div class="space-y-1">
          <label for="pricing-tag-autocomplete" class="block text-sm font-bold text-text-main ml-1"
            >{m.form_member_tag_label()}</label
          >
          <AssociationTagAutocomplete
            {associationId}
            value={pricingTagName}
            onValueChange={(v) => (pricingTagName = v)}
            inputId="pricing-tag-autocomplete"
            placeholder={m.form_member_tag_search_placeholder()}
          />
        </div>
        <Input
          label={m.form_member_price_label()}
          type="number"
          bind:value={basePriceMember}
          min="0"
          step="0.01"
          placeholder={m.form_member_price_placeholder()}
          disabled={!showMemberPricing}
        />
      </div>
      <p class="text-xs text-text-muted mt-1 ml-1">
        {m.form_member_tag_hint()}
      </p>

      <div class="mt-4">
        <StripeNetPayoutHint
          grossEuros={basePrice}
          grossEurosMember={showMemberPricing ? basePriceMember : ''}
          showOptionSupplementNote={true}
        />
      </div>

      <!-- Payment methods -->
      <div class="mt-4 pt-4 border-t-2 border-cn-border">
        <p class="text-sm font-bold text-text-main mb-3">{m.form_payment_methods_heading()}</p>
        <div
          class="flex items-center gap-4 rounded-2xl border-2 border-cn-yellow bg-cn-yellow/5 px-4 py-3.5"
        >
          <div
            class="shrink-0 w-10 h-10 rounded-xl bg-cn-yellow/20 text-cn-dark flex items-center justify-center"
          >
            <CreditCard size={20} />
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-bold text-text-main">{m.form_card_payment_label()}</p>
            <p class="text-xs text-text-muted">
              {m.form_card_payment_desc()}
            </p>
          </div>
          <div
            class="shrink-0 flex items-center gap-1.5 rounded-full bg-cn-yellow/30 text-cn-dark px-3 py-1 text-xs font-bold"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="3"
              stroke-linecap="round"
              stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg
            >
            {m.form_card_active_badge()}
          </div>
        </div>
      </div>

      <!-- Cash payment option -->
      <div class="mt-4 pt-4 border-t-2 border-cn-border space-y-3">
        <label class="flex items-center gap-3 cursor-pointer select-none">
          <div class="relative">
            <input type="checkbox" bind:checked={allowCashPayment} class="peer sr-only" />
            <div
              class="w-11 h-6 bg-cn-border rounded-full peer-checked:bg-cn-yellow transition-colors"
            ></div>
            <div
              class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform peer-checked:translate-x-5"
            ></div>
          </div>
          <span class="text-sm font-semibold text-text-main">{m.form_cash_label()}</span>
        </label>
        {#if allowCashPayment}
          <div>
            <label for="cash-expiry" class="block text-sm font-bold text-text-main mb-2 ml-1">
              {m.form_cash_expiry_label()}
            </label>
            <input
              id="cash-expiry"
              type="number"
              bind:value={cashPaymentExpiryDays}
              min="1"
              placeholder={m.form_cash_expiry_placeholder()}
              class="w-full sm:w-48 px-4 py-3 border-2 border-cn-border rounded-2xl text-base text-text-main bg-[var(--cn-surface)] outline-none transition-all focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)]"
            />
            <p class="text-xs text-text-muted mt-1.5 ml-1">
              {m.form_cash_expiry_hint()}
            </p>
          </div>
        {/if}
      </div>
    {/if}
  </section>

  <!-- TODO: affichage de formulaires differents selon le tag 'cotisant:bde' de l'utilisateur - a implementer ulterieurement -->

  <!-- Section 3: Questions -->
  <section class="rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)] p-3 sm:p-6">
    <div class="flex items-center gap-2.5 mb-4 sm:mb-5 px-1 sm:px-0">
      <div class="p-2 rounded-xl bg-cn-yellow/15 text-cn-dark">
        <ListChecks size={20} />
      </div>
      <h2 class="text-lg font-bold text-text-main">{m.form_section_questions()}</h2>
      <span
        class="ml-auto text-xs font-semibold text-text-muted bg-cn-border/40 px-2.5 py-1 rounded-full"
      >
        {items.length === 1
          ? m.form_questions_count_one()
          : m.form_questions_count({ count: items.length })}
      </span>
    </div>

    <div class="space-y-3 sm:space-y-4">
      {#each items as _item, i (_item.id)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          draggable="true"
          ondragstart={() => handleDragStart(i)}
          ondragover={(e) => handleDragOver(e, i)}
          ondrop={() => handleDrop(i)}
          ondragend={handleDragEnd}
          class="transition-all duration-150 {dragIndex === i
            ? 'opacity-40 scale-[0.98]'
            : ''} {dropIndex === i && dragIndex !== i
            ? 'ring-2 ring-cn-yellow/60 ring-offset-1 rounded-[2rem]'
            : ''}"
        >
          <FormBuilder
            bind:item={items[i]}
            onRemove={() => removeItem(i)}
            showPriceModifier={requiresPayment}
            showMemberPriceModifier={showMemberPricing}
            questionIndex={i + 1}
            onMoveUp={() => moveItem(i, 'up')}
            onMoveDown={() => moveItem(i, 'down')}
            canMoveUp={i > 0}
            canMoveDown={i < items.length - 1}
            allItems={items}
          />
        </div>
      {/each}
    </div>

    <div class="relative mt-5">
      <button
        type="button"
        onclick={() => (showTypePicker = !showTypePicker)}
        class="w-full py-3 rounded-2xl border-2 border-dashed border-cn-border text-sm font-bold text-text-muted hover:border-cn-yellow hover:text-cn-dark hover:bg-cn-yellow/5 transition-all flex items-center justify-center gap-2"
      >
        <Plus size={18} />
        {m.form_add_question_button()}
      </button>

      {#if showTypePicker}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="fixed inset-0 z-40" onclick={() => (showTypePicker = false)}></div>
        <div
          class="absolute bottom-full left-0 right-0 mb-2 z-50 rounded-2xl border-2 border-cn-border bg-[var(--cn-surface)] shadow-xl p-3"
        >
          <p class="text-[0.65rem] font-bold text-text-muted uppercase tracking-wider mb-2.5 ml-1">
            {m.form_question_type_picker_label()}
          </p>
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            {#each QUESTION_TYPES as qtype (qtype.value)}
              {@const Icon = qtype.Icon}
              <button
                type="button"
                onclick={() => addItem(qtype.value)}
                class="flex flex-col items-center gap-1.5 p-2.5 rounded-xl border border-cn-border hover:border-cn-yellow hover:bg-cn-yellow/5 text-center transition-all group"
              >
                <Icon
                  size={18}
                  class="text-text-muted group-hover:text-cn-dark transition-colors"
                />
                <span
                  class="text-[0.65rem] font-semibold text-text-muted group-hover:text-text-main leading-tight"
                  >{qtype.label()}</span
                >
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </section>

  <!-- Save bar -->
  <div
    class="mt-5 rounded-2xl border border-cn-border/60 bg-[var(--cn-surface)]/85 dark:bg-[#151B2C]/85 backdrop-blur-xl shadow-lg px-4 sm:px-5 py-3.5 flex flex-col sm:flex-row items-center justify-center sm:justify-between gap-3 text-center sm:text-left"
  >
    <p class="text-sm text-text-muted min-h-[1.25rem]">
      {#if titleMissing}
        <span class="text-amber-600 font-medium">{m.form_title_required_hint()}</span>
      {:else}
        {items.length === 1
          ? m.form_questions_count_one()
          : m.form_questions_count({ count: items.length })}{#if requiresPayment && basePrice > 0}
          · {basePrice.toLocaleString(getLocale() === 'en' ? 'en-US' : 'fr-FR', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2,
          })} €
        {:else if !requiresPayment}
          · {m.form_free_label()}
        {/if}
      {/if}
    </p>
    <button
      onclick={handleSave}
      disabled={isSubmitting || titleMissing}
      class="inline-flex items-center justify-center gap-2 rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0 w-full sm:w-auto"
    >
      <Save size={16} />
      {isSubmitting ? m.form_saving_label() : m.form_save_button()}
    </button>
  </div>
</div>
