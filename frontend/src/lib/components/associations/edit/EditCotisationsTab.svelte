<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    listCotisants,
    grantCotisant,
    exportCotisants,
    revokeAssociationTag,
    updateAssociation,
    listAssociationProductsForManage,
    updateProduct,
    type Association,
    type AssociationProduct,
    type CotisantRosterItem,
  } from '$lib/associations/api';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import UserAutocomplete from '$lib/components/shared/UserAutocomplete.svelte';
  import { HandCoins, Pencil, Search, Trash2, UserPlus, Download } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

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

  // ── Cotisation price (canonical membership product) ────────────────────────
  let membershipProduct = $state<AssociationProduct | null>(null);
  let membershipLoading = $state(false);
  let membershipError = $state('');
  let membershipSaving = $state(false);
  let membershipSaved = $state(false);
  let editMembershipName = $state('');
  let editMembershipPriceEuros = $state<number | ''>('');
  /** Tracks the last association we loaded the membership product for, to avoid refetch loops. */
  let membershipLoadedForAssoId: string | null = null;

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
    return name || item.userId.slice(0, 8) + '…';
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

  /** Loads the canonical membership product once per association, whenever cotisation is enabled. */
  $effect(() => {
    if (!asso.cotisationEnabled || !canManageProducts) return;
    if (membershipLoadedForAssoId === asso.id) return;
    membershipLoadedForAssoId = asso.id;
    void loadMembershipProduct();
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

  /** Fetches the association's products and picks the auto-provisioned canonical membership one. */
  async function loadMembershipProduct() {
    membershipLoading = true;
    membershipError = '';
    console.log(`[Cotisations] Loading membership product - asso=${asso.id.slice(0, 8)}`);
    try {
      const productsList = await listAssociationProductsForManage(asso.id);
      const found = productsList.find((p) => p.type === 'membership') ?? null;
      membershipProduct = found;
      if (found) {
        editMembershipName = found.name;
        editMembershipPriceEuros = found.amountCents != null ? found.amountCents / 100 : '';
      }
    } catch (e) {
      membershipError = e instanceof Error ? e.message : m.asso_cotisations_membership_load_error();
      console.error('[Cotisations] Failed to load membership product:', e);
    } finally {
      membershipLoading = false;
    }
  }

  /** Saves the cotisation's editable label and price onto the canonical membership product. */
  async function handleSaveMembership() {
    if (!membershipProduct || !editMembershipName.trim()) return;
    membershipSaving = true;
    membershipError = '';
    membershipSaved = false;
    console.log(
      `[Cotisations] Saving membership price - asso=${asso.id.slice(0, 8)} product=${membershipProduct.id.slice(0, 8)}`
    );
    try {
      const updated = await updateProduct(asso.id, membershipProduct.id, {
        name: editMembershipName.trim(),
        amountCents:
          editMembershipPriceEuros !== ''
            ? Math.round(Number(editMembershipPriceEuros) * 100)
            : null,
      });
      membershipProduct = updated;
      membershipSaved = true;
    } catch (e) {
      membershipError = e instanceof Error ? e.message : m.asso_cotisations_membership_save_error();
      console.error('[Cotisations] Failed to save membership price:', e);
    } finally {
      membershipSaving = false;
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
    console.log(`[Cotisations] Granting cotisant - asso=${asso.id.slice(0, 8)}`);
    try {
      await grantCotisant(asso.id, addUserId.trim());
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
  <div
    class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-1 shadow-sm"
  >
    <h2 class="text-lg font-bold text-text-main tracking-tight flex items-center gap-2">
      <HandCoins size={20} />
      {m.asso_cotisations_title()}
    </h2>
    <p class="text-sm text-text-muted">{m.asso_cotisations_subtitle()}</p>
  </div>

  {#if !asso.cotisationEnabled}
    {#if canManageProducts}
      <div
        class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-4 shadow-sm"
      >
        <div>
          <h3 class="text-sm font-bold text-text-main">{m.asso_cotisations_activate_title()}</h3>
          <p class="text-xs text-text-muted mt-1">{m.asso_cotisations_activate_desc()}</p>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1">
            <label for="activate-mode" class="text-xs font-semibold text-text-muted"
              >{m.asso_cotisations_mode_label()}</label
            >
            <select
              id="activate-mode"
              bind:value={activateMode}
              class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2.5 text-sm"
            >
              <option value="lifetime">{m.asso_cotisations_mode_lifetime()}</option>
              <option value="dated">{m.asso_cotisations_mode_dated()}</option>
            </select>
          </div>
          {#if activateMode === 'dated'}
            <p class="text-xs text-text-muted self-end pb-2.5">
              {m.asso_cotisations_dated_auto_hint()}
            </p>
          {/if}
        </div>
        {#if activateError}
          <p class="text-sm text-red-600">{activateError}</p>
        {/if}
        <button
          type="button"
          onclick={() => void handleActivate()}
          disabled={activating}
          class="rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
        >
          {activating ? m.common_saving_label() : m.asso_cotisations_activate_button()}
        </button>
      </div>
    {:else}
      <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 shadow-sm">
        <p class="text-sm font-semibold text-text-main">
          {m.asso_cotisations_disabled_no_perm_title()}
        </p>
        <p class="text-sm text-text-muted mt-1">{m.asso_cotisations_disabled_no_perm_desc()}</p>
      </div>
    {/if}
  {:else}
    <!-- Config summary -->
    <div
      class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-4 shadow-sm"
    >
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <h3 class="text-sm font-bold text-text-main">{m.asso_cotisations_config_title()}</h3>
        {#if canManageProducts && !editingConfig}
          <button
            type="button"
            onclick={startEditConfig}
            class="inline-flex items-center gap-1.5 rounded-lg border border-cn-border px-3 py-1.5 text-xs font-semibold text-text-muted hover:text-text-main hover:bg-cn-bg"
          >
            <Pencil size={14} />
            {m.asso_cotisations_config_edit_button()}
          </button>
        {/if}
      </div>

      {#if editingConfig}
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1">
            <label for="config-mode" class="text-xs font-semibold text-text-muted"
              >{m.asso_cotisations_mode_label()}</label
            >
            <select
              id="config-mode"
              bind:value={configMode}
              class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2.5 text-sm"
            >
              <option value="lifetime">{m.asso_cotisations_mode_lifetime()}</option>
              <option value="dated">{m.asso_cotisations_mode_dated()}</option>
            </select>
          </div>
          {#if configMode === 'dated'}
            <p class="text-xs text-text-muted self-end pb-2.5">
              {m.asso_cotisations_dated_auto_hint()}
            </p>
          {/if}
        </div>
        {#if configError}
          <p class="text-sm text-red-600">{configError}</p>
        {/if}
        <div class="flex gap-2">
          <button
            type="button"
            onclick={() => void handleSaveConfig()}
            disabled={configSaving}
            class="rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
          >
            {configSaving ? m.common_saving_label() : m.common_save_button()}
          </button>
          <button
            type="button"
            onclick={() => (editingConfig = false)}
            disabled={configSaving}
            class="rounded-xl border border-cn-border px-4 py-2 text-sm font-semibold text-text-muted hover:text-text-main"
          >
            {m.common_cancel_button()}
          </button>
        </div>
      {:else}
        <p class="text-sm text-text-main">
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
        <div class="border-t border-cn-border pt-4 space-y-3">
          <h4 class="text-xs font-bold text-text-main uppercase tracking-wide">
            {m.asso_cotisations_price_title()}
          </h4>
          {#if membershipLoading}
            <div class="flex items-center gap-2 text-sm text-text-muted">
              <div
                class="h-4 w-4 animate-spin rounded-full border-2 border-cn-yellow border-t-transparent"
              ></div>
              {m.common_loading_label()}
            </div>
          {:else if membershipError}
            <p class="text-sm text-red-600">{membershipError}</p>
          {:else if !membershipProduct}
            <p class="text-sm text-text-muted">{m.asso_cotisations_membership_missing()}</p>
          {:else}
            <form
              class="grid gap-3 sm:grid-cols-2"
              onsubmit={(e) => {
                e.preventDefault();
                void handleSaveMembership();
              }}
            >
              <div class="space-y-1">
                <label for="membership-name" class="text-xs font-semibold text-text-muted"
                  >{m.asso_cotisations_price_name_label()}</label
                >
                <input
                  id="membership-name"
                  type="text"
                  bind:value={editMembershipName}
                  required
                  class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                />
              </div>
              <div class="space-y-1">
                <label for="membership-price" class="text-xs font-semibold text-text-muted"
                  >{m.asso_cotisations_price_amount_label()}</label
                >
                <input
                  id="membership-price"
                  type="number"
                  min="0.01"
                  step="0.01"
                  bind:value={editMembershipPriceEuros}
                  placeholder="10.00"
                  class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm"
                />
              </div>
              <div class="sm:col-span-2 flex items-center gap-3">
                <button
                  type="submit"
                  disabled={membershipSaving || !editMembershipName.trim()}
                  class="rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
                >
                  {membershipSaving ? m.common_saving_label() : m.common_save_button()}
                </button>
                {#if membershipSaved}
                  <span class="text-xs font-semibold text-emerald-600"
                    >{m.common_saved_label()}</span
                  >
                {/if}
              </div>
            </form>
            {#if membershipProduct.amountCents == null}
              <p class="text-xs text-amber-700">{m.asso_cotisations_price_unset_hint()}</p>
            {/if}
          {/if}
        </div>
      {/if}
    </div>

    <!-- Roster -->
    <div
      class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-4 shadow-sm"
    >
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h3 class="text-sm font-bold text-text-main">{m.asso_cotisations_roster_title()}</h3>
        {#if canManageMembers}
          <button
            type="button"
            onclick={() => void handleExport()}
            disabled={exporting}
            class="inline-flex items-center gap-2 rounded-xl border border-cn-border px-4 py-2 text-sm font-semibold text-text-muted hover:text-text-main hover:bg-cn-bg disabled:opacity-50 shrink-0"
          >
            <Download size={15} />
            {exporting ? m.common_generating_label() : m.asso_cotisations_export_button()}
          </button>
        {/if}
      </div>
      {#if exportError}
        <p class="text-sm text-red-600">{exportError}</p>
      {/if}

      <div class="relative">
        <span class="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-text-muted">
          <Search size={15} />
        </span>
        <input
          type="text"
          bind:value={search}
          placeholder={m.asso_cotisations_search_placeholder()}
          class="w-full pl-9 pr-4 py-2.5 bg-[var(--cn-surface)] border border-cn-border rounded-xl text-sm outline-none focus:ring-2 focus:ring-amber-400/45 focus:border-amber-400/60"
        />
      </div>

      {#if rosterError}
        <div class="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">
          {rosterError}
        </div>
      {/if}

      {#if rosterLoading}
        <div class="flex justify-center py-8">
          <div
            class="h-6 w-6 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
          ></div>
        </div>
      {:else if rosterItems.length === 0}
        <p class="text-sm text-text-muted text-center py-8">{m.asso_cotisations_no_cotisants()}</p>
      {:else}
        <div class="space-y-4">
          {#each rosterGroups as group (group.promo ?? 'none')}
            <div class="space-y-2">
              <h4 class="text-xs font-bold uppercase tracking-wide text-text-muted">
                {group.promo != null
                  ? m.asso_cotisations_group_promo_label({ promo: group.promo })
                  : m.asso_cotisations_group_no_promo()}
              </h4>
              <ul class="space-y-2">
                {#each group.items as item (item.tagId)}
                  <li
                    class="flex items-center gap-3 rounded-xl border border-cn-border bg-cn-bg/40 px-4 py-3"
                  >
                    <div class="min-w-0 flex-1">
                      <p class="text-sm font-semibold text-text-main">{cotisantName(item)}</p>
                      <p class="text-xs text-text-muted mt-0.5">
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
                        class="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50"
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
              class="h-5 w-5 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
            ></div>
          </div>
        {/if}
        <p class="text-xs text-text-muted text-right">
          {m.asso_cotisations_total_label({ count: rosterTotal })}
        </p>
      {/if}

      {#if canManageMembers}
        <form
          class="border-t border-cn-border pt-4 flex flex-col sm:flex-row gap-3"
          onsubmit={(e) => {
            e.preventDefault();
            void handleAdd();
          }}
        >
          <div class="flex-1 min-w-0">
            <label for="add-cotisant-user" class="text-xs font-semibold text-text-muted block mb-1">
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
          <button
            type="submit"
            disabled={adding || !addUserId.trim()}
            class="self-end rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50 shrink-0"
          >
            {adding ? m.common_saving_label() : m.common_add_button()}
          </button>
        </form>
        {#if addError}
          <p class="text-sm text-red-600">{addError}</p>
        {/if}
      {/if}
    </div>
  {/if}
</div>
