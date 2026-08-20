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
  <section class="border-cn-border mb-4 rounded-2xl border-2 bg-(--cn-surface) p-4 sm:mb-5 sm:p-6">
    <div class="mb-4 flex items-center gap-2.5 sm:mb-5">
      <div class="bg-cn-yellow/15 text-cn-dark rounded-xl p-2">
        <FileText size={20} />
      </div>
      <h2 class="text-text-main text-lg font-bold">{m.form_section_general()}</h2>
    </div>

    <div class="space-y-4">
      <Input
        label={m.form_title_label()}
        bind:value={title}
        placeholder={m.form_title_placeholder()}
        required
      />

      <div>
        <p class="text-text-main mb-1 ml-1 block text-sm font-bold">{m.form_description_label()}</p>
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

      <label class="group flex cursor-pointer items-center gap-3 select-none">
        <div class="relative">
          <input type="checkbox" bind:checked={allowMultipleSubmissions} class="peer sr-only" />
          <div
            class="bg-cn-border peer-checked:bg-cn-yellow h-6 w-11 rounded-full transition-colors"
          ></div>
          <div
            class="absolute top-1 left-1 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-5"
          ></div>
        </div>
        <div>
          <span class="text-text-main text-sm font-semibold">{m.form_allow_multiple_label()}</span>
          <p class="text-text-muted text-xs">{m.form_allow_multiple_hint()}</p>
        </div>
      </label>

      <div>
        <label for="form-opens-at" class="text-text-main mb-2 ml-1 block text-sm font-bold">
          {m.form_opens_at_label()}
        </label>
        <input
          id="form-opens-at"
          type="datetime-local"
          bind:value={opensAt}
          class="border-cn-border text-text-main focus:border-cn-yellow w-full rounded-2xl border-2 bg-(--cn-surface) px-4 py-3 text-base transition-all outline-none focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)]"
        />
        <p class="text-text-muted mt-1.5 ml-1 text-xs">
          {m.form_opens_at_hint()}
        </p>
      </div>
    </div>
  </section>

  <!-- Section 2: Payment -->
  <section class="border-cn-border mb-4 rounded-2xl border-2 bg-(--cn-surface) p-4 sm:mb-5 sm:p-6">
    <div class="mb-4 flex items-center gap-2.5 sm:mb-5">
      <div class="bg-cn-yellow/15 text-cn-dark rounded-xl p-2">
        <CreditCard size={20} />
      </div>
      <h2 class="text-text-main text-lg font-bold">{m.form_section_payment()}</h2>
    </div>

    <label class="group flex cursor-pointer items-center gap-3 select-none">
      <div class="relative">
        <input type="checkbox" bind:checked={requiresPayment} class="peer sr-only" />
        <div
          class="bg-cn-border peer-checked:bg-cn-yellow h-6 w-11 rounded-full transition-colors"
        ></div>
        <div
          class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5"
        ></div>
      </div>
      <span class="text-text-main text-sm font-semibold">{m.form_requires_payment_label()}</span>
    </label>

    {#if requiresPayment}
      <div class="border-cn-border mt-5 border-t-2 pt-5">
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
        <label for="association-select" class="text-text-main mb-2 ml-1 block text-sm font-bold"
          >{m.form_association_label()}</label
        >
        {#if associations.length > 0}
          <select
            id="association-select"
            bind:value={associationId}
            class="border-cn-border text-text-main focus:border-cn-yellow w-full rounded-2xl border-2 bg-(--cn-surface) px-4 py-3 text-base transition-all outline-none focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)]"
          >
            <option value="">{m.form_association_placeholder()}</option>
            {#each associations as a (a.id)}
              <option value={a.id}>{a.name}</option>
            {/each}
          </select>
          <p class="text-text-muted mt-1 ml-1 text-xs">
            {m.form_association_payments_hint()}
          </p>
        {:else}
          <div
            class="border-amber-warn/30 bg-amber-warn/10 space-y-2 rounded-2xl border-2 px-4 py-3"
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
              class="inline-flex items-center gap-1.5 rounded-xl bg-amber-500/20 px-3 py-1.5 text-xs font-bold text-amber-900 transition-colors hover:bg-amber-500/30 dark:text-amber-100"
            >
              {m.form_no_stripe_create_free_button()}
            </button>
          </div>
        {/if}
      </div>

      <div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div class="space-y-1">
          <label for="pricing-tag-autocomplete" class="text-text-main ml-1 block text-sm font-bold"
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
      <p class="text-text-muted mt-1 ml-1 text-xs">
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
      <div class="border-cn-border mt-4 border-t-2 pt-4">
        <p class="text-text-main mb-3 text-sm font-bold">{m.form_payment_methods_heading()}</p>
        <div
          class="border-cn-yellow bg-cn-yellow/5 flex items-center gap-4 rounded-2xl border-2 px-4 py-3.5"
        >
          <div
            class="bg-cn-yellow/20 text-cn-dark flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
          >
            <CreditCard size={20} />
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-text-main text-sm font-bold">{m.form_card_payment_label()}</p>
            <p class="text-text-muted text-xs">
              {m.form_card_payment_desc()}
            </p>
          </div>
          <div
            class="bg-cn-yellow/30 text-cn-dark flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold"
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
      <div class="border-cn-border mt-4 space-y-3 border-t-2 pt-4">
        <label class="flex cursor-pointer items-center gap-3 select-none">
          <div class="relative">
            <input type="checkbox" bind:checked={allowCashPayment} class="peer sr-only" />
            <div
              class="bg-cn-border peer-checked:bg-cn-yellow h-6 w-11 rounded-full transition-colors"
            ></div>
            <div
              class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5"
            ></div>
          </div>
          <span class="text-text-main text-sm font-semibold">{m.form_cash_label()}</span>
        </label>
        {#if allowCashPayment}
          <div>
            <label for="cash-expiry" class="text-text-main mb-2 ml-1 block text-sm font-bold">
              {m.form_cash_expiry_label()}
            </label>
            <input
              id="cash-expiry"
              type="number"
              bind:value={cashPaymentExpiryDays}
              min="1"
              placeholder={m.form_cash_expiry_placeholder()}
              class="border-cn-border text-text-main focus:border-cn-yellow w-full rounded-2xl border-2 bg-(--cn-surface) px-4 py-3 text-base transition-all outline-none focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)] sm:w-48"
            />
            <p class="text-text-muted mt-1.5 ml-1 text-xs">
              {m.form_cash_expiry_hint()}
            </p>
          </div>
        {/if}
      </div>
    {/if}
  </section>

  <!-- TODO: affichage de formulaires differents selon le tag 'cotisant:bde' de l'utilisateur - a implementer ulterieurement -->

  <!-- Section 3: Questions -->
  <section class="border-cn-border rounded-2xl border-2 bg-(--cn-surface) p-3 sm:p-6">
    <div class="mb-4 flex items-center gap-2.5 px-1 sm:mb-5 sm:px-0">
      <div class="bg-cn-yellow/15 text-cn-dark rounded-xl p-2">
        <ListChecks size={20} />
      </div>
      <h2 class="text-text-main text-lg font-bold">{m.form_section_questions()}</h2>
      <span
        class="text-text-muted bg-cn-border/40 ml-auto rounded-full px-2.5 py-1 text-xs font-semibold"
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
            ? 'scale-[0.98] opacity-40'
            : ''} {dropIndex === i && dragIndex !== i
            ? 'ring-cn-yellow/60 rounded-[2rem] ring-2 ring-offset-1'
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
        class="border-cn-border text-text-muted hover:border-cn-yellow hover:text-cn-dark hover:bg-cn-yellow/5 flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed py-3 text-sm font-bold transition-all"
      >
        <Plus size={18} />
        {m.form_add_question_button()}
      </button>

      {#if showTypePicker}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="fixed inset-0 z-40" onclick={() => (showTypePicker = false)}></div>
        <div
          class="border-cn-border absolute right-0 bottom-full left-0 z-50 mb-2 rounded-2xl border-2 bg-(--cn-surface) p-3 shadow-xl"
        >
          <p class="text-text-muted mb-2.5 ml-1 text-[0.65rem] font-bold tracking-wider uppercase">
            {m.form_question_type_picker_label()}
          </p>
          <div class="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {#each QUESTION_TYPES as qtype (qtype.value)}
              {@const Icon = qtype.Icon}
              <button
                type="button"
                onclick={() => addItem(qtype.value)}
                class="border-cn-border hover:border-cn-yellow hover:bg-cn-yellow/5 group flex flex-col items-center gap-1.5 rounded-xl border p-2.5 text-center transition-all"
              >
                <Icon
                  size={18}
                  class="text-text-muted group-hover:text-cn-dark transition-colors"
                />
                <span
                  class="text-text-muted group-hover:text-text-main text-[0.65rem] leading-tight font-semibold"
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
    class="border-cn-border/60 dark:bg-cn-ink/85 mt-5 flex flex-col items-center justify-center gap-3 rounded-2xl border bg-(--cn-surface)/85 px-4 py-3.5 text-center shadow-lg backdrop-blur-xl sm:flex-row sm:justify-between sm:px-5 sm:text-left"
  >
    <p class="text-text-muted min-h-[1.25rem] text-sm">
      {#if titleMissing}
        <span class="text-amber-warn font-medium">{m.form_title_required_hint()}</span>
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
      class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
    >
      <Save size={16} />
      {isSubmitting ? m.form_saving_label() : m.form_save_button()}
    </button>
  </div>
</div>
