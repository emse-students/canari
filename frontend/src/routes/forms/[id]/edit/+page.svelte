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
    type CreateFormPayload,
    type Form,
  } from '$lib/forms/api';
  import {
    canAssociationReceiveFormPayments,
    listAssociations,
    type Association,
  } from '$lib/associations/api';
  import { fetchUserProfile } from '$lib/stores/user';
  import FormBuilder from '$lib/components/forms/FormBuilder.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import StripeNetPayoutHint from '$lib/components/payments/StripeNetPayoutHint.svelte';
  import AssociationTagAutocomplete from '$lib/components/shared/AssociationTagAutocomplete.svelte';
  import UserAutocomplete from '$lib/components/shared/UserAutocomplete.svelte';
  import {
    ArrowLeft,
    Save,
    Plus,
    FileText,
    CreditCard,
    ListChecks,
    ImagePlus,
    X,
    Users,
    Trash2,
  } from '@lucide/svelte';
  import { QUESTION_TYPES } from '$lib/forms/questionTypes';
  import { m } from '$lib/paraglide/messages';

  const formId = $derived(page.params.id as string);

  let form = $state<Form | null>(null);
  let loadError = $state('');

  // General settings
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

  // Image
  let imageUrl = $state<string | null>(null);
  let uploadingImage = $state(false);
  let imageError = $state('');

  // Co-owners
  let coOwners = $state<{ id: string; displayName: string }[]>([]);
  let coOwnerInput = $state('');
  let addingCoOwner = $state(false);
  let coOwnerError = $state('');

  // Associations with Stripe Connect active
  let associations = $state<Association[]>([]);

  let items = $state<any[]>([]);
  let isSubmitting = $state(false);
  let error = $state('');

  // Drag-and-drop reordering
  let dragIndex = $state(-1);
  let dropIndex = $state(-1);

  // Type picker
  let showTypePicker = $state(false);

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
      const [f, all] = await Promise.all([getForm(id), listAssociations('association')]);
      form = f;
      const eligible = all.filter((a) => canAssociationReceiveFormPayments(a));
      if (f.associationId && !eligible.some((a) => a.id === f.associationId)) {
        const current = all.find((a) => a.id === f.associationId);
        if (current) eligible.push(current);
      }
      associations = eligible;

      title = f.title;
      description = f.description ?? '';
      requiresPayment = f.requiresPayment ?? false;
      basePrice = requiresPayment ? (f.basePrice ?? 0) / 100 : 0;
      basePriceMember = requiresPayment && f.basePriceMember != null ? f.basePriceMember / 100 : '';
      pricingTagName = f.pricingTagName ?? '';
      maxSubmissions = f.maxSubmissions;
      opensAt = isoToDatetimeLocal(f.opensAt);
      associationId = f.associationId ?? '';
      allowCashPayment = f.allowCashPayment ?? false;
      allowMultipleSubmissions = f.allowMultipleSubmissions ?? false;
      cashPaymentExpiryDays = f.cashPaymentExpiryDays ?? undefined;
      imageUrl = f.imageUrl ?? null;
      const coOwnerIds = f.coOwners ?? [];
      const profiles = await Promise.allSettled(coOwnerIds.map((id) => fetchUserProfile(id)));
      coOwners = coOwnerIds.map((id, i) => {
        const p = profiles[i].status === 'fulfilled' ? profiles[i].value : null;
        const name =
          (p?.displayName ?? `${p?.firstName ?? ''} ${p?.lastName ?? ''}`.trim()) ||
          id.slice(0, 8) + '…';
        return { id, displayName: name };
      });
      items = (f.items ?? []).map((item: any) => ({
        ...item,
        options:
          item.options?.map((opt: any) => ({
            ...opt,
            priceModifier: requiresPayment ? (opt.priceModifier ?? 0) / 100 : 0,
            priceModifierMember:
              requiresPayment && opt.priceModifierMember != null
                ? opt.priceModifierMember / 100
                : undefined,
          })) || [],
        rows: item.rows || [],
      }));
    } catch (e: any) {
      loadError = e.message || m.form_edit_load_error();
    }
  });

  let titleMissing = $derived(!title.trim());
  const showMemberPricing = $derived(requiresPayment && !!pricingTagName.trim());

  async function handleSave() {
    if (titleMissing) {
      error = m.form_error_title_required_short();
      return;
    }
    if (requiresPayment && !associationId) {
      error = m.form_error_association_required_short();
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
          : { pricingTagName: null }),
        ...(requiresPayment && basePriceMember !== ''
          ? { basePriceMember: Math.round(Number(basePriceMember) * 100) }
          : { basePriceMember: null }),
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

<div class="mx-auto max-w-3xl px-3 py-5 sm:px-6">
  <!-- Header -->
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
      class="bg-red-err/10 border-red-err/30 text-red-err mb-6 rounded-2xl border-2 px-4 py-3 text-sm font-medium"
    >
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
        {error}
      </div>
    {/if}

    <!-- Section: General Settings -->
    <section
      class="border-cn-border mb-4 rounded-2xl border-2 bg-(--cn-surface) p-4 sm:mb-5 sm:p-6"
    >
      <div class="mb-4 flex items-center gap-2.5 sm:mb-5">
        <div class="bg-cn-yellow/15 text-cn-dark rounded-xl p-2"><FileText size={20} /></div>
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
          <p class="text-text-main mb-1 ml-1 block text-sm font-bold">
            {m.form_description_label()}
          </p>
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
            <span class="text-text-main text-sm font-semibold">{m.form_allow_multiple_label()}</span
            >
            <p class="text-text-muted text-xs">{m.form_allow_multiple_hint()}</p>
          </div>
        </label>

        <div>
          <label for="form-opens-at" class="text-text-main mb-2 ml-1 block text-sm font-bold"
            >{m.form_opens_at_label()}</label
          >
          <input
            id="form-opens-at"
            type="datetime-local"
            bind:value={opensAt}
            class="border-cn-border text-text-main focus:border-cn-yellow w-full rounded-2xl border-2 bg-(--cn-surface) px-4 py-3 text-base transition-all outline-none focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)]"
          />
          <p class="text-text-muted mt-1.5 ml-1 text-xs">{m.form_opens_at_hint_short()}</p>
        </div>
      </div>
    </section>

    <!-- Section: Banner Image -->
    <section
      class="border-cn-border mb-4 rounded-2xl border-2 bg-(--cn-surface) p-4 sm:mb-5 sm:p-6"
    >
      <div class="mb-4 flex items-center gap-2.5">
        <div class="bg-cn-yellow/15 text-cn-dark rounded-xl p-2"><ImagePlus size={20} /></div>
        <h2 class="text-text-main text-lg font-bold">{m.form_image_section()}</h2>
      </div>
      {#if imageError}
        <p class="text-red-err mb-3 text-sm">{imageError}</p>
      {/if}
      {#if imageUrl}
        <div class="border-cn-border relative mb-2 overflow-hidden rounded-xl border">
          <img src={imageUrl} alt="Affiche" class="max-h-56 w-full object-cover" loading="lazy" />
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
    </section>

    <!-- Section: Payment -->
    <section
      class="border-cn-border mb-4 rounded-2xl border-2 bg-(--cn-surface) p-4 sm:mb-5 sm:p-6"
    >
      <div class="mb-4 flex items-center gap-2.5 sm:mb-5">
        <div class="bg-cn-yellow/15 text-cn-dark rounded-xl p-2"><CreditCard size={20} /></div>
        <h2 class="text-text-main text-lg font-bold">{m.form_section_payment()}</h2>
      </div>
      <label class="flex cursor-pointer items-center gap-3 select-none">
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
        <div class="mt-4">
          <label for="association-select" class="text-text-main mb-2 ml-1 block text-sm font-bold"
            >{m.form_association_label()}</label
          >
          {#if associations.length > 0}
            <select
              id="association-select"
              bind:value={associationId}
              class="border-cn-border text-text-main focus:border-cn-yellow w-full rounded-2xl border-2 bg-(--cn-surface) px-4 py-3 text-base transition-all outline-none"
            >
              <option value="">{m.form_association_select_placeholder()}</option>
              {#each associations as a (a.id)}
                <option value={a.id}>{a.name}</option>
              {/each}
            </select>
          {:else}
            <p class="text-text-muted bg-cn-border/20 rounded-2xl px-4 py-3 text-sm">
              {m.form_no_stripe_connected()}
            </p>
          {/if}
        </div>
        <div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div class="space-y-1">
            <label
              for="pricing-tag-autocomplete-edit"
              class="text-text-main ml-1 block text-sm font-bold">{m.form_member_tag_label()}</label
            >
            <AssociationTagAutocomplete
              {associationId}
              value={pricingTagName}
              onValueChange={(v) => (pricingTagName = v)}
              inputId="pricing-tag-autocomplete-edit"
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
          {m.form_member_tag_desc()}
        </p>
        <div class="mt-4">
          <StripeNetPayoutHint
            grossEuros={basePrice}
            grossEurosMember={showMemberPricing ? basePriceMember : ''}
            showOptionSupplementNote={true}
          />
        </div>
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
            <Input
              label={m.form_cash_expiry_label_edit()}
              type="number"
              bind:value={cashPaymentExpiryDays}
              min="1"
              placeholder={m.form_cash_expiry_placeholder_short()}
            />
          {/if}
        </div>
      {/if}
    </section>

    <!-- TODO: affichage de formulaires differents selon le tag 'cotisant:bde' de l'utilisateur - a implementer ulterieurement -->

    <!-- Section: Co-owners -->
    <section
      class="border-cn-border mb-4 rounded-2xl border-2 bg-(--cn-surface) p-4 sm:mb-5 sm:p-6"
    >
      <div class="mb-4 flex items-center gap-2.5">
        <div class="bg-cn-yellow/15 text-cn-dark rounded-xl p-2"><Users size={20} /></div>
        <h2 class="text-text-main text-lg font-bold">{m.form_coowners_section()}</h2>
      </div>
      <p class="text-text-muted mb-4 text-sm">
        {m.form_coowners_desc()}
      </p>
      {#if coOwnerError}
        <p class="text-red-err mb-3 text-sm">{coOwnerError}</p>
      {/if}
      {#if coOwners.length > 0}
        <ul class="mb-4 space-y-2">
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
    </section>

    <!-- Section: Questions -->
    <section class="border-cn-border rounded-2xl border-2 bg-(--cn-surface) p-3 sm:p-6">
      <div class="mb-4 flex items-center gap-2.5 px-1 sm:mb-5 sm:px-0">
        <div class="bg-cn-yellow/15 text-cn-dark rounded-xl p-2"><ListChecks size={20} /></div>
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
              imageUploadFn={async (file) => {
                const r = await uploadFormItemImage(formId, file);
                return r.imageUrl;
              }}
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
            <p
              class="text-text-muted mb-2.5 ml-1 text-[0.65rem] font-bold tracking-wider uppercase"
            >
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
  {/if}

  {#if form}
    <!-- Save bar -->
    <div
      class="border-cn-border/60 dark:bg-cn-ink/85 mt-5 flex flex-col items-center justify-center gap-3 rounded-2xl border bg-(--cn-surface)/85 px-4 py-3.5 shadow-lg backdrop-blur-xl sm:flex-row sm:justify-between sm:px-5"
    >
      <p class="text-text-muted min-h-[1.25rem] text-sm">
        {#if titleMissing}
          <span class="text-amber-warn font-medium">{m.form_title_required_hint()}</span>
        {:else}
          {items.length === 1
            ? m.form_questions_count_one()
            : m.form_questions_count({ count: items.length })}
        {/if}
      </p>
      <button
        onclick={handleSave}
        disabled={isSubmitting || titleMissing}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
      >
        <Save size={16} />
        {isSubmitting ? m.form_saving_label() : m.form_save_changes_button()}
      </button>
    </div>
  {/if}
</div>
