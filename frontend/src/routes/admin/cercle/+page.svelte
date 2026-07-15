<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { isGlobalAdmin } from '$lib/stores/user';
  import {
    listAssociations,
    listAssociationProductsForManage,
    createProduct,
    updateProduct,
    deleteProduct,
    listWebhookFailures,
    retryWebhookDelivery,
    type Association,
    type AssociationProduct,
    type WebhookDelivery,
  } from '$lib/associations/api';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { Wallet, Plus, Trash2, ChevronDown, AlertTriangle, RefreshCw } from '@lucide/svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import StripeNetPayoutHint from '$lib/components/payments/StripeNetPayoutHint.svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  let ready = $state(false);

  let associations = $state<Association[]>([]);
  let associationsLoading = $state(true);
  let selectedAssoId = $state('');

  let products = $state<AssociationProduct[]>([]);
  let webhookFailures = $state<WebhookDelivery[]>([]);
  let productsLoading = $state(false);
  let error = $state('');
  let retryingDelivery = $state<string | null>(null);

  let showProductForm = $state(false);
  let savingProduct = $state(false);
  let newName = $state('');
  let newDescription = $state('');
  let newAmountCents = $state<number | ''>('');
  let newAllowCustom = $state(false);
  let newMinCents = $state<number | ''>('');
  let newMaxCents = $state<number | ''>('');
  let newWebhookUrl = $state('');
  let newWebhookSecret = $state('');

  let expandedProductId = $state<string | null>(null);
  let savingProductId = $state<string | null>(null);

  /** Only `balance_topup` (Cercle recharge) products are managed on this page. */
  const cercleProducts = $derived(products.filter((p) => p.type === 'balance_topup'));

  onMount(() => {
    if (!isGlobalAdmin()) {
      console.error('[ADMIN][CERCLE] non-global-admin blocked client-side, redirecting');
      void goto('/admin', { replaceState: true });
      return;
    }
    ready = true;
    void loadAssociations();
  });

  async function loadAssociations() {
    console.log('[ADMIN][CERCLE] loading associations for beneficiary selector');
    associationsLoading = true;
    error = '';
    try {
      associations = (await listAssociations('association')).sort((a, b) =>
        a.name.localeCompare(b.name)
      );
    } catch (e) {
      console.error('[ADMIN][CERCLE] failed to load associations', e);
      error = e instanceof Error ? e.message : m.admin_cercle_load_assoc_error();
    } finally {
      associationsLoading = false;
    }
  }

  async function handleSelectAsso() {
    resetProductForm();
    expandedProductId = null;
    if (!selectedAssoId) {
      products = [];
      webhookFailures = [];
      return;
    }
    await loadProducts();
  }

  async function loadProducts() {
    if (!selectedAssoId) return;
    console.log(
      `[ADMIN][CERCLE] loading products/webhook-failures for association=${selectedAssoId}`
    );
    productsLoading = true;
    error = '';
    try {
      const [prods, failures] = await Promise.all([
        listAssociationProductsForManage(selectedAssoId),
        listWebhookFailures(selectedAssoId),
      ]);
      products = prods;
      webhookFailures = failures;
    } catch (e) {
      console.error('[ADMIN][CERCLE] failed to load products/webhook-failures', e);
      error = e instanceof Error ? e.message : m.admin_cercle_load_error();
    } finally {
      productsLoading = false;
    }
  }

  function resetProductForm() {
    newName = '';
    newDescription = '';
    newAmountCents = '';
    newAllowCustom = false;
    newMinCents = '';
    newMaxCents = '';
    newWebhookUrl = '';
    newWebhookSecret = '';
    showProductForm = false;
  }

  async function handleCreateProduct() {
    if (!selectedAssoId || !newName.trim()) return;
    savingProduct = true;
    error = '';
    try {
      console.log(
        `[ADMIN][CERCLE] creating balance_topup product for association=${selectedAssoId}`
      );
      await createProduct(selectedAssoId, {
        name: newName.trim(),
        description: newDescription.trim() || undefined,
        type: 'balance_topup',
        amountCents: newAmountCents !== '' ? Math.round(Number(newAmountCents) * 100) : undefined,
        allowCustomAmount: newAllowCustom,
        customAmountMinCents:
          newAllowCustom && newMinCents !== '' ? Math.round(Number(newMinCents) * 100) : undefined,
        customAmountMaxCents:
          newAllowCustom && newMaxCents !== '' ? Math.round(Number(newMaxCents) * 100) : undefined,
        webhookUrl: newWebhookUrl.trim() || undefined,
        webhookSecret: newWebhookSecret.trim() || undefined,
      });
      resetProductForm();
      await loadProducts();
    } catch (e) {
      console.error('[ADMIN][CERCLE] failed to create balance_topup product', e);
      error = e instanceof Error ? e.message : m.admin_cercle_generic_error();
    } finally {
      savingProduct = false;
    }
  }

  function toggleEdit(product: AssociationProduct) {
    expandedProductId = expandedProductId === product.id ? null : product.id;
  }

  async function handleToggleActive(product: AssociationProduct) {
    error = '';
    try {
      await updateProduct(selectedAssoId, product.id, { isActive: !product.isActive });
      products = products.map((p) =>
        p.id === product.id ? { ...p, isActive: !product.isActive } : p
      );
    } catch (e) {
      console.error('[ADMIN][CERCLE] failed to toggle product active state', e);
      error = e instanceof Error ? e.message : m.admin_cercle_generic_error();
    }
  }

  async function handleSaveProductEdit(product: AssociationProduct, form: HTMLFormElement) {
    const fd = new FormData(form);
    savingProductId = product.id;
    error = '';
    try {
      const name = String(fd.get('name') ?? '').trim();
      const description = String(fd.get('description') ?? '').trim();
      const amountRaw = String(fd.get('amountEuros') ?? '').trim();
      const allowCustom = fd.get('allowCustomAmount') === 'on';
      const minRaw = String(fd.get('minEuros') ?? '').trim();
      const maxRaw = String(fd.get('maxEuros') ?? '').trim();
      const webhookUrl = String(fd.get('webhookUrl') ?? '').trim();
      const webhookSecret = String(fd.get('webhookSecret') ?? '').trim();
      console.log(`[ADMIN][CERCLE] updating balance_topup product=${product.id}`);
      const updated = await updateProduct(selectedAssoId, product.id, {
        name: name || undefined,
        description: description || undefined,
        amountCents: amountRaw ? Math.round(Number(amountRaw) * 100) : null,
        allowCustomAmount: allowCustom,
        customAmountMinCents: allowCustom && minRaw ? Math.round(Number(minRaw) * 100) : null,
        customAmountMaxCents: allowCustom && maxRaw ? Math.round(Number(maxRaw) * 100) : null,
        // webhookUrl/webhookSecret are write-only (never returned by the API) - only
        // sent when the admin actually typed a new value, so a blank field never
        // erases the existing configuration.
        ...(webhookUrl ? { webhookUrl } : {}),
        ...(webhookSecret ? { webhookSecret } : {}),
      });
      products = products.map((p) => (p.id === product.id ? updated : p));
      expandedProductId = null;
    } catch (e) {
      console.error('[ADMIN][CERCLE] failed to update balance_topup product', e);
      error = e instanceof Error ? e.message : m.admin_cercle_generic_error();
    } finally {
      savingProductId = null;
    }
  }

  async function handleDeleteProduct(product: AssociationProduct) {
    if (
      !(await showConfirm(m.admin_cercle_delete_confirm({ name: product.name }), {
        danger: true,
        confirmLabel: m.common_delete_button(),
      }))
    )
      return;
    try {
      await deleteProduct(selectedAssoId, product.id);
      products = products.filter((p) => p.id !== product.id);
    } catch (e) {
      console.error('[ADMIN][CERCLE] failed to delete balance_topup product', e);
      error = e instanceof Error ? e.message : m.admin_cercle_generic_error();
    }
  }

  async function handleRetryDelivery(delivery: WebhookDelivery) {
    retryingDelivery = delivery.id;
    error = '';
    try {
      await retryWebhookDelivery(selectedAssoId, delivery.id);
      await loadProducts();
    } catch (e) {
      console.error('[ADMIN][CERCLE] failed to retry webhook delivery', e);
      error = e instanceof Error ? e.message : m.admin_cercle_generic_error();
    } finally {
      retryingDelivery = null;
    }
  }
</script>

{#if ready}
  <div class="space-y-6">
    <header class="flex items-start gap-3">
      <span
        class="flex h-10 w-10 items-center justify-center rounded-xl bg-cn-yellow/15 text-cn-dark"
      >
        <Wallet size={20} />
      </span>
      <div>
        <h2 class="text-lg font-extrabold text-text-main">{m.admin_cercle_title()}</h2>
        <p class="text-sm text-text-muted mt-0.5">{m.admin_cercle_subtitle()}</p>
      </div>
    </header>

    {#if error}
      <div class="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">
        {error}
      </div>
    {/if}

    <div class="space-y-1.5">
      <label for="cercle-asso-select" class="text-sm font-bold text-text-main">
        {m.admin_cercle_asso_label()}
      </label>
      {#if associationsLoading}
        <div class="flex items-center gap-2 py-2">
          <div
            class="h-5 w-5 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
          ></div>
        </div>
      {:else}
        <select
          id="cercle-asso-select"
          bind:value={selectedAssoId}
          onchange={() => void handleSelectAsso()}
          class="w-full max-w-md rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-cn-yellow/40"
        >
          <option value="">{m.admin_cercle_asso_placeholder()}</option>
          {#each associations as assoc (assoc.id)}
            <option value={assoc.id}>{assoc.name}</option>
          {/each}
        </select>
      {/if}
    </div>

    {#if !selectedAssoId}
      <p class="text-sm text-text-muted">{m.admin_cercle_select_asso_hint()}</p>
    {:else}
      <div
        class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-6 shadow-sm"
      >
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <h3 class="text-base font-bold text-text-main">
            {m.admin_cercle_form_title()}
          </h3>
          <button
            type="button"
            onclick={() => (showProductForm = !showProductForm)}
            class="inline-flex items-center gap-2 rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover transition-colors"
          >
            <Plus size={16} />
            {m.admin_cercle_new_product_button()}
          </button>
        </div>

        {#if showProductForm}
          <form
            class="rounded-xl border border-cn-border bg-cn-bg/40 p-5 space-y-4"
            onsubmit={(e) => {
              e.preventDefault();
              void handleCreateProduct();
            }}
          >
            <div class="space-y-1">
              <label for="new-cercle-name" class="text-xs font-semibold text-text-muted"
                >{m.admin_cercle_name_label()}</label
              >
              <input
                id="new-cercle-name"
                type="text"
                bind:value={newName}
                required
                class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
              />
            </div>

            <Textarea
              id="new-cercle-description"
              bind:value={newDescription}
              rows={2}
              placeholder={m.admin_cercle_description_placeholder()}
              label={m.admin_cercle_description_label()}
            />

            <div class="grid gap-4 sm:grid-cols-2">
              <div class="space-y-1">
                <label for="new-cercle-amount" class="text-xs font-semibold text-text-muted"
                  >{m.admin_cercle_fixed_price_label()}</label
                >
                <input
                  id="new-cercle-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  bind:value={newAmountCents}
                  class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                />
              </div>
              <div class="space-y-1 flex flex-col justify-end">
                <label class="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" bind:checked={newAllowCustom} class="rounded" />
                  {m.admin_cercle_allow_custom_label()}
                </label>
              </div>
            </div>

            {#if newAllowCustom}
              <div class="grid gap-4 sm:grid-cols-2">
                <div class="space-y-1">
                  <label for="new-cercle-min" class="text-xs font-semibold text-text-muted"
                    >{m.admin_cercle_min_label()}</label
                  >
                  <input
                    id="new-cercle-min"
                    type="number"
                    min="0.01"
                    step="0.01"
                    bind:value={newMinCents}
                    class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                  />
                </div>
                <div class="space-y-1">
                  <label for="new-cercle-max" class="text-xs font-semibold text-text-muted"
                    >{m.admin_cercle_max_label()}</label
                  >
                  <input
                    id="new-cercle-max"
                    type="number"
                    min="0.01"
                    step="0.01"
                    bind:value={newMaxCents}
                    class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                  />
                </div>
              </div>
            {/if}

            <StripeNetPayoutHint
              grossEuros={newAmountCents}
              minEuros={newAllowCustom ? newMinCents : ''}
              maxEuros={newAllowCustom ? newMaxCents : ''}
            />

            <div class="rounded-xl border border-cn-border/60 bg-cn-bg/30 p-4 space-y-3">
              <div class="space-y-1">
                <label for="new-cercle-webhook-url" class="text-xs font-semibold text-text-muted"
                  >{m.admin_cercle_webhook_url_label()}</label
                >
                <input
                  id="new-cercle-webhook-url"
                  type="url"
                  bind:value={newWebhookUrl}
                  placeholder={m.admin_cercle_webhook_url_placeholder()}
                  class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                />
              </div>
              <div class="space-y-1">
                <label for="new-cercle-webhook-secret" class="text-xs font-semibold text-text-muted"
                  >{m.admin_cercle_webhook_secret_label()}</label
                >
                <input
                  id="new-cercle-webhook-secret"
                  type="password"
                  autocomplete="off"
                  bind:value={newWebhookSecret}
                  placeholder={m.admin_cercle_webhook_secret_placeholder()}
                  class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                />
                <p class="text-xs text-text-muted">{m.admin_cercle_webhook_secret_hint()}</p>
              </div>
            </div>

            <div class="flex items-center gap-3 pt-2">
              <button
                type="submit"
                disabled={savingProduct || !newName.trim()}
                class="rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
              >
                {savingProduct ? m.admin_cercle_creating() : m.admin_cercle_create_button()}
              </button>
              <button
                type="button"
                onclick={resetProductForm}
                class="text-sm text-text-muted hover:text-text-main"
                >{m.common_cancel_button()}</button
              >
            </div>
          </form>
        {/if}

        {#if productsLoading}
          <div class="flex justify-center py-6">
            <div
              class="h-6 w-6 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
            ></div>
          </div>
        {:else if cercleProducts.length === 0}
          <p class="text-sm text-text-muted text-center py-6">{m.admin_cercle_no_products()}</p>
        {:else}
          <ul class="space-y-3">
            {#each cercleProducts as product (product.id)}
              <li class="rounded-xl border border-cn-border/70 bg-cn-bg/40 overflow-hidden">
                <div class="flex items-center gap-3 px-4 py-3">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                      <p class="font-semibold text-sm text-text-main">{product.name}</p>
                      <span
                        class="rounded-full px-2 py-0.5 text-xs font-semibold {product.isActive
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-cn-surface-alt text-text-muted'}"
                      >
                        {product.isActive
                          ? m.admin_cercle_product_active()
                          : m.admin_cercle_product_inactive()}
                      </span>
                    </div>
                    <p class="text-xs text-text-muted mt-0.5">
                      {product.amountCents != null
                        ? `${(product.amountCents / 100).toFixed(2)} €`
                        : m.admin_cercle_product_custom_only()}
                    </p>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onclick={() => toggleEdit(product)}
                      class="inline-flex items-center gap-1 text-xs rounded-lg border border-cn-border px-3 py-1.5 font-semibold hover:bg-[var(--cn-surface)] transition-colors"
                    >
                      {m.admin_cercle_edit_button()}
                      <ChevronDown
                        size={12}
                        class="transition-transform {expandedProductId === product.id
                          ? 'rotate-180'
                          : ''}"
                      />
                    </button>
                    <button
                      type="button"
                      onclick={() => handleToggleActive(product)}
                      class="text-xs rounded-lg border border-cn-border px-3 py-1.5 font-semibold hover:bg-[var(--cn-surface)] transition-colors"
                    >
                      {product.isActive
                        ? m.admin_cercle_deactivate_button()
                        : m.admin_cercle_activate_button()}
                    </button>
                    <button
                      type="button"
                      onclick={() => handleDeleteProduct(product)}
                      title={m.common_delete_button()}
                      class="inline-flex items-center justify-center rounded-xl border border-red-200 bg-red-50/80 p-2 text-red-600 hover:bg-red-100 transition-colors"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {#if expandedProductId === product.id}
                  <div class="border-t border-cn-border/60 px-4 py-4 bg-cn-bg/20">
                    <form
                      class="grid gap-3 sm:grid-cols-2"
                      onsubmit={(e) => {
                        e.preventDefault();
                        void handleSaveProductEdit(product, e.currentTarget);
                      }}
                    >
                      <div class="space-y-1 sm:col-span-2">
                        <label
                          for="edit-name-{product.id}"
                          class="text-xs font-semibold text-text-muted"
                          >{m.admin_cercle_name_label()}</label
                        >
                        <input
                          id="edit-name-{product.id}"
                          name="name"
                          type="text"
                          value={product.name}
                          class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                        />
                      </div>
                      <div class="space-y-1 sm:col-span-2">
                        <label
                          for="edit-description-{product.id}"
                          class="text-xs font-semibold text-text-muted"
                          >{m.admin_cercle_description_label()}</label
                        >
                        <textarea
                          id="edit-description-{product.id}"
                          name="description"
                          rows="2"
                          class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                          >{product.description ?? ''}</textarea
                        >
                      </div>
                      <div class="space-y-1">
                        <label
                          for="edit-amount-{product.id}"
                          class="text-xs font-semibold text-text-muted"
                          >{m.admin_cercle_fixed_price_label()}</label
                        >
                        <input
                          id="edit-amount-{product.id}"
                          name="amountEuros"
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={product.amountCents != null ? product.amountCents / 100 : ''}
                          class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                        />
                      </div>
                      <label class="flex items-center gap-2 text-sm cursor-pointer self-end">
                        <input
                          type="checkbox"
                          name="allowCustomAmount"
                          checked={product.allowCustomAmount}
                          class="rounded"
                        />
                        {m.admin_cercle_allow_custom_label()}
                      </label>
                      <div class="space-y-1">
                        <label
                          for="edit-min-{product.id}"
                          class="text-xs font-semibold text-text-muted"
                          >{m.admin_cercle_min_label()}</label
                        >
                        <input
                          id="edit-min-{product.id}"
                          name="minEuros"
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={product.customAmountMinCents != null
                            ? product.customAmountMinCents / 100
                            : ''}
                          class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                        />
                      </div>
                      <div class="space-y-1">
                        <label
                          for="edit-max-{product.id}"
                          class="text-xs font-semibold text-text-muted"
                          >{m.admin_cercle_max_label()}</label
                        >
                        <input
                          id="edit-max-{product.id}"
                          name="maxEuros"
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={product.customAmountMaxCents != null
                            ? product.customAmountMaxCents / 100
                            : ''}
                          class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                        />
                      </div>
                      <div class="space-y-1 sm:col-span-2">
                        <label
                          for="edit-webhook-url-{product.id}"
                          class="text-xs font-semibold text-text-muted"
                          >{m.admin_cercle_webhook_url_label()}</label
                        >
                        <input
                          id="edit-webhook-url-{product.id}"
                          name="webhookUrl"
                          type="url"
                          placeholder={m.admin_cercle_webhook_edit_hint()}
                          class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                        />
                      </div>
                      <div class="space-y-1 sm:col-span-2">
                        <label
                          for="edit-webhook-secret-{product.id}"
                          class="text-xs font-semibold text-text-muted"
                          >{m.admin_cercle_webhook_secret_label()}</label
                        >
                        <input
                          id="edit-webhook-secret-{product.id}"
                          name="webhookSecret"
                          type="password"
                          autocomplete="off"
                          placeholder={m.admin_cercle_webhook_edit_hint()}
                          class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                        />
                        <p class="text-xs text-text-muted">
                          {m.admin_cercle_webhook_secret_hint()}
                        </p>
                      </div>
                      <button
                        type="submit"
                        disabled={savingProductId === product.id}
                        class="sm:col-span-2 text-xs rounded-lg bg-cn-yellow px-4 py-2 font-bold text-cn-dark disabled:opacity-50 w-fit"
                      >
                        {savingProductId === product.id
                          ? m.admin_cercle_saving()
                          : m.common_save_button()}
                      </button>
                    </form>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}

        {#if webhookFailures.length > 0}
          <div class="border-t border-cn-border pt-5 space-y-3">
            <h3 class="text-sm font-bold text-text-main flex items-center gap-2 text-amber-700">
              <AlertTriangle size={16} />
              {m.admin_cercle_webhook_failures_title({ count: webhookFailures.length })}
            </h3>
            <ul class="space-y-2">
              {#each webhookFailures as delivery (delivery.id)}
                <li
                  class="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3"
                >
                  <div class="min-w-0 flex-1">
                    <p class="text-xs font-semibold text-text-main">
                      {(delivery.amountCents / 100).toFixed(2)} € - {delivery.paymentIntentId.slice(
                        0,
                        20
                      )}…
                    </p>
                    <p class="text-xs text-text-muted">
                      {m.admin_cercle_webhook_attempts({ count: delivery.attemptCount })} ·
                      {delivery.lastAttemptAt
                        ? new Date(delivery.lastAttemptAt).toLocaleString(
                            getLocale() === 'en' ? 'en-US' : 'fr-FR'
                          )
                        : '-'}
                    </p>
                    {#if delivery.lastError}
                      <p class="text-xs text-red-600 truncate">{delivery.lastError}</p>
                    {/if}
                  </div>
                  <button
                    type="button"
                    disabled={retryingDelivery === delivery.id}
                    onclick={() => handleRetryDelivery(delivery)}
                    class="inline-flex items-center gap-1.5 rounded-xl border border-cn-border px-3 py-1.5 text-xs font-semibold hover:bg-[var(--cn-surface)] disabled:opacity-50"
                  >
                    <RefreshCw
                      size={13}
                      class={retryingDelivery === delivery.id ? 'animate-spin' : ''}
                    />
                    {m.common_retry_button()}
                  </button>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}
