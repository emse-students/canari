<script lang="ts">
  import { onMount } from 'svelte';
  import {
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
  import { Plus, Trash2, ChevronDown, AlertTriangle, RefreshCw, ShoppingBag } from '@lucide/svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import StripeNetPayoutHint from '$lib/components/payments/StripeNetPayoutHint.svelte';
  import AssociationTagAutocomplete from '$lib/components/shared/AssociationTagAutocomplete.svelte';

  interface Props {
    asso: Association;
    /** True once Stripe Connect can collect payments (otherwise products are created inactive). */
    stripePaymentsReady: boolean;
    /** True while the Stripe account is awaiting verification. */
    stripePending: boolean;
    /** Whether the caller can configure Stripe Connect (tweaks the warning copy). */
    canManageStripeConnect: boolean;
  }

  let { asso, stripePaymentsReady, stripePending, canManageStripeConnect }: Props = $props();

  let products = $state<AssociationProduct[]>([]);
  let productsLoading = $state(false);
  let productsError = $state('');
  let webhookFailures = $state<WebhookDelivery[]>([]);
  let showProductForm = $state(false);
  let savingProduct = $state(false);
  let retryingDelivery = $state<string | null>(null);

  let newProductName = $state('');
  let newProductDescription = $state('');
  let newProductAmountCents = $state<number | ''>('');
  let newProductType = $state<'membership' | 'balance_topup' | 'other'>('other');
  let newProductGrantedTag = $state('');
  let newProductTagExpires = $state('');
  let newProductAllowCustom = $state(false);
  let newProductMinCents = $state<number | ''>('');
  let newProductMaxCents = $state<number | ''>('');
  let newProductWebhookUrl = $state('');
  let newProductWebhookSecret = $state('');
  let newProductAllowRepeat = $state(false);
  let newProductMaxPerUser = $state<number | ''>('');
  let newProductMaxTotal = $state<number | ''>('');
  let expandedProductSettingsId = $state<string | null>(null);
  let savingProductSettings = $state<string | null>(null);

  onMount(loadProducts);

  async function loadProducts() {
    productsLoading = true;
    productsError = '';
    try {
      const [prods, failures] = await Promise.all([
        listAssociationProductsForManage(asso.id),
        listWebhookFailures(asso.id),
      ]);
      products = prods;
      webhookFailures = failures;
    } catch (e) {
      productsError = e instanceof Error ? e.message : 'Erreur';
    } finally {
      productsLoading = false;
    }
  }

  function resetProductForm() {
    newProductName = '';
    newProductDescription = '';
    newProductAmountCents = '';
    newProductType = 'other';
    newProductGrantedTag = '';
    newProductTagExpires = '';
    newProductAllowCustom = false;
    newProductMinCents = '';
    newProductMaxCents = '';
    newProductWebhookUrl = '';
    newProductWebhookSecret = '';
    newProductAllowRepeat = false;
    newProductMaxPerUser = '';
    newProductMaxTotal = '';
    showProductForm = false;
  }

  async function handleCreateProduct() {
    if (!newProductName.trim()) return;
    savingProduct = true;
    productsError = '';
    try {
      await createProduct(asso.id, {
        name: newProductName.trim(),
        description: newProductDescription.trim() || undefined,
        amountCents: newProductAmountCents !== '' ? Number(newProductAmountCents) * 100 : undefined,
        type: newProductType,
        grantedTagName: newProductGrantedTag.trim() || undefined,
        tagExpiresAt: newProductTagExpires.trim() || undefined,
        allowCustomAmount: newProductAllowCustom,
        customAmountMinCents: newProductMinCents !== '' ? Number(newProductMinCents) * 100 : undefined,
        customAmountMaxCents: newProductMaxCents !== '' ? Number(newProductMaxCents) * 100 : undefined,
        webhookUrl: newProductWebhookUrl.trim() || undefined,
        webhookSecret: newProductWebhookSecret.trim() || undefined,
        allowRepeatPurchase: newProductAllowRepeat,
        maxPurchasesPerUser: newProductMaxPerUser !== '' ? Number(newProductMaxPerUser) : undefined,
        maxPurchasesTotal: newProductMaxTotal !== '' ? Number(newProductMaxTotal) : undefined,
      });
      resetProductForm();
      await loadProducts();
    } catch (e) {
      productsError = e instanceof Error ? e.message : 'Erreur';
    } finally {
      savingProduct = false;
    }
  }

  async function handleToggleProduct(product: AssociationProduct) {
    try {
      await updateProduct(asso.id, product.id, { isActive: !product.isActive });
      products = products.map((p) =>
        p.id === product.id ? { ...p, isActive: !product.isActive } : p
      );
    } catch (e) {
      productsError = e instanceof Error ? e.message : 'Erreur';
    }
  }

  function toggleProductSettings(product: AssociationProduct) {
    expandedProductSettingsId = expandedProductSettingsId === product.id ? null : product.id;
  }

  async function handleSaveProductSettings(product: AssociationProduct, form: HTMLFormElement) {
    const fd = new FormData(form);
    savingProductSettings = product.id;
    productsError = '';
    try {
      const allowRepeat = fd.get('allowRepeat') === 'on';
      const maxPerUserRaw = String(fd.get('maxPerUser') ?? '').trim();
      const maxTotalRaw = String(fd.get('maxTotal') ?? '').trim();
      const updated = await updateProduct(asso.id, product.id, {
        allowRepeatPurchase: allowRepeat,
        maxPurchasesPerUser: maxPerUserRaw ? Number(maxPerUserRaw) : null,
        maxPurchasesTotal: maxTotalRaw ? Number(maxTotalRaw) : null,
      });
      products = products.map((p) => (p.id === product.id ? updated : p));
    } catch (e) {
      productsError = e instanceof Error ? e.message : 'Erreur';
    } finally {
      savingProductSettings = null;
    }
  }

  async function handleDeleteProduct(product: AssociationProduct) {
    if (
      !(await showConfirm(`Supprimer le produit " ${product.name} " ? Cette action est irréversible.`, {
        danger: true,
        confirmLabel: 'Supprimer',
      }))
    )
      return;
    try {
      await deleteProduct(asso.id, product.id);
      products = products.filter((p) => p.id !== product.id);
    } catch (e) {
      productsError = e instanceof Error ? e.message : 'Erreur';
    }
  }

  async function handleRetryDelivery(delivery: WebhookDelivery) {
    retryingDelivery = delivery.id;
    try {
      await retryWebhookDelivery(asso.id, delivery.id);
      await loadProducts();
    } catch (e) {
      productsError = e instanceof Error ? e.message : 'Erreur';
    } finally {
      retryingDelivery = null;
    }
  }
</script>

<div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-6 shadow-sm">
  <div class="flex items-center justify-between gap-3 flex-wrap">
    <div>
      <h2 class="text-lg font-bold text-text-main tracking-tight flex items-center gap-2">
        <ShoppingBag size={20} />
        Boutique
      </h2>
      <p class="text-sm text-text-muted mt-1">
        Produits disponibles à l'achat sur la page /shop et la page publique de l'association.
      </p>
    </div>
    <button
      type="button"
      onclick={() => (showProductForm = !showProductForm)}
      class="inline-flex items-center gap-2 rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover transition-colors"
    >
      <Plus size={16} />
      Nouveau produit
    </button>
  </div>

  {#if productsError}
    <div class="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">
      {productsError}
    </div>
  {/if}

  {#if !stripePaymentsReady}
    <div class="rounded-xl border border-amber-200 bg-amber-50 text-amber-800 px-4 py-3 text-sm">
      {#if stripePending}
        Stripe Connect en cours de validation. Les produits seront créés inactifs jusqu'à
        l'activation du compte (généralement sous quelques jours).
      {:else}
        Stripe Connect non configuré. Les produits seront créés inactifs jusqu'à la complétion de
        l'onboarding.
        {#if canManageStripeConnect}
          <span class="ml-1">Voir la section Stripe Connect ci-dessus.</span>
        {:else}
          <span class="ml-1">Demandez à un responsable disposant de l'accès Stripe Connect.</span>
        {/if}
      {/if}
    </div>
  {/if}

  <!-- New product form -->
  {#if showProductForm}
    <form
      class="rounded-xl border border-cn-border bg-cn-bg/40 p-5 space-y-4"
      onsubmit={(e) => {
        e.preventDefault();
        void handleCreateProduct();
      }}
    >
      <h3 class="font-bold text-sm text-text-main">Nouveau produit</h3>

      <div class="grid gap-4 sm:grid-cols-2">
        <div class="space-y-1">
          <label for="new-product-name" class="text-xs font-semibold text-text-muted">Nom *</label>
          <input
            id="new-product-name"
            type="text"
            bind:value={newProductName}
            placeholder="Cotisation BDE 2026-2027"
            required
            class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
          />
        </div>
        <div class="space-y-1">
          <label for="new-product-type" class="text-xs font-semibold text-text-muted">Type *</label>
          <select
            id="new-product-type"
            bind:value={newProductType}
            class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 text-sm"
          >
            <option value="membership">Cotisation (membership)</option>
            <option value="balance_topup">Recharge Cercle</option>
            <option value="other">Autre</option>
          </select>
        </div>
      </div>

      <div class="space-y-1">
        <Textarea
          id="new-product-description"
          bind:value={newProductDescription}
          rows={2}
          placeholder="Description affichée dans la boutique"
          label="Description"
        />
      </div>

      <div class="grid gap-4 sm:grid-cols-2">
        <div class="space-y-1">
          <label for="new-product-amount" class="text-xs font-semibold text-text-muted"
            >Prix fixe (€) - vide = libre uniquement</label
          >
          <input
            id="new-product-amount"
            type="number"
            min="0.01"
            step="0.01"
            bind:value={newProductAmountCents}
            placeholder="10.00"
            class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
          />
        </div>
        <div class="space-y-1 flex flex-col justify-end">
          <label class="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" bind:checked={newProductAllowCustom} class="rounded" />
            Permettre un montant libre
          </label>
        </div>
      </div>

      {#if newProductAllowCustom}
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1">
            <label for="new-product-min" class="text-xs font-semibold text-text-muted">Min (€)</label>
            <input
              id="new-product-min"
              type="number"
              min="0.01"
              step="0.01"
              bind:value={newProductMinCents}
              placeholder="5.00"
              class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
            />
          </div>
          <div class="space-y-1">
            <label for="new-product-max" class="text-xs font-semibold text-text-muted">Max (€)</label>
            <input
              id="new-product-max"
              type="number"
              min="0.01"
              step="0.01"
              bind:value={newProductMaxCents}
              placeholder="100.00"
              class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
            />
          </div>
        </div>
      {/if}

      <StripeNetPayoutHint
        grossEuros={newProductAmountCents}
        minEuros={newProductAllowCustom ? newProductMinCents : ''}
        maxEuros={newProductAllowCustom ? newProductMaxCents : ''}
      />

      {#if newProductType === 'membership'}
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1">
            <label for="new-product-tag" class="text-xs font-semibold text-text-muted"
              >Tag accordé à l'achat</label
            >
            <AssociationTagAutocomplete
              associationId={asso.id}
              value={newProductGrantedTag}
              onValueChange={(v) => (newProductGrantedTag = v)}
              inputId="new-product-tag"
              placeholder="Rechercher ou créer un tag…"
              allowCreate={true}
            />
          </div>
          <div class="space-y-1">
            <label for="new-product-tag-expires" class="text-xs font-semibold text-text-muted"
              >Expiration du tag</label
            >
            <input
              id="new-product-tag-expires"
              type="date"
              bind:value={newProductTagExpires}
              class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
            />
          </div>
        </div>
      {/if}

      {#if newProductType === 'balance_topup'}
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1">
            <label for="new-product-webhook-url" class="text-xs font-semibold text-text-muted"
              >URL webhook Cercle</label
            >
            <input
              id="new-product-webhook-url"
              type="url"
              bind:value={newProductWebhookUrl}
              placeholder="https://cercle.example.com/webhooks/canari"
              class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
            />
          </div>
          <div class="space-y-1">
            <label for="new-product-webhook-secret" class="text-xs font-semibold text-text-muted"
              >Secret HMAC</label
            >
            <input
              id="new-product-webhook-secret"
              type="password"
              bind:value={newProductWebhookSecret}
              placeholder="Secret partagé avec Cercle"
              class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
            />
          </div>
        </div>
      {/if}

      <div class="rounded-xl border border-cn-border/60 bg-cn-bg/30 p-4 space-y-3">
        <p class="text-xs font-bold text-text-main uppercase tracking-wide">Limites d'achat</p>
        <label class="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" bind:checked={newProductAllowRepeat} class="rounded" />
          Autoriser les achats multiples
        </label>
        {#if newProductAllowRepeat}
          <div class="grid gap-4 sm:grid-cols-2">
            <div class="space-y-1">
              <label for="new-product-max-user" class="text-xs font-semibold text-text-muted"
                >Max par utilisateur (vide = illimité)</label
              >
              <input
                id="new-product-max-user"
                type="number"
                min="1"
                step="1"
                bind:value={newProductMaxPerUser}
                placeholder="Illimité"
                class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
              />
            </div>
            <div class="space-y-1">
              <label for="new-product-max-total" class="text-xs font-semibold text-text-muted"
                >Stock global (vide = illimité)</label
              >
              <input
                id="new-product-max-total"
                type="number"
                min="1"
                step="1"
                bind:value={newProductMaxTotal}
                placeholder="Illimité"
                class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
              />
            </div>
          </div>
        {:else}
          <p class="text-xs text-text-muted">
            Sans achats multiples, un utilisateur ne peut acheter qu'une fois (renouvellement possible
            si le tag membership a expiré).
          </p>
        {/if}
      </div>

      <div class="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={savingProduct || !newProductName.trim()}
          class="rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
        >
          {savingProduct ? 'Création…' : 'Créer le produit'}
        </button>
        <button
          type="button"
          onclick={resetProductForm}
          class="text-sm text-text-muted hover:text-text-main">Annuler</button
        >
      </div>
    </form>
  {/if}

  <!-- Product list -->
  {#if productsLoading}
    <div class="flex justify-center py-6">
      <div class="h-6 w-6 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"></div>
    </div>
  {:else if products.length === 0}
    <p class="text-sm text-text-muted text-center py-6">Aucun produit pour le moment.</p>
  {:else}
    <ul class="space-y-3">
      {#each products as product (product.id)}
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
                  {product.isActive ? 'Actif' : 'Inactif'}
                </span>
                <span class="text-xs text-text-muted">{product.type}</span>
              </div>
              <p class="text-xs text-text-muted mt-0.5">
                {product.amountCents != null
                  ? `${(product.amountCents / 100).toFixed(2)} €`
                  : 'Montant libre'}
                {product.grantedTagName ? ` · Tag: ${product.grantedTagName}` : ''}
                {#if product.allowRepeatPurchase}
                  · Achats multiples
                {/if}
                {#if product.maxPurchasesTotal != null}
                  · Stock max {product.maxPurchasesTotal}
                {/if}
              </p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onclick={() => toggleProductSettings(product)}
                class="inline-flex items-center gap-1 text-xs rounded-lg border border-cn-border px-3 py-1.5 font-semibold hover:bg-[var(--cn-surface)] transition-colors"
              >
                Limites
                <ChevronDown
                  size={12}
                  class="transition-transform {expandedProductSettingsId === product.id
                    ? 'rotate-180'
                    : ''}"
                />
              </button>
              <button
                type="button"
                onclick={() => handleToggleProduct(product)}
                class="text-xs rounded-lg border border-cn-border px-3 py-1.5 font-semibold hover:bg-[var(--cn-surface)] transition-colors"
              >
                {product.isActive ? 'Désactiver' : 'Activer'}
              </button>
              <button
                type="button"
                onclick={() => handleDeleteProduct(product)}
                title="Supprimer"
                class="inline-flex items-center justify-center rounded-xl border border-red-200 bg-red-50/80 p-2 text-red-600 hover:bg-red-100 transition-colors"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>

          {#if expandedProductSettingsId === product.id}
            <div class="border-t border-cn-border/60 px-4 py-3 bg-cn-bg/20">
              <form
                class="grid gap-3 sm:grid-cols-2"
                onsubmit={(e) => {
                  e.preventDefault();
                  void handleSaveProductSettings(product, e.currentTarget);
                }}
              >
                <label class="flex items-center gap-2 text-sm cursor-pointer sm:col-span-2">
                  <input
                    type="checkbox"
                    name="allowRepeat"
                    checked={product.allowRepeatPurchase}
                    class="rounded"
                  />
                  Autoriser les achats multiples
                </label>
                <div class="space-y-1">
                  <label for="max-user-{product.id}" class="text-xs font-semibold text-text-muted"
                    >Max par utilisateur</label
                  >
                  <input
                    id="max-user-{product.id}"
                    name="maxPerUser"
                    type="number"
                    min="1"
                    value={product.maxPurchasesPerUser ?? ''}
                    placeholder="Illimité"
                    class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                  />
                </div>
                <div class="space-y-1">
                  <label for="max-total-{product.id}" class="text-xs font-semibold text-text-muted"
                    >Stock global</label
                  >
                  <input
                    id="max-total-{product.id}"
                    name="maxTotal"
                    type="number"
                    min="1"
                    value={product.maxPurchasesTotal ?? ''}
                    placeholder="Illimité"
                    class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                  />
                </div>
                <button
                  type="submit"
                  disabled={savingProductSettings === product.id}
                  class="sm:col-span-2 text-xs rounded-lg bg-cn-yellow px-4 py-2 font-bold text-cn-dark disabled:opacity-50 w-fit"
                >
                  {savingProductSettings === product.id
                    ? 'Enregistrement…'
                    : 'Enregistrer les limites'}
                </button>
              </form>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <!-- Webhook failures -->
  {#if webhookFailures.length > 0}
    <div class="border-t border-cn-border pt-5 space-y-3">
      <h3 class="text-sm font-bold text-text-main flex items-center gap-2 text-amber-700">
        <AlertTriangle size={16} />
        Livraisons Cercle échouées ({webhookFailures.length})
      </h3>
      <ul class="space-y-2">
        {#each webhookFailures as delivery (delivery.id)}
          <li class="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3">
            <div class="min-w-0 flex-1">
              <p class="text-xs font-semibold text-text-main">
                {(delivery.amountCents / 100).toFixed(2)} € - {delivery.paymentIntentId.slice(0, 20)}…
              </p>
              <p class="text-xs text-text-muted">
                Tentatives: {delivery.attemptCount} ·
                {delivery.lastAttemptAt
                  ? new Date(delivery.lastAttemptAt).toLocaleString('fr-FR')
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
              <RefreshCw size={13} class={retryingDelivery === delivery.id ? 'animate-spin' : ''} />
              Réessayer
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>
