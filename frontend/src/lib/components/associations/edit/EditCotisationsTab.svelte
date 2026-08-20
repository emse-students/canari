<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    listCotisants,
    grantCotisant,
    exportCotisants,
    revokeAssociationTag,
    updateAssociation,
    listAssociationProductsForManage,
    listCotisationTiers,
    createProduct,
    updateProduct,
    deleteProduct,
    type Association,
    type AssociationProduct,
    type CotisantRosterItem,
    type CotisationTier,
  } from '$lib/associations/api';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import UserAutocomplete from '$lib/components/shared/UserAutocomplete.svelte';
  import {
    HandCoins,
    Pencil,
    Search,
    Trash2,
    UserPlus,
    Download,
    Plus,
    ChevronDown,
  } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';

  interface Props {
    asso: Association;
    /** Roster read/add/export gate (reuses MANAGE_MEMBERS, D5). */
    canManageMembers: boolean;
    /** Cotisation enable/config gate (reuses MANAGE_PRODUCTS, D5). */
    canManageProducts: boolean;
  }

  let { asso = $bindable(), canManageMembers, canManageProducts }: Props = $props();

  const PAGE_SIZE = 50;
  const SEARCH_DEBOUNCE_MS = 350;

  // ── Activation (not yet enabled) ─────────────────────────────────────────
  let activateMode = $state<'lifetime' | 'dated'>('lifetime');
  let activating = $state(false);
  let activateError = $state('');

  // ── Config (enabled) ──────────────────────────────────────────────────────
  let editingConfig = $state(false);
  let configMode = $state<'lifetime' | 'dated'>('lifetime');
  let configSaving = $state(false);
  let configError = $state('');

  // ── Cotisation tiers (membership products, WP-COT-6 multi-tier) ────────────
  let tierProducts = $state<AssociationProduct[]>([]);
  let tiersLoading = $state(false);
  let tiersError = $state('');
  /** Tracks the last association we loaded tiers for, to avoid refetch loops. */
  let tiersLoadedForAssoId: string | null = null;

  let showAddTierForm = $state(false);
  let addingTier = $state(false);
  let newTierName = $state('');
  let newTierVariantKey = $state('');
  let newTierPriceEuros = $state<number | ''>('');
  let newTierMemberPriceTag = $state('');
  let newTierMemberPriceEuros = $state<number | ''>('');

  let expandedTierId = $state<string | null>(null);
  let savingTierId = $state<string | null>(null);

  // ── Roster ────────────────────────────────────────────────────────────────
  let search = $state('');
  let rosterItems = $state<CotisantRosterItem[]>([]);
  let rosterTotal = $state(0);
  let rosterHasMore = $state(true);
  let rosterLoading = $state(false);
  let rosterLoadingMore = $state(false);
  let rosterError = $state('');
  let sentinel = $state<HTMLElement | null>(null);
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let firstRosterLoad = true;

  // ── Add cotisant ──────────────────────────────────────────────────────────
  let addUserId = $state('');
  let adding = $state(false);
  let addError = $state('');
  /**
   * Tiers offered to a manual add. Fetched from the MANAGE_MEMBERS endpoint rather than reused
   * from `tierProducts`, which only loads for MANAGE_PRODUCTS holders - roster managers must be
   * able to pick a forfait without holding the boutique permission.
   */
  let cotisationTiers = $state<CotisationTier[]>([]);
  let addVariantKey = $state('');
  let tiersLoadedForMembersAssoId: string | null = null;
  /** Roster row whose tier switch is in flight, so its picker can be disabled meanwhile. */
  let switchingTagId = $state<string | null>(null);

  // ── Export ────────────────────────────────────────────────────────────────
  let exporting = $state(false);
  let exportError = $state('');

  /** Groups (already promo-sorted) roster items into consecutive same-promo blocks for header rendering. */
  let rosterGroups = $derived.by(() => {
    const groups: { promo: number | null; items: CotisantRosterItem[] }[] = [];
    for (const item of rosterItems) {
      const last = groups[groups.length - 1];
      if (last && last.promo === item.promo) {
        last.items.push(item);
      } else {
        groups.push({ promo: item.promo, items: [item] });
      }
    }
    return groups;
  });

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(getLocale() === 'en' ? 'en-US' : 'fr-FR');
  }

  function cotisantName(item: CotisantRosterItem): string {
    const name = `${item.firstName ?? ''} ${item.lastName ?? ''}`.trim();
    return name || getUserDisplayNameSync(item.userId);
  }

  onDestroy(() => {
    if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer);
  });

  /** Reloads the roster from `offset`; debounced on search-term changes, immediate on the first run. */
  $effect(() => {
    void search;
    if (!asso.cotisationEnabled) return;
    if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer);
    if (firstRosterLoad) {
      firstRosterLoad = false;
      void loadRoster(0, true);
      return;
    }
    searchDebounceTimer = setTimeout(() => {
      void loadRoster(0, true);
    }, SEARCH_DEBOUNCE_MS);
  });

  /** Loads the tier (membership) products once per association, whenever cotisation is enabled. */
  $effect(() => {
    if (!asso.cotisationEnabled || !canManageProducts) return;
    if (tiersLoadedForAssoId === asso.id) return;
    tiersLoadedForAssoId = asso.id;
    void loadTierProducts();
  });

  /** Loads the tier list backing the "add a cotisant" forfait picker. */
  $effect(() => {
    if (!asso.cotisationEnabled || !canManageMembers) return;
    if (tiersLoadedForMembersAssoId === asso.id) return;
    tiersLoadedForMembersAssoId = asso.id;
    void loadCotisationTiers();
  });

  // Infinite scroll: fetch the next page once the sentinel enters the viewport.
  $effect(() => {
    if (!sentinel) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMoreRoster();
      },
      { rootMargin: '200px' }
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  });

  async function loadRoster(offset: number, replace: boolean) {
    if (replace) {
      rosterLoading = true;
    } else {
      rosterLoadingMore = true;
    }
    rosterError = '';
    console.log(
      `[Cotisations] Loading roster - asso=${asso.id.slice(0, 8)} offset=${offset} search=${search}`
    );
    try {
      const pageResult = await listCotisants(asso.id, { search, offset, limit: PAGE_SIZE });
      rosterItems = replace ? pageResult.items : [...rosterItems, ...pageResult.items];
      rosterTotal = pageResult.total;
      rosterHasMore = pageResult.hasMore;
    } catch (e) {
      rosterError = e instanceof Error ? e.message : m.asso_cotisations_load_error();
      console.error('[Cotisations] Failed to load roster:', e);
    } finally {
      rosterLoading = false;
      rosterLoadingMore = false;
    }
  }

  async function loadMoreRoster() {
    if (rosterLoading || rosterLoadingMore || !rosterHasMore) return;
    await loadRoster(rosterItems.length, false);
  }

  async function handleActivate() {
    activating = true;
    activateError = '';
    console.log(
      `[Cotisations] Enabling cotisation - asso=${asso.id.slice(0, 8)} mode=${activateMode}`
    );
    try {
      const updated = await updateAssociation(asso.id, {
        cotisationEnabled: true,
        cotisationMode: activateMode,
      });
      asso = updated;
    } catch (e) {
      activateError = e instanceof Error ? e.message : m.asso_cotisations_activate_error();
      console.error('[Cotisations] Failed to enable cotisation:', e);
    } finally {
      activating = false;
    }
  }

  function startEditConfig() {
    configMode = asso.cotisationMode ?? 'lifetime';
    configError = '';
    editingConfig = true;
  }

  async function handleSaveConfig() {
    configSaving = true;
    configError = '';
    console.log(`[Cotisations] Saving config - asso=${asso.id.slice(0, 8)} mode=${configMode}`);
    try {
      const updated = await updateAssociation(asso.id, {
        cotisationEnabled: true,
        cotisationMode: configMode,
      });
      asso = updated;
      editingConfig = false;
    } catch (e) {
      configError = e instanceof Error ? e.message : m.asso_cotisations_config_save_error();
      console.error('[Cotisations] Failed to save config:', e);
    } finally {
      configSaving = false;
    }
  }

  /** Fetches the association's products and keeps every tier (membership-type) product, base tier first. */
  async function loadTierProducts() {
    tiersLoading = true;
    tiersError = '';
    console.log(`[Cotisations] Loading tier products - asso=${asso.id.slice(0, 8)}`);
    try {
      const productsList = await listAssociationProductsForManage(asso.id);
      tierProducts = productsList
        .filter((p) => p.type === 'membership')
        .sort((a, b) => (a.variantKey === null ? -1 : 1) - (b.variantKey === null ? -1 : 1));
    } catch (e) {
      tiersError = e instanceof Error ? e.message : m.asso_cotisations_membership_load_error();
      console.error('[Cotisations] Failed to load tier products:', e);
    } finally {
      tiersLoading = false;
    }
  }

  /**
   * Fetches the association's cotisation tiers and preselects one. When the association has no
   * base tier (a multi-tier setup that dropped it), the empty choice would be rejected by the
   * server, so the first named tier is selected instead of leaving an invalid default.
   */
  async function loadCotisationTiers() {
    console.log(`[Cotisations] Loading tiers for manual add - asso=${asso.id.slice(0, 8)}`);
    try {
      cotisationTiers = await listCotisationTiers(asso.id);
      const hasBaseTier = cotisationTiers.some((t) => t.variantKey === null);
      addVariantKey = hasBaseTier ? '' : (cotisationTiers[0]?.variantKey ?? '');
    } catch (e) {
      console.error('[Cotisations] Failed to load tiers:', e);
    }
  }

  function resetAddTierForm() {
    newTierName = '';
    newTierVariantKey = '';
    newTierPriceEuros = '';
    newTierMemberPriceTag = '';
    newTierMemberPriceEuros = '';
    showAddTierForm = false;
  }

  /** Creates an additional cotisation tier (the base tier already exists once cotisation is enabled). */
  async function handleCreateTier() {
    if (!newTierName.trim() || !newTierVariantKey.trim()) return;
    addingTier = true;
    tiersError = '';
    console.log(
      `[Cotisations] Creating tier - asso=${asso.id.slice(0, 8)} variantKey=${newTierVariantKey.trim()}`
    );
    try {
      await createProduct(asso.id, {
        name: newTierName.trim(),
        type: 'membership',
        variantKey: newTierVariantKey.trim(),
        amountCents:
          newTierPriceEuros !== '' ? Math.round(Number(newTierPriceEuros) * 100) : undefined,
        memberPriceTag: newTierMemberPriceTag || undefined,
        amountCentsMember:
          newTierMemberPriceTag && newTierMemberPriceEuros !== ''
            ? Math.round(Number(newTierMemberPriceEuros) * 100)
            : undefined,
      });
      resetAddTierForm();
      await Promise.all([loadTierProducts(), loadCotisationTiers()]);
    } catch (e) {
      tiersError = e instanceof Error ? e.message : m.asso_cotisations_tier_create_error();
      console.error('[Cotisations] Failed to create tier:', e);
    } finally {
      addingTier = false;
    }
  }

  function toggleTierEdit(product: AssociationProduct) {
    expandedTierId = expandedTierId === product.id ? null : product.id;
  }

  /**
   * Saves a tier's label, price, upgrade-pricing link and tier identifier.
   *
   * `variantKey` is editable so an association that outgrew the auto-provisioned base tier can
   * convert it into a named forfait: the server re-derives the granted tag and carries the
   * existing cotisants over to it, so nothing is lost. An empty value means the base tier.
   */
  async function handleSaveTier(product: AssociationProduct, form: HTMLFormElement) {
    const fd = new FormData(form);
    savingTierId = product.id;
    tiersError = '';
    try {
      const name = String(fd.get('name') ?? '').trim();
      const priceRaw = String(fd.get('priceEuros') ?? '').trim();
      const memberPriceTag = String(fd.get('memberPriceTag') ?? '');
      const memberPriceRaw = String(fd.get('memberPriceEuros') ?? '').trim();
      const variantKey = String(fd.get('variantKey') ?? '').trim() || null;
      if (!name) return;
      const updated = await updateProduct(asso.id, product.id, {
        name,
        variantKey,
        amountCents: priceRaw ? Math.round(Number(priceRaw) * 100) : null,
        memberPriceTag: memberPriceTag || null,
        amountCentsMember:
          memberPriceTag && memberPriceRaw ? Math.round(Number(memberPriceRaw) * 100) : null,
      });
      tierProducts = tierProducts.map((p) => (p.id === product.id ? updated : p));
      expandedTierId = null;
      // A retag renames the tag on every cotisant of this tier, so both the picker and the
      // roster's Forfait column are stale until refetched.
      await Promise.all([loadCotisationTiers(), loadRoster(0, true)]);
    } catch (e) {
      tiersError = e instanceof Error ? e.message : m.asso_cotisations_membership_save_error();
      console.error('[Cotisations] Failed to save tier:', e);
    } finally {
      savingTierId = null;
    }
  }

  /**
   * Deletes a tier. Allowed for the base tier too - a multi-tier association typically wants the
   * auto-provisioned base gone, since holders of its un-suffixed tag report no forfait at all to
   * consumers like Le Cercle. The server refuses to delete the last remaining tier.
   */
  async function handleDeleteTier(product: AssociationProduct) {
    if (
      !(await showConfirm(m.asso_cotisations_tier_delete_confirm({ name: product.name }), {
        danger: true,
        confirmLabel: m.common_delete_button(),
      }))
    )
      return;
    try {
      await deleteProduct(asso.id, product.id);
      tierProducts = tierProducts.filter((p) => p.id !== product.id);
      await loadCotisationTiers();
    } catch (e) {
      tiersError = e instanceof Error ? e.message : m.asso_cotisations_tier_delete_error();
      console.error('[Cotisations] Failed to delete tier:', e);
    }
  }

  /**
   * The `variantKey` of the tier a roster row currently holds. Matched on the tag name (exact,
   * derived from the same source on both sides) and only then on the display name, which is what
   * still identifies a tag granted under a previous period in `dated` mode.
   */
  function currentVariantKey(item: CotisantRosterItem): string {
    const byTag = cotisationTiers.find((t) => t.tagName === item.tagName);
    if (byTag) return byTag.variantKey ?? '';
    const byName = cotisationTiers.find((t) => t.name === item.tier);
    return byName?.variantKey ?? '';
  }

  /**
   * Moves an existing cotisant to another tier (upgrade or downgrade). Re-granting is the whole
   * operation: the server grants the new tier and revokes the sibling in one transaction (XOR), so
   * there is no window where the user holds two forfaits or none. Reloads the roster because the
   * row's tag, id and dates all change.
   */
  async function handleChangeTier(item: CotisantRosterItem, variantKey: string) {
    if (variantKey === currentVariantKey(item)) return;
    console.log(
      `[Cotisations] Switching tier - asso=${asso.id.slice(0, 8)} user=${item.userId.slice(0, 8)} tier=${variantKey || 'base'}`
    );
    switchingTagId = item.tagId;
    rosterError = '';
    try {
      await grantCotisant(asso.id, item.userId, variantKey || null);
      await loadRoster(0, true);
    } catch (e) {
      rosterError = e instanceof Error ? e.message : m.asso_cotisations_tier_change_error();
      console.error('[Cotisations] Failed to switch tier:', e);
      // Put the <select> back on the tier actually held - the change never happened.
      rosterItems = [...rosterItems];
    } finally {
      switchingTagId = null;
    }
  }

  async function handleRevoke(item: CotisantRosterItem) {
    if (
      !(await showConfirm(m.asso_cotisations_revoke_confirm({ name: cotisantName(item) }), {
        danger: true,
        confirmLabel: m.asso_cotisations_revoke_button(),
      }))
    )
      return;
    try {
      await revokeAssociationTag(asso.id, item.tagId);
      rosterItems = rosterItems.filter((i) => i.tagId !== item.tagId);
      rosterTotal = Math.max(0, rosterTotal - 1);
    } catch (e) {
      rosterError = e instanceof Error ? e.message : m.asso_cotisations_load_error();
      console.error('[Cotisations] Failed to revoke tag:', e);
    }
  }

  async function handleAdd() {
    if (!addUserId.trim()) return;
    adding = true;
    addError = '';
    console.log(
      `[Cotisations] Granting cotisant - asso=${asso.id.slice(0, 8)} tier=${addVariantKey || 'base'}`
    );
    try {
      await grantCotisant(asso.id, addUserId.trim(), addVariantKey || null);
      addUserId = '';
      await loadRoster(0, true);
    } catch (e) {
      addError = e instanceof Error ? e.message : m.asso_cotisations_add_error();
      console.error('[Cotisations] Failed to grant cotisant:', e);
    } finally {
      adding = false;
    }
  }

  async function handleExport() {
    exporting = true;
    exportError = '';
    console.log(`[Cotisations] Exporting roster - asso=${asso.id.slice(0, 8)}`);
    try {
      await exportCotisants(asso.id);
    } catch (e) {
      exportError = e instanceof Error ? e.message : m.asso_cotisations_export_error();
      console.error('[Cotisations] Failed to export roster:', e);
    } finally {
      exporting = false;
    }
  }
</script>

<div class="space-y-6">
  <div class="border-cn-border space-y-1 rounded-2xl border bg-(--cn-surface)/95 p-6 shadow-sm">
    <h2 class="text-text-main flex items-center gap-2 text-lg font-bold tracking-tight">
      <HandCoins size={20} />
      {m.asso_cotisations_title()}
    </h2>
    <p class="text-text-muted text-sm">{m.asso_cotisations_subtitle()}</p>
  </div>

  {#if !asso.cotisationEnabled}
    {#if canManageProducts}
      <div class="border-cn-border space-y-4 rounded-2xl border bg-(--cn-surface)/95 p-6 shadow-sm">
        <div>
          <h3 class="text-text-main text-sm font-bold">{m.asso_cotisations_activate_title()}</h3>
          <p class="text-text-muted mt-1 text-xs">{m.asso_cotisations_activate_desc()}</p>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1">
            <label for="activate-mode" class="text-text-muted text-xs font-semibold"
              >{m.asso_cotisations_mode_label()}</label
            >
            <select
              id="activate-mode"
              bind:value={activateMode}
              class="border-cn-border w-full rounded-xl border bg-(--cn-surface) px-3 py-2.5 text-sm"
            >
              <option value="lifetime">{m.asso_cotisations_mode_lifetime()}</option>
              <option value="dated">{m.asso_cotisations_mode_dated()}</option>
            </select>
          </div>
          {#if activateMode === 'dated'}
            <p class="text-text-muted self-end pb-2.5 text-xs">
              {m.asso_cotisations_dated_auto_hint()}
            </p>
          {/if}
        </div>
        {#if activateError}
          <p class="text-red-err text-sm">{activateError}</p>
        {/if}
        <button
          type="button"
          onclick={() => void handleActivate()}
          disabled={activating}
          class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-5 py-2.5 text-sm font-bold disabled:opacity-50"
        >
          {activating ? m.common_saving_label() : m.asso_cotisations_activate_button()}
        </button>
      </div>
    {:else}
      <div class="border-cn-border rounded-2xl border bg-(--cn-surface)/95 p-6 shadow-sm">
        <p class="text-text-main text-sm font-semibold">
          {m.asso_cotisations_disabled_no_perm_title()}
        </p>
        <p class="text-text-muted mt-1 text-sm">{m.asso_cotisations_disabled_no_perm_desc()}</p>
      </div>
    {/if}
  {:else}
    <!-- Config summary -->
    <div class="border-cn-border space-y-4 rounded-2xl border bg-(--cn-surface)/95 p-6 shadow-sm">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <h3 class="text-text-main text-sm font-bold">{m.asso_cotisations_config_title()}</h3>
        {#if canManageProducts && !editingConfig}
          <button
            type="button"
            onclick={startEditConfig}
            class="border-cn-border text-text-muted hover:text-text-main hover:bg-cn-bg inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold"
          >
            <Pencil size={14} />
            {m.asso_cotisations_config_edit_button()}
          </button>
        {/if}
      </div>

      {#if editingConfig}
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1">
            <label for="config-mode" class="text-text-muted text-xs font-semibold"
              >{m.asso_cotisations_mode_label()}</label
            >
            <select
              id="config-mode"
              bind:value={configMode}
              class="border-cn-border w-full rounded-xl border bg-(--cn-surface) px-3 py-2.5 text-sm"
            >
              <option value="lifetime">{m.asso_cotisations_mode_lifetime()}</option>
              <option value="dated">{m.asso_cotisations_mode_dated()}</option>
            </select>
          </div>
          {#if configMode === 'dated'}
            <p class="text-text-muted self-end pb-2.5 text-xs">
              {m.asso_cotisations_dated_auto_hint()}
            </p>
          {/if}
        </div>
        {#if configError}
          <p class="text-red-err text-sm">{configError}</p>
        {/if}
        <div class="flex gap-2">
          <button
            type="button"
            onclick={() => void handleSaveConfig()}
            disabled={configSaving}
            class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50"
          >
            {configSaving ? m.common_saving_label() : m.common_save_button()}
          </button>
          <button
            type="button"
            onclick={() => (editingConfig = false)}
            disabled={configSaving}
            class="border-cn-border text-text-muted hover:text-text-main rounded-xl border px-4 py-2 text-sm font-semibold"
          >
            {m.common_cancel_button()}
          </button>
        </div>
      {:else}
        <p class="text-text-main text-sm">
          {#if asso.cotisationMode === 'dated'}
            {m.asso_cotisations_config_mode_dated_label({
              date: asso.cotisationExpiresAt
                ? formatDate(asso.cotisationExpiresAt)
                : m.asso_cotisations_config_no_expiry(),
            })}
          {:else}
            {m.asso_cotisations_config_mode_lifetime_label()}
          {/if}
        </p>
      {/if}

      {#if canManageProducts}
        <div class="border-cn-border space-y-3 border-t pt-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h4 class="text-text-main text-xs font-bold tracking-wide uppercase">
              {m.asso_cotisations_price_title()}
            </h4>
            {#if !tiersLoading && tierProducts.length > 0}
              <button
                type="button"
                onclick={() => (showAddTierForm = !showAddTierForm)}
                class="border-cn-border text-text-muted hover:text-text-main hover:bg-cn-bg inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold"
              >
                <Plus size={14} />
                {m.asso_cotisations_tier_add_button()}
              </button>
            {/if}
          </div>

          {#if tiersError}
            <p class="text-red-err text-sm">{tiersError}</p>
          {/if}

          {#if tiersLoading}
            <div class="text-text-muted flex items-center gap-2 text-sm">
              <div
                class="border-cn-yellow h-4 w-4 animate-spin rounded-full border-2 border-t-transparent"
              ></div>
              {m.common_loading_label()}
            </div>
          {:else if tierProducts.length === 0}
            <p class="text-text-muted text-sm">{m.asso_cotisations_membership_missing()}</p>
          {:else}
            <ul class="space-y-3">
              {#each tierProducts as product (product.id)}
                <li class="border-cn-border/70 bg-cn-bg/40 overflow-hidden rounded-xl border">
                  <div class="flex items-center gap-3 px-4 py-3">
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <p class="text-text-main text-sm font-semibold">{product.name}</p>
                        {#if product.variantKey}
                          <span
                            class="bg-amber-warn/15 text-amber-warn rounded-full px-2 py-0.5 text-xs font-semibold"
                          >
                            {product.variantKey}
                          </span>
                        {:else}
                          <span
                            class="bg-cn-surface-alt text-text-muted rounded-full px-2 py-0.5 text-xs font-semibold"
                          >
                            {m.asso_cotisations_tier_base_badge()}
                          </span>
                        {/if}
                      </div>
                      <p class="text-text-muted mt-0.5 text-xs">
                        {product.amountCents != null
                          ? `${(product.amountCents / 100).toFixed(2)} €`
                          : m.asso_cotisations_tier_price_free_label()}
                        {#if product.memberPriceTag && product.amountCentsMember != null}
                          · {m.asso_cotisations_tier_upgrade_price_label({
                            price: (product.amountCentsMember / 100).toFixed(2),
                          })}
                        {/if}
                      </p>
                    </div>
                    <div class="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onclick={() => toggleTierEdit(product)}
                        class="border-cn-border inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-(--cn-surface)"
                      >
                        <Pencil size={12} />
                        <ChevronDown
                          size={12}
                          class="transition-transform {expandedTierId === product.id
                            ? 'rotate-180'
                            : ''}"
                        />
                      </button>
                      <!-- The last tier is not deletable: cotisation would break with none left. -->
                      {#if tierProducts.length > 1}
                        <button
                          type="button"
                          onclick={() => void handleDeleteTier(product)}
                          title={m.common_delete_button()}
                          class="border-red-err/30 bg-red-err/10 text-red-err hover:bg-red-err/20 inline-flex items-center justify-center rounded-xl border p-2 transition-colors"
                        >
                          <Trash2 size={14} />
                        </button>
                      {/if}
                    </div>
                  </div>

                  {#if expandedTierId === product.id}
                    <div class="border-cn-border/60 bg-cn-bg/20 border-t px-4 py-3">
                      <form
                        class="grid gap-3 sm:grid-cols-2"
                        onsubmit={(e) => {
                          e.preventDefault();
                          void handleSaveTier(product, e.currentTarget);
                        }}
                      >
                        <div class="space-y-1">
                          <label
                            for="tier-name-{product.id}"
                            class="text-text-muted text-xs font-semibold"
                            >{m.asso_cotisations_price_name_label()}</label
                          >
                          <input
                            id="tier-name-{product.id}"
                            name="name"
                            type="text"
                            value={product.name}
                            required
                            class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
                          />
                        </div>
                        <div class="space-y-1">
                          <label
                            for="tier-price-{product.id}"
                            class="text-text-muted text-xs font-semibold"
                            >{m.asso_cotisations_price_amount_label()}</label
                          >
                          <input
                            id="tier-price-{product.id}"
                            name="priceEuros"
                            type="number"
                            min="0.01"
                            step="0.01"
                            value={product.amountCents != null ? product.amountCents / 100 : ''}
                            placeholder="10.00"
                            class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
                          />
                        </div>
                        <div class="space-y-1 sm:col-span-2">
                          <label
                            for="tier-variant-{product.id}"
                            class="text-text-muted text-xs font-semibold"
                            >{m.asso_cotisations_tier_variant_key_label()}</label
                          >
                          <input
                            id="tier-variant-{product.id}"
                            name="variantKey"
                            type="text"
                            value={product.variantKey ?? ''}
                            placeholder={m.asso_cotisations_tier_variant_key_base_placeholder()}
                            class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
                          />
                          <p class="text-text-muted text-xs">
                            {m.asso_cotisations_tier_variant_key_change_hint()}
                          </p>
                        </div>
                        {#if tierProducts.length > 1}
                          <div class="space-y-1 sm:col-span-2">
                            <label
                              for="tier-upgrade-from-{product.id}"
                              class="text-text-muted text-xs font-semibold"
                              >{m.asso_cotisations_tier_upgrade_from_label()}</label
                            >
                            <select
                              id="tier-upgrade-from-{product.id}"
                              name="memberPriceTag"
                              value={product.memberPriceTag ?? ''}
                              class="border-cn-border w-full rounded-xl border bg-(--cn-surface) px-3 py-2 text-sm"
                            >
                              <option value="">{m.asso_cotisations_tier_upgrade_none()}</option>
                              {#each tierProducts.filter((p) => p.id !== product.id) as sibling (sibling.id)}
                                <option value={sibling.grantedTagName ?? ''}>{sibling.name}</option>
                              {/each}
                            </select>
                          </div>
                          <div class="space-y-1 sm:col-span-2">
                            <label
                              for="tier-upgrade-price-{product.id}"
                              class="text-text-muted text-xs font-semibold"
                              >{m.asso_cotisations_tier_upgrade_price_field_label()}</label
                            >
                            <input
                              id="tier-upgrade-price-{product.id}"
                              name="memberPriceEuros"
                              type="number"
                              min="0"
                              step="0.01"
                              value={product.amountCentsMember != null
                                ? product.amountCentsMember / 100
                                : ''}
                              placeholder={m.asso_cotisations_tier_upgrade_price_placeholder()}
                              class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
                            />
                          </div>
                        {/if}
                        <button
                          type="submit"
                          disabled={savingTierId === product.id}
                          class="bg-cn-yellow text-cn-dark w-fit rounded-lg px-4 py-2 text-xs font-bold disabled:opacity-50 sm:col-span-2"
                        >
                          {savingTierId === product.id
                            ? m.common_saving_label()
                            : m.common_save_button()}
                        </button>
                      </form>
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}

          {#if showAddTierForm}
            <form
              class="border-cn-border bg-cn-bg/40 space-y-3 rounded-xl border p-4"
              onsubmit={(e) => {
                e.preventDefault();
                void handleCreateTier();
              }}
            >
              <p class="text-text-main text-xs font-bold tracking-wide uppercase">
                {m.asso_cotisations_tier_add_title()}
              </p>
              <div class="grid gap-3 sm:grid-cols-2">
                <div class="space-y-1">
                  <label for="new-tier-name" class="text-text-muted text-xs font-semibold"
                    >{m.asso_cotisations_price_name_label()}</label
                  >
                  <input
                    id="new-tier-name"
                    type="text"
                    bind:value={newTierName}
                    required
                    class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
                  />
                </div>
                <div class="space-y-1">
                  <label for="new-tier-variant" class="text-text-muted text-xs font-semibold"
                    >{m.asso_cotisations_tier_variant_key_label()}</label
                  >
                  <input
                    id="new-tier-variant"
                    type="text"
                    bind:value={newTierVariantKey}
                    placeholder="avec-alcool"
                    required
                    class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
                  />
                </div>
                <div class="space-y-1">
                  <label for="new-tier-price" class="text-text-muted text-xs font-semibold"
                    >{m.asso_cotisations_price_amount_label()}</label
                  >
                  <input
                    id="new-tier-price"
                    type="number"
                    min="0.01"
                    step="0.01"
                    bind:value={newTierPriceEuros}
                    placeholder="10.00"
                    class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <p class="text-text-muted text-xs">{m.asso_cotisations_tier_variant_key_hint()}</p>
              <div class="space-y-1">
                <label for="new-tier-upgrade-from" class="text-text-muted text-xs font-semibold"
                  >{m.asso_cotisations_tier_upgrade_from_label()}</label
                >
                <select
                  id="new-tier-upgrade-from"
                  bind:value={newTierMemberPriceTag}
                  class="border-cn-border w-full rounded-xl border bg-(--cn-surface) px-3 py-2 text-sm"
                >
                  <option value="">{m.asso_cotisations_tier_upgrade_none()}</option>
                  {#each tierProducts as sibling (sibling.id)}
                    <option value={sibling.grantedTagName ?? ''}>{sibling.name}</option>
                  {/each}
                </select>
              </div>
              {#if newTierMemberPriceTag}
                <div class="space-y-1">
                  <label for="new-tier-upgrade-price" class="text-text-muted text-xs font-semibold"
                    >{m.asso_cotisations_tier_upgrade_price_field_label()}</label
                  >
                  <input
                    id="new-tier-upgrade-price"
                    type="number"
                    min="0"
                    step="0.01"
                    bind:value={newTierMemberPriceEuros}
                    placeholder={m.asso_cotisations_tier_upgrade_price_placeholder()}
                    class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
                  />
                </div>
              {/if}
              <div class="flex items-center gap-3 pt-1">
                <button
                  type="submit"
                  disabled={addingTier || !newTierName.trim() || !newTierVariantKey.trim()}
                  class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50"
                >
                  {addingTier ? m.common_saving_label() : m.asso_cotisations_tier_create_button()}
                </button>
                <button
                  type="button"
                  onclick={resetAddTierForm}
                  class="text-text-muted hover:text-text-main text-sm"
                  >{m.common_cancel_button()}</button
                >
              </div>
            </form>
          {:else if tierProducts.length === 1 && !tiersLoading}
            <button
              type="button"
              onclick={() => (showAddTierForm = true)}
              class="border-cn-border text-text-muted hover:text-text-main hover:bg-cn-bg inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold"
            >
              <Plus size={15} />
              {m.asso_cotisations_tier_add_button()}
            </button>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Roster -->
    <div class="border-cn-border space-y-4 rounded-2xl border bg-(--cn-surface)/95 p-6 shadow-sm">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h3 class="text-text-main text-sm font-bold">{m.asso_cotisations_roster_title()}</h3>
        {#if canManageMembers}
          <button
            type="button"
            onclick={() => void handleExport()}
            disabled={exporting}
            class="border-cn-border text-text-muted hover:text-text-main hover:bg-cn-bg inline-flex shrink-0 items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            <Download size={15} />
            {exporting ? m.common_generating_label() : m.asso_cotisations_export_button()}
          </button>
        {/if}
      </div>
      {#if exportError}
        <p class="text-red-err text-sm">{exportError}</p>
      {/if}

      <div class="relative">
        <span class="text-text-muted pointer-events-none absolute top-1/2 left-3 -translate-y-1/2">
          <Search size={15} />
        </span>
        <input
          type="text"
          bind:value={search}
          placeholder={m.asso_cotisations_search_placeholder()}
          class="border-cn-border w-full rounded-xl border bg-(--cn-surface) py-2.5 pr-4 pl-9 text-sm outline-none focus:border-amber-400/60 focus:ring-2 focus:ring-amber-400/45"
        />
      </div>

      {#if rosterError}
        <div
          class="border-red-err/30 bg-red-err/10 text-red-err rounded-xl border px-4 py-3 text-sm"
        >
          {rosterError}
        </div>
      {/if}

      {#if rosterLoading}
        <div class="flex justify-center py-8">
          <div
            class="border-cn-yellow h-6 w-6 animate-spin rounded-full border-4 border-t-transparent"
          ></div>
        </div>
      {:else if rosterItems.length === 0}
        <p class="text-text-muted py-8 text-center text-sm">{m.asso_cotisations_no_cotisants()}</p>
      {:else}
        <div class="space-y-4">
          {#each rosterGroups as group (group.promo ?? 'none')}
            <div class="space-y-2">
              <h4 class="text-text-muted text-xs font-bold tracking-wide uppercase">
                {group.promo != null
                  ? m.asso_cotisations_group_promo_label({ promo: group.promo })
                  : m.asso_cotisations_group_no_promo()}
              </h4>
              <ul class="space-y-2">
                {#each group.items as item (item.tagId)}
                  <li
                    class="border-cn-border bg-cn-bg/40 flex items-center gap-3 rounded-xl border px-4 py-3"
                  >
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <p class="text-text-main text-sm font-semibold">{cotisantName(item)}</p>
                        <!-- Multi-tier: the badge becomes a picker, so a forfait can be upgraded
                             or downgraded in place (the server swaps the tags atomically). -->
                        {#if canManageMembers && cotisationTiers.length > 1}
                          <select
                            aria-label={m.asso_cotisations_tier_change_label()}
                            title={m.asso_cotisations_tier_change_label()}
                            disabled={switchingTagId !== null}
                            value={currentVariantKey(item)}
                            onchange={(e) => void handleChangeTier(item, e.currentTarget.value)}
                            class="border-amber-warn/40 bg-amber-warn/15 text-amber-warn rounded-full border px-2 py-0.5 text-xs font-semibold disabled:opacity-50"
                          >
                            {#each cotisationTiers as tier (tier.tagName)}
                              <option value={tier.variantKey ?? ''}>{tier.name}</option>
                            {/each}
                          </select>
                        {:else if item.tier}
                          <span
                            class="bg-amber-warn/15 text-amber-warn rounded-full px-2 py-0.5 text-xs font-semibold"
                          >
                            {item.tier}
                          </span>
                        {/if}
                      </div>
                      <p class="text-text-muted mt-0.5 text-xs">
                        {m.asso_cotisations_col_granted()}: {formatDate(item.grantedAt)}
                        {#if item.expiresAt}
                          · {m.asso_cotisations_col_expiry()}: {formatDate(item.expiresAt)}
                        {:else}
                          · {m.asso_cotisations_expiry_none()}
                        {/if}
                      </p>
                    </div>
                    {#if canManageMembers}
                      <button
                        type="button"
                        onclick={() => void handleRevoke(item)}
                        class="border-red-err/30 text-red-err hover:bg-red-err/10 inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold"
                      >
                        <Trash2 size={14} />
                        {m.asso_cotisations_revoke_button()}
                      </button>
                    {/if}
                  </li>
                {/each}
              </ul>
            </div>
          {/each}
        </div>
        <div bind:this={sentinel} class="h-4"></div>
        {#if rosterLoadingMore}
          <div class="flex justify-center py-3">
            <div
              class="border-cn-yellow h-5 w-5 animate-spin rounded-full border-4 border-t-transparent"
            ></div>
          </div>
        {/if}
        <p class="text-text-muted text-right text-xs">
          {m.asso_cotisations_total_label({ count: rosterTotal })}
        </p>
      {/if}

      {#if canManageMembers}
        <form
          class="border-cn-border flex flex-col gap-3 border-t pt-4 sm:flex-row"
          onsubmit={(e) => {
            e.preventDefault();
            void handleAdd();
          }}
        >
          <div class="min-w-0 flex-1">
            <label for="add-cotisant-user" class="text-text-muted mb-1 block text-xs font-semibold">
              <span class="inline-flex items-center gap-1.5"
                ><UserPlus size={14} />{m.asso_cotisations_add_title()}</span
              >
            </label>
            <UserAutocomplete
              value={addUserId}
              onValueChange={(v) => (addUserId = v)}
              inputId="add-cotisant-user"
              onSubmit={handleAdd}
            />
          </div>
          <!-- Only worth a picker when there is a choice to make; a single tier is implicit. -->
          {#if cotisationTiers.length > 1}
            <div class="sm:w-56">
              <label
                for="add-cotisant-tier"
                class="text-text-muted mb-1 block text-xs font-semibold"
              >
                {m.asso_cotisations_add_tier_label()}
              </label>
              <select
                id="add-cotisant-tier"
                bind:value={addVariantKey}
                class="border-cn-border w-full rounded-xl border bg-(--cn-surface) px-3 py-2.5 text-sm"
              >
                {#each cotisationTiers as tier (tier.tagName)}
                  <option value={tier.variantKey ?? ''}>{tier.name}</option>
                {/each}
              </select>
            </div>
          {/if}
          <button
            type="submit"
            disabled={adding || !addUserId.trim()}
            class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover shrink-0 self-end rounded-xl px-5 py-2.5 text-sm font-bold disabled:opacity-50"
          >
            {adding ? m.common_saving_label() : m.common_add_button()}
          </button>
        </form>
        {#if addError}
          <p class="text-red-err text-sm">{addError}</p>
        {/if}
      {/if}
    </div>
  {/if}
</div>
