<script lang="ts">
  import { onMount } from 'svelte';
  import {
    listAssociationProductsForManage,
    createProduct,
    updateProduct,
    deleteProduct,
    uploadProductIcon,
    deleteProductIcon,
    type Association,
    type AssociationProduct,
  } from '$lib/associations/api';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { Plus, Trash2, ChevronDown, ShoppingBag } from '@lucide/svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import StripeNetPayoutHint from '$lib/components/payments/StripeNetPayoutHint.svelte';
  import CardTile from '$lib/components/shared/CardTile.svelte';
  import CardIconEditor from '$lib/components/shared/CardIconEditor.svelte';
  import PriceGridEditor from '$lib/components/pricing/PriceGridEditor.svelte';
  import {
    emptyMatrix,
    matrixOf,
    matrixPayload,
    matrixProblem,
    type PriceMatrix,
  } from '$lib/pricing/priceMatrix';
  import { gridProblemMessage } from '$lib/pricing/gridProblem';
  import { fetchFormations, type FormationOption } from '$lib/pricing/criteriaOptions';
  import { fetchCotisationOptions, type MembershipTier } from '$lib/associations/api';
  import { productFallbackIcon } from '$lib/utils/cardIcons';
  import { generateAvatarColor } from '$lib/utils/avatar';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    asso: Association;
    /** True once Stripe Connect can collect payments (otherwise products are created inactive). */
    onlinePaymentsReady: boolean;
    /** True while the Stripe account is awaiting verification. */
    payoutAccountPending: boolean;
    /** Whether the caller can configure Stripe Connect (tweaks the warning copy). */
    canManageStripeConnect: boolean;
  }

  let { asso, onlinePaymentsReady, payoutAccountPending, canManageStripeConnect }: Props = $props();

  /** Card accent color - the association's own, or a deterministic fallback when unset. */
  const cardAccentColor = $derived(asso.color ?? generateAvatarColor(asso.name));

  let products = $state<AssociationProduct[]>([]);
  let productsLoading = $state(false);
  let productsError = $state('');
  let showProductForm = $state(false);
  let savingProduct = $state(false);

  let newProductName = $state('');
  let newProductDescription = $state('');
  let newProductAmountCents = $state<number | ''>('');
  let newProductAllowCustom = $state(false);
  let newProductMinCents = $state<number | ''>('');
  let newProductMaxCents = $state<number | ''>('');
  let newProductMembersOnly = $state(false);
  let newProductAmountCentsMember = $state<number | ''>('');
  let newProductAllowRepeat = $state(false);
  let newProductMaxPerUser = $state<number | ''>('');
  let newProductMaxTotal = $state<number | ''>('');
  let expandedProductSettingsId = $state<string | null>(null);
  let savingProductSettings = $state<string | null>(null);

  /**
   * The expanded product's pricing grid, in EUROS, or null when one price serves everybody.
   *
   * The same grid a cotisation tier and a paid form use - one document, one validator, one
   * server-side resolution. One slot rather than one per product because only one settings panel is
   * ever open, so a second copy would be a second thing to keep in step with the row being edited.
   */
  let editingMatrix = $state<PriceMatrix | null>(null);
  let formations = $state<FormationOption[]>([]);
  let cotisationTiers = $state<MembershipTier[]>([]);
  let criteriaLoaded = false;

  /** Blocks the save while the grid cannot be stored - the same codes the editor shows. */
  let gridProblem = $derived(matrixProblem(editingMatrix));

  /** This tab manages boutique products only (`type === 'other'`); membership is managed in the
   * Cotisations tab and balance_topup moves to platform admin. */
  let otherProducts = $derived(products.filter((p) => p.type === 'other'));

  onMount(loadProducts);

  async function loadProducts() {
    productsLoading = true;
    productsError = '';
    try {
      products = await listAssociationProductsForManage(asso.id);
    } catch (e) {
      productsError = e instanceof Error ? e.message : 'Error';
    } finally {
      productsLoading = false;
    }
  }

  function resetProductForm() {
    newProductName = '';
    newProductDescription = '';
    newProductAmountCents = '';
    newProductAllowCustom = false;
    newProductMinCents = '';
    newProductMaxCents = '';
    newProductMembersOnly = false;
    newProductAmountCentsMember = '';
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
        type: 'other',
        membersOnly: newProductMembersOnly,
        amountCentsMember:
          newProductAmountCentsMember !== ''
            ? Number(newProductAmountCentsMember) * 100
            : undefined,
        allowCustomAmount: newProductAllowCustom,
        customAmountMinCents:
          newProductMinCents !== '' ? Number(newProductMinCents) * 100 : undefined,
        customAmountMaxCents:
          newProductMaxCents !== '' ? Number(newProductMaxCents) * 100 : undefined,
        allowRepeatPurchase: newProductAllowRepeat,
        maxPurchasesPerUser: newProductMaxPerUser !== '' ? Number(newProductMaxPerUser) : undefined,
        maxPurchasesTotal: newProductMaxTotal !== '' ? Number(newProductMaxTotal) : undefined,
      });
      resetProductForm();
      await loadProducts();
    } catch (e) {
      productsError = e instanceof Error ? e.message : 'Error';
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
      productsError = e instanceof Error ? e.message : 'Error';
    }
  }

  /**
   * Opens or closes a product's settings, loading its grid in euros on the way in.
   *
   * The stored grid is in cents and the editor works in euros - `matrixOf` is the single
   * conversion, so no screen ever does the division itself.
   */
  function toggleProductSettings(product: AssociationProduct) {
    if (expandedProductSettingsId === product.id) {
      expandedProductSettingsId = null;
      editingMatrix = null;
      return;
    }
    expandedProductSettingsId = product.id;
    editingMatrix = matrixOf(product.priceMatrix);
    void loadCriteriaOptions();
  }

  /**
   * What the criterion pickers offer: the formations in use, and this association's forfaits.
   *
   * Fetched once, on the first grid opened. The formation vocabulary is OPEN - a new value arrives
   * from the identity provider with no deploy - so the picker offers what EXISTS rather than an
   * enum this repository would have to chase.
   */
  async function loadCriteriaOptions() {
    if (criteriaLoaded) return;
    criteriaLoaded = true;
    try {
      const [loadedFormations, cotisation] = await Promise.all([
        fetchFormations(),
        fetchCotisationOptions(asso.id),
      ]);
      formations = loadedFormations;
      cotisationTiers = cotisation.tiers;
    } catch (e) {
      // Not fatal: the promo criterion needs nothing fetched and still prices correctly.
      criteriaLoaded = false;
      console.error('[Boutique] Failed to load pricing criteria options:', e);
    }
  }

  /**
   * Switches a product between one price and a grid.
   *
   * Turning it on seeds the grid from the price the product ALREADY has, so flipping the switch
   * changes nothing anybody pays until a cell is edited. Turning it off drops the grid outright: a
   * kept-but-hidden grid is state nobody can see and the next manager would be surprised by.
   */
  function toggleProductGrid(product: AssociationProduct, on: boolean) {
    editingMatrix = on ? emptyMatrix((product.amountCents ?? 0) / 100) : null;
  }

  async function handleSaveProductSettings(product: AssociationProduct, form: HTMLFormElement) {
    const fd = new FormData(form);
    savingProductSettings = product.id;
    productsError = '';
    try {
      const allowRepeat = fd.get('allowRepeat') === 'on';
      const maxPerUserRaw = String(fd.get('maxPerUser') ?? '').trim();
      const maxTotalRaw = String(fd.get('maxTotal') ?? '').trim();
      const membersOnly = fd.get('membersOnly') === 'on';
      const memberPriceRaw = String(fd.get('memberPriceEuros') ?? '').trim();
      const badgeTextRaw = String(fd.get('badgeText') ?? '').trim();
      if (gridProblem) {
        productsError = gridProblemMessage(gridProblem);
        return;
      }
      // A grid REPLACES the member price - two live mechanisms for "some people pay less" would
      // need an order between them, and the server has none by design. So the field it replaces is
      // cleared rather than left behind as a figure nothing charges.
      const gridded = editingMatrix !== null;
      const updated = await updateProduct(asso.id, product.id, {
        allowRepeatPurchase: allowRepeat,
        maxPurchasesPerUser: maxPerUserRaw ? Number(maxPerUserRaw) : null,
        maxPurchasesTotal: maxTotalRaw ? Number(maxTotalRaw) : null,
        membersOnly,
        priceMatrix: matrixPayload(editingMatrix) as PriceMatrix | null,
        amountCentsMember:
          !gridded && memberPriceRaw ? Math.round(Number(memberPriceRaw) * 100) : null,
        badgeText: badgeTextRaw || null,
      });
      products = products.map((p) => (p.id === product.id ? updated : p));
      expandedProductSettingsId = null;
      editingMatrix = null;
    } catch (e) {
      productsError = e instanceof Error ? e.message : 'Error';
    } finally {
      savingProductSettings = null;
    }
  }

  async function handleDeleteProduct(product: AssociationProduct) {
    if (
      !(await showConfirm(m.asso_boutique_delete_product_confirm({ name: product.name }), {
        danger: true,
        confirmLabel: m.common_delete_button(),
      }))
    )
      return;
    try {
      await deleteProduct(asso.id, product.id);
      products = products.filter((p) => p.id !== product.id);
    } catch (e) {
      productsError = e instanceof Error ? e.message : 'Error';
    }
  }

  async function handleUploadProductIcon(product: AssociationProduct, file: File) {
    const updated = await uploadProductIcon(asso.id, product.id, file);
    products = products.map((p) => (p.id === product.id ? updated : p));
  }

  async function handleRemoveProductIcon(product: AssociationProduct) {
    const updated = await deleteProductIcon(asso.id, product.id);
    products = products.map((p) => (p.id === product.id ? updated : p));
  }
</script>

<div class="border-cn-border space-y-6 rounded-2xl border bg-(--cn-surface)/95 p-6 shadow-sm">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div>
      <h2 class="text-text-main flex items-center gap-2 text-lg font-bold tracking-tight">
        <ShoppingBag size={20} />
        {m.asso_boutique_title()}
      </h2>
      <p class="text-text-muted mt-1 text-sm">
        {m.asso_boutique_subtitle()}
      </p>
    </div>
    <button
      type="button"
      onclick={() => (showProductForm = !showProductForm)}
      class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold transition-colors"
    >
      <Plus size={16} />
      {m.asso_boutique_new_product_button()}
    </button>
  </div>

  {#if productsError}
    <div class="border-red-err/30 bg-red-err/10 text-red-err rounded-xl border px-4 py-3 text-sm">
      {productsError}
    </div>
  {/if}

  {#if !onlinePaymentsReady}
    <div
      class="border-amber-warn/30 bg-amber-warn/10 text-amber-warn rounded-xl border px-4 py-3 text-sm"
    >
      {#if payoutAccountPending}
        {m.asso_boutique_payments_pending()}
      {:else}
        {m.asso_boutique_payments_not_configured()}
        {#if canManageStripeConnect}
          <span class="ml-1">{m.asso_boutique_payments_see_above()}</span>
        {:else}
          <span class="ml-1">{m.asso_boutique_payments_ask_manager()}</span>
        {/if}
      {/if}
    </div>
  {/if}

  <!-- New product form -->
  {#if showProductForm}
    <form
      class="border-cn-border bg-cn-bg/40 space-y-4 rounded-xl border p-5"
      onsubmit={(e) => {
        e.preventDefault();
        void handleCreateProduct();
      }}
    >
      <h3 class="text-text-main text-sm font-bold">{m.asso_boutique_form_title()}</h3>

      <div class="space-y-1">
        <label for="new-product-name" class="text-text-muted text-xs font-semibold"
          >{m.asso_boutique_name_label()}</label
        >
        <input
          id="new-product-name"
          type="text"
          bind:value={newProductName}
          placeholder="T-shirt promo"
          required
          class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
        />
      </div>

      <div class="space-y-1">
        <Textarea
          id="new-product-description"
          bind:value={newProductDescription}
          rows={2}
          placeholder={m.asso_boutique_description_placeholder()}
          label={m.asso_boutique_description_label()}
        />
      </div>

      <div class="grid gap-4 sm:grid-cols-2">
        <div class="space-y-1">
          <label for="new-product-amount" class="text-text-muted text-xs font-semibold"
            >{m.asso_boutique_fixed_price_label()}</label
          >
          <input
            id="new-product-amount"
            type="number"
            min="0.01"
            step="0.01"
            bind:value={newProductAmountCents}
            placeholder="10.00"
            class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
          />
        </div>
        <div class="flex flex-col justify-end space-y-1">
          <label class="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" bind:checked={newProductAllowCustom} class="rounded" />
            {m.asso_boutique_allow_custom_label()}
          </label>
        </div>
      </div>

      {#if newProductAllowCustom}
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1">
            <label for="new-product-min" class="text-text-muted text-xs font-semibold"
              >{m.asso_boutique_min_label()}</label
            >
            <input
              id="new-product-min"
              type="number"
              min="0.01"
              step="0.01"
              bind:value={newProductMinCents}
              placeholder="5.00"
              class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
            />
          </div>
          <div class="space-y-1">
            <label for="new-product-max" class="text-text-muted text-xs font-semibold"
              >{m.asso_boutique_max_label()}</label
            >
            <input
              id="new-product-max"
              type="number"
              min="0.01"
              step="0.01"
              bind:value={newProductMaxCents}
              placeholder="100.00"
              class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
            />
          </div>
        </div>
      {/if}

      <StripeNetPayoutHint
        grossEuros={newProductAmountCents}
        minEuros={newProductAllowCustom ? newProductMinCents : ''}
        maxEuros={newProductAllowCustom ? newProductMaxCents : ''}
      />

      <div class="border-cn-border/60 bg-cn-bg/30 space-y-3 rounded-xl border p-4">
        <p class="text-text-main text-xs font-bold tracking-wide uppercase">
          {m.asso_boutique_cotisant_pricing_title()}
        </p>
        <label class="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" bind:checked={newProductMembersOnly} class="rounded" />
          {m.asso_boutique_members_only_label()}
        </label>
        <div class="space-y-1">
          <label for="new-product-member-price" class="text-text-muted text-xs font-semibold"
            >{m.asso_boutique_member_price_label()}</label
          >
          <input
            id="new-product-member-price"
            type="number"
            min="0"
            step="0.01"
            bind:value={newProductAmountCentsMember}
            placeholder={m.asso_boutique_member_price_placeholder()}
            class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
          />
        </div>
        <p class="text-text-muted text-xs">{m.asso_boutique_member_price_hint()}</p>
      </div>

      <div class="border-cn-border/60 bg-cn-bg/30 space-y-3 rounded-xl border p-4">
        <p class="text-text-main text-xs font-bold tracking-wide uppercase">
          {m.asso_boutique_limits_title()}
        </p>
        <label class="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" bind:checked={newProductAllowRepeat} class="rounded" />
          {m.asso_boutique_allow_repeat_label()}
        </label>
        {#if newProductAllowRepeat}
          <div class="grid gap-4 sm:grid-cols-2">
            <div class="space-y-1">
              <label for="new-product-max-user" class="text-text-muted text-xs font-semibold"
                >{m.asso_boutique_max_per_user_label()}</label
              >
              <input
                id="new-product-max-user"
                type="number"
                min="1"
                step="1"
                bind:value={newProductMaxPerUser}
                placeholder={m.asso_boutique_unlimited_placeholder()}
                class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
              />
            </div>
            <div class="space-y-1">
              <label for="new-product-max-total" class="text-text-muted text-xs font-semibold"
                >{m.asso_boutique_max_total_label()}</label
              >
              <input
                id="new-product-max-total"
                type="number"
                min="1"
                step="1"
                bind:value={newProductMaxTotal}
                placeholder={m.asso_boutique_unlimited_placeholder()}
                class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
              />
            </div>
          </div>
        {:else}
          <p class="text-text-muted text-xs">
            {m.asso_boutique_no_repeat_hint()}
          </p>
        {/if}
      </div>

      <div class="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={savingProduct || !newProductName.trim()}
          class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-5 py-2.5 text-sm font-bold disabled:opacity-50"
        >
          {savingProduct ? m.asso_boutique_creating() : m.asso_boutique_create_button()}
        </button>
        <button
          type="button"
          onclick={resetProductForm}
          class="text-text-muted hover:text-text-main text-sm">{m.common_cancel_button()}</button
        >
      </div>
    </form>
  {/if}

  <!-- Product list -->
  {#if productsLoading}
    <div class="flex justify-center py-6">
      <div
        class="border-cn-yellow h-6 w-6 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else if otherProducts.length === 0}
    <p class="text-text-muted py-6 text-center text-sm">{m.asso_boutique_no_products()}</p>
  {:else}
    <ul class="grid gap-4 sm:grid-cols-2">
      {#each otherProducts as product (product.id)}
        <li class={expandedProductSettingsId === product.id ? 'sm:col-span-2' : ''}>
          <CardTile
            iconUrl={product.iconUrl}
            fallbackIcon={productFallbackIcon(product.type)}
            accentColor={cardAccentColor}
            badgeText={product.badgeText}
          >
            <div class="flex flex-col gap-3 p-4">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <p class="text-text-main text-sm font-semibold">{product.name}</p>
                  <span
                    class="rounded-full px-2 py-0.5 text-xs font-semibold {product.isActive
                      ? 'bg-green-ok/15 text-green-ok'
                      : 'bg-cn-surface-alt text-text-muted'}"
                  >
                    {product.isActive
                      ? m.asso_boutique_product_active()
                      : m.asso_boutique_product_inactive()}
                  </span>
                  {#if product.membersOnly}
                    <span
                      class="bg-amber-warn/15 text-amber-warn rounded-full px-2 py-0.5 text-xs font-semibold"
                    >
                      {m.asso_boutique_members_only_label()}
                    </span>
                  {/if}
                </div>
                <p class="text-text-muted mt-0.5 text-xs">
                  {#if product.priceMatrix}
                    {m.asso_boutique_grid_summary()}
                  {:else}
                    {product.amountCents != null
                      ? `${(product.amountCents / 100).toFixed(2)} €`
                      : m.asso_boutique_product_free()}
                  {/if}
                  {product.grantedTagName
                    ? ` · ${m.asso_boutique_product_tag_label({ tag: product.grantedTagName })}`
                    : ''}
                  {#if !product.priceMatrix && product.amountCentsMember != null}
                    · {m.asso_boutique_product_member_price_label({
                      price: (product.amountCentsMember / 100).toFixed(2),
                    })}
                  {/if}
                  {#if product.allowRepeatPurchase}
                    · {m.asso_boutique_product_repeat_label()}
                  {/if}
                  {#if product.maxPurchasesTotal != null}
                    · {m.asso_boutique_product_stock_label({ count: product.maxPurchasesTotal })}
                  {/if}
                </p>
                <!--
                  "Inactive" alone does not say WHO decided it. A product held back for want of a
                  payment account goes on sale by itself, and one deliberately withdrawn never
                  does - the badge above cannot carry that, so the line below does.
                -->
                {#if !product.isActive && product.activationWithheld}
                  <p class="text-amber-warn mt-1 text-xs font-semibold">
                    {m.asso_boutique_product_withheld_hint()}
                  </p>
                {/if}
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onclick={() => toggleProductSettings(product)}
                  class="border-cn-border inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-(--cn-surface)"
                >
                  {m.asso_boutique_limits_button()}
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
                  class="border-cn-border rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-(--cn-surface)"
                >
                  {product.isActive
                    ? m.asso_boutique_deactivate_button()
                    : m.asso_boutique_activate_button()}
                </button>
                <button
                  type="button"
                  onclick={() => handleDeleteProduct(product)}
                  title={m.common_delete_button()}
                  class="border-red-err/30 bg-red-err/10 text-red-err hover:bg-red-err/20 ml-auto inline-flex items-center justify-center rounded-xl border p-2 transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            {#if expandedProductSettingsId === product.id}
              <div class="border-cn-border/60 bg-cn-bg/20 space-y-4 border-t px-4 py-3">
                <CardIconEditor
                  iconUrl={product.iconUrl}
                  fallbackIcon={productFallbackIcon(product.type)}
                  onUpload={(file) => handleUploadProductIcon(product, file)}
                  onRemove={() => handleRemoveProductIcon(product)}
                />
                <form
                  class="grid gap-3 sm:grid-cols-2"
                  onsubmit={(e) => {
                    e.preventDefault();
                    void handleSaveProductSettings(product, e.currentTarget);
                  }}
                >
                  <label class="flex cursor-pointer items-center gap-2 text-sm sm:col-span-2">
                    <input
                      type="checkbox"
                      name="membersOnly"
                      checked={product.membersOnly}
                      class="rounded"
                    />
                    {m.asso_boutique_members_only_label()}
                  </label>
                  <!--
                  Hidden while a grid is on, and not merely ignored: a price field still showing a
                  figure nothing charges is the kind of dead state a manager reads as the truth.
                -->
                  {#if editingMatrix === null}
                    <div class="space-y-1 sm:col-span-2">
                      <label
                        for="member-price-{product.id}"
                        class="text-text-muted text-xs font-semibold"
                        >{m.asso_boutique_member_price_label()}</label
                      >
                      <input
                        id="member-price-{product.id}"
                        name="memberPriceEuros"
                        type="number"
                        min="0"
                        step="0.01"
                        value={product.amountCentsMember != null
                          ? product.amountCentsMember / 100
                          : ''}
                        placeholder={m.asso_boutique_member_price_placeholder()}
                        class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
                      />
                    </div>
                  {/if}
                  <div class="space-y-3 sm:col-span-2">
                    <label class="flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        checked={editingMatrix !== null}
                        onchange={(e) => toggleProductGrid(product, e.currentTarget.checked)}
                        class="mt-0.5 rounded"
                      />
                      <span>
                        <span class="text-text-main block text-xs font-semibold">
                          {m.asso_boutique_grid_toggle_label()}
                        </span>
                        <span class="text-text-muted block text-xs">
                          {m.asso_boutique_grid_toggle_hint()}
                        </span>
                      </span>
                    </label>
                    {#if editingMatrix !== null}
                      <!--
                      The same editor the forms use, deliberately: one grid, one validator, one
                      resolution. `items` is empty because a product has no questions to price on.
                    -->
                      <PriceGridEditor
                        bind:matrix={editingMatrix}
                        basePrice={(product.amountCents ?? 0) / 100}
                        tiers={cotisationTiers}
                        {formations}
                        items={[]}
                        hasCotisation={cotisationTiers.length > 0}
                      />
                    {/if}
                  </div>
                  <div class="space-y-1 sm:col-span-2">
                    <label
                      for="badge-text-{product.id}"
                      class="text-text-muted text-xs font-semibold"
                      >{m.asso_card_badge_label()}</label
                    >
                    <input
                      id="badge-text-{product.id}"
                      name="badgeText"
                      type="text"
                      maxlength="30"
                      value={product.badgeText ?? ''}
                      placeholder={m.asso_card_badge_placeholder()}
                      class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
                    />
                  </div>
                  <label class="flex cursor-pointer items-center gap-2 text-sm sm:col-span-2">
                    <input
                      type="checkbox"
                      name="allowRepeat"
                      checked={product.allowRepeatPurchase}
                      class="rounded"
                    />
                    {m.asso_boutique_allow_repeat_label()}
                  </label>
                  <div class="space-y-1">
                    <label for="max-user-{product.id}" class="text-text-muted text-xs font-semibold"
                      >{m.asso_boutique_max_per_user_field_label()}</label
                    >
                    <input
                      id="max-user-{product.id}"
                      name="maxPerUser"
                      type="number"
                      min="1"
                      value={product.maxPurchasesPerUser ?? ''}
                      placeholder={m.asso_boutique_unlimited_placeholder()}
                      class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
                    />
                  </div>
                  <div class="space-y-1">
                    <label
                      for="max-total-{product.id}"
                      class="text-text-muted text-xs font-semibold"
                      >{m.asso_boutique_max_total_field_label()}</label
                    >
                    <input
                      id="max-total-{product.id}"
                      name="maxTotal"
                      type="number"
                      min="1"
                      value={product.maxPurchasesTotal ?? ''}
                      placeholder={m.asso_boutique_unlimited_placeholder()}
                      class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={savingProductSettings === product.id || gridProblem !== null}
                    class="bg-cn-yellow text-cn-dark w-fit rounded-lg px-4 py-2 text-xs font-bold disabled:opacity-50 sm:col-span-2"
                  >
                    {savingProductSettings === product.id
                      ? m.asso_boutique_saving_limits_label()
                      : m.asso_boutique_save_limits_button()}
                  </button>
                </form>
              </div>
            {/if}
          </CardTile>
        </li>
      {/each}
    </ul>
  {/if}
</div>
