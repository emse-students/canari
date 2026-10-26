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
    fetchCotisationOptions,
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
  import PriceGridEditor from '$lib/components/pricing/PriceGridEditor.svelte';
  import Picker from '$lib/components/ui/Picker.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';
  import {
    emptyMatrix,
    matrixOf,
    matrixPayload,
    matrixProblem,
    type PriceMatrix,
  } from '$lib/pricing/priceMatrix';
  import { gridProblemMessage } from '$lib/pricing/gridProblem';
  import {
    centsToEuros,
    eurosToCents,
    mayCreateTier,
    riseSourceTier,
    riseSources,
    singlePriceCents,
    tierPriceLabel,
    tiersInPriceOrder,
  } from '$lib/associations/cotisationTiers';
  import { formatAmount } from '$lib/forms/fillAnswers';
  import TierRiseEditor from './TierRiseEditor.svelte';
  import { fetchFormations, type FormationOption } from '$lib/pricing/criteriaOptions';
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
  /**
   * Whether this server derives a new tier's key from its label (`tierKeyFromLabel`). Read before
   * offering tier creation, never inferred: an older server would create a base tier instead.
   */
  let tierCreationSupported = $state(false);
  let addingTier = $state(false);
  let newTierName = $state('');
  let newTierPriceEuros = $state<number | ''>('');
  let newTierMemberPriceTag = $state('');
  let newTierMemberPriceEuros = $state<number | ''>('');

  let expandedTierId = $state<string | null>(null);
  /**
   * The expanded tier's form, one slot for the same reason as `editingMatrix` below. The tier's
   * key (`variantKey`) is not among them: it is a technical id fixed at creation, and editing the
   * label must never move the tier's cotisants to another tag.
   */
  let editingName = $state('');
  let editingPriceEuros = $state<number | ''>('');
  /** The source tier's tag of the expanded tier's preferential price; empty when there is none. */
  let editingUpgradeFromTag = $state('');
  let editingRiseEuros = $state<number | ''>('');

  /** The tiers in reading order, cheapest first - the order a rise is ranked by. */
  let orderedTiers = $derived(tiersInPriceOrder(tierProducts));
  let savingTierId = $state<string | null>(null);
  /** Which tier's on-sale switch is in flight, so only that row's control is disabled. */
  let togglingTierId = $state<string | null>(null);

  /**
   * The expanded tier's pricing grid, in EUROS, or null when it prices at one flat amount.
   *
   * One slot rather than one per tier because only one tier is ever expanded: a second copy would
   * be a second thing to keep in step with the row being edited.
   */
  let editingMatrix = $state<PriceMatrix | null>(null);
  /** Formation values in use, for the formation criterion's picker. Fetched once per tab. */
  let formations = $state<FormationOption[]>([]);
  let formationsLoaded = false;

  /** Blocks the save while the grid cannot be stored - the same codes the editor shows. */
  let gridProblem = $derived(matrixProblem(editingMatrix));

  /**
   * The tiers a `cotisation` criterion may discriminate on.
   *
   * Only offered when there are siblings: on a single-tier association the buyer of the one
   * cotisation is by definition not a cotisant yet, so the criterion would name an empty half of
   * the population and price nobody differently.
   */
  let gridTiers = $derived(tierProducts.map((p) => ({ variantKey: p.variantKey, name: p.name })));

  const modeOptions: PickerOption[] = [
    { value: 'lifetime', label: m.asso_cotisations_mode_lifetime() },
    { value: 'dated', label: m.asso_cotisations_mode_dated() },
  ];

  /** The one-line summary of a tier's preferential price, or null when it has none. */
  function riseSummary(product: AssociationProduct): string | null {
    if (!product.memberPriceTag || product.amountCentsMember == null) return null;
    const from =
      riseSourceTier(tierProducts, product.memberPriceTag)?.name ??
      m.asso_cotisations_rise_from_unknown();
    return m.asso_cotisations_rise_summary({ due: formatAmount(product.amountCentsMember), from });
  }

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
  const cotisationTierOptions = $derived<PickerOption[]>(
    cotisationTiers.map((t) => ({ value: t.variantKey ?? '', label: t.name }))
  );
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
      `[Cotisations] Loading roster - asso=${asso.id.slice(0, 8)} offset=${offset} searchChars=${search.length}`
    );
    try {
      const pageResult = await listCotisants(asso.id, { search, offset, limit: PAGE_SIZE });
      rosterItems = replace ? pageResult.items : [...rosterItems, ...pageResult.items];
      rosterTotal = pageResult.total;
      rosterHasMore = pageResult.hasMore;
    } catch (e) {
      rosterError = m.asso_cotisations_load_error();
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
      activateError = m.asso_cotisations_activate_error();
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
      configError = m.asso_cotisations_config_save_error();
      console.error('[Cotisations] Failed to save config:', e);
    } finally {
      configSaving = false;
    }
  }

  /** Fetches the association's products and keeps every tier (membership-type) product. */
  async function loadTierProducts() {
    tiersLoading = true;
    tiersError = '';
    console.log(`[Cotisations] Loading tier products - asso=${asso.id.slice(0, 8)}`);
    try {
      const [productsList, options] = await Promise.all([
        listAssociationProductsForManage(asso.id),
        // Unread options offer no creation, but must not hide the tiers that DID load.
        fetchCotisationOptions(asso.id).catch((e: unknown) => {
          console.error('[Cotisations] Failed to read cotisation options:', e);
          return null;
        }),
      ]);
      tierProducts = productsList.filter((p) => p.type === 'membership');
      tierCreationSupported = mayCreateTier(options);
      if (!tierCreationSupported) {
        console.warn(
          `[Cotisations] Tier creation not offered - asso=${asso.id.slice(0, 8)}: the server publishes no tierKeyFromLabel`
        );
      }
    } catch (e) {
      tiersError = m.asso_cotisations_membership_load_error();
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
    newTierPriceEuros = '';
    newTierMemberPriceTag = '';
    newTierMemberPriceEuros = '';
    showAddTierForm = false;
  }

  /**
   * Creates an additional cotisation tier (the base tier already exists once cotisation is
   * enabled). No key is sent: the server derives it from the label (`deriveVariantKey`), unique
   * among the association's tiers, and it never changes afterwards.
   */
  async function handleCreateTier() {
    if (!newTierName.trim()) return;
    addingTier = true;
    tiersError = '';
    const riseCents = newTierMemberPriceTag ? eurosToCents(newTierMemberPriceEuros) : null;
    console.log(
      `[Cotisations] Creating tier - asso=${asso.id.slice(0, 8)} rise=${riseCents !== null ? 'set' : 'none'}`
    );
    try {
      await createProduct(asso.id, {
        name: newTierName.trim(),
        type: 'membership',
        deriveVariantKey: true,
        amountCents: eurosToCents(newTierPriceEuros) ?? undefined,
        memberPriceTag: riseCents !== null ? newTierMemberPriceTag : undefined,
        amountCentsMember: riseCents ?? undefined,
      });
      resetAddTierForm();
      await Promise.all([loadTierProducts(), loadCotisationTiers()]);
    } catch (e) {
      tiersError = m.asso_cotisations_tier_create_error();
      console.error('[Cotisations] Failed to create tier:', e);
    } finally {
      addingTier = false;
    }
  }

  /**
   * Opens or closes a tier's editor, loading its grid in euros on the way in.
   *
   * The stored grid is in cents and the editor works in euros, like the forms one - `matrixOf` is
   * the single conversion, so no screen ever does the division itself.
   */
  function toggleTierEdit(product: AssociationProduct) {
    if (expandedTierId === product.id) {
      expandedTierId = null;
      editingMatrix = null;
      return;
    }
    expandedTierId = product.id;
    editingName = product.name;
    editingPriceEuros = centsToEuros(product.amountCents);
    editingUpgradeFromTag = product.memberPriceTag ?? '';
    editingRiseEuros = centsToEuros(product.amountCentsMember);
    editingMatrix = matrixOf(product.priceMatrix);
    void loadFormations();
  }

  /**
   * Formation values actually in use, for the criterion picker.
   *
   * Fetched once and only when a grid editor is opened: the formation vocabulary is open (a new
   * one arrives from Authentik with no deploy), so the picker offers what EXISTS rather than an
   * enum this repository would have to chase.
   */
  async function loadFormations() {
    if (formationsLoaded) return;
    formationsLoaded = true;
    try {
      formations = await fetchFormations();
    } catch (e) {
      // Not fatal: every other criterion still works, and the picker says it knows none.
      formationsLoaded = false;
      console.error('[Cotisations] Failed to load formations:', e);
    }
  }

  /**
   * Switches a tier between one flat price and a grid.
   *
   * Turning it on seeds the grid from the tier's CURRENT price, so flipping the switch changes
   * nothing anybody pays until a cell is actually edited. Turning it off drops the grid outright:
   * a kept-but-hidden grid is state nobody can see and the next manager would be surprised by.
   */
  function toggleTierGrid(product: AssociationProduct, on: boolean) {
    editingMatrix = on ? emptyMatrix((product.amountCents ?? 0) / 100) : null;
  }

  /**
   * Puts a tier on sale, or takes it off, without opening its editor.
   *
   * The server refuses to activate anything while the association cannot take payments, and that
   * refusal is the message shown here: a tier on sale with no payment account would list a
   * cotisation whose every checkout fails.
   */
  async function handleToggleTierActive(product: AssociationProduct) {
    togglingTierId = product.id;
    tiersError = '';
    try {
      const updated = await updateProduct(asso.id, product.id, { isActive: !product.isActive });
      tierProducts = tierProducts.map((p) => (p.id === product.id ? updated : p));
    } catch (e) {
      tiersError = m.asso_cotisations_tier_active_error();
      console.error('[Cotisations] Failed to toggle tier availability:', e);
    } finally {
      togglingTierId = null;
    }
  }

  /**
   * Saves a tier's label, price and preferential price for holders of another tier.
   *
   * The tier's key (`variantKey`) is never sent: it was derived from the label at creation and is
   * fixed, so renaming a forfait leaves its tag - and every cotisant holding it - where it is. A
   * preferential price is stored only as a complete pair (source tier AND amount); a half-filled
   * one is cleared, since the checkout would charge the full price for it anyway.
   */
  async function handleSaveTier(product: AssociationProduct) {
    const name = editingName.trim();
    if (!name) return;
    if (gridProblem) {
      tiersError = gridProblemMessage(gridProblem);
      return;
    }
    savingTierId = product.id;
    tiersError = '';
    try {
      // A grid replaces the fixed pricing, so the fields it replaces are cleared rather than left
      // behind: kept values would be dead state the server ignores and the next manager believes.
      const gridded = editingMatrix !== null;
      const riseCents = !gridded && editingUpgradeFromTag ? eurosToCents(editingRiseEuros) : null;
      console.log(
        `[Cotisations] Saving tier ${product.id.slice(0, 8)} - gridded=${gridded} rise=${riseCents !== null ? 'set' : 'none'}`
      );
      const updated = await updateProduct(asso.id, product.id, {
        name,
        priceMatrix: matrixPayload(editingMatrix) as PriceMatrix | null,
        amountCents: gridded ? null : eurosToCents(editingPriceEuros),
        memberPriceTag: riseCents !== null ? editingUpgradeFromTag : null,
        amountCentsMember: riseCents,
      });
      tierProducts = tierProducts.map((p) => (p.id === product.id ? updated : p));
      expandedTierId = null;
      editingMatrix = null;
      // The label is what the add picker and the roster's Forfait column show, so both are stale
      // after a rename until refetched.
      await Promise.all([loadCotisationTiers(), loadRoster(0, true)]);
    } catch (e) {
      tiersError = m.asso_cotisations_membership_save_error();
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
      tiersError = m.asso_cotisations_tier_delete_error();
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
      rosterError = m.asso_cotisations_tier_change_error();
      console.error('[Cotisations] Failed to switch tier:', e);
      // Redraw the picker on the tier actually held - the change never happened.
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
      rosterError = m.asso_cotisations_load_error();
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
      addError = m.asso_cotisations_add_error();
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
      exportError = m.asso_cotisations_export_error();
      console.error('[Cotisations] Failed to export roster:', e);
    } finally {
      exporting = false;
    }
  }
</script>

<div class="space-y-6">
  <div class="border-cn-border bg-cn-surface space-y-1 rounded-2xl border p-6 shadow-sm">
    <h2 class="text-text-main flex items-center gap-2 text-lg font-bold tracking-tight">
      <HandCoins size={20} />
      {m.asso_cotisations_title()}
    </h2>
    <p class="text-text-muted text-sm">{m.asso_cotisations_subtitle()}</p>
  </div>

  {#if !asso.cotisationEnabled}
    {#if canManageProducts}
      <div class="border-cn-border bg-cn-surface space-y-4 rounded-2xl border p-6 shadow-sm">
        <div>
          <h3 class="text-text-main text-sm font-bold">{m.asso_cotisations_activate_title()}</h3>
          <p class="text-text-muted mt-1 text-xs">{m.asso_cotisations_activate_desc()}</p>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1">
            <label for="activate-mode" class="text-text-muted text-xs font-semibold"
              >{m.asso_cotisations_mode_label()}</label
            >
            <Picker
              id="activate-mode"
              value={activateMode}
              options={modeOptions}
              onValueChange={(v) => (activateMode = v as 'lifetime' | 'dated')}
              label={m.asso_cotisations_mode_label()}
              variant="field"
              density="compact"
            />
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
      <div class="border-cn-border bg-cn-surface rounded-2xl border p-6 shadow-sm">
        <p class="text-text-main text-sm font-semibold">
          {m.asso_cotisations_disabled_no_perm_title()}
        </p>
        <p class="text-text-muted mt-1 text-sm">{m.asso_cotisations_disabled_no_perm_desc()}</p>
      </div>
    {/if}
  {:else}
    <!-- Config summary -->
    <div class="border-cn-border bg-cn-surface space-y-4 rounded-2xl border p-6 shadow-sm">
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
            <Picker
              id="config-mode"
              value={configMode}
              options={modeOptions}
              onValueChange={(v) => (configMode = v as 'lifetime' | 'dated')}
              label={m.asso_cotisations_mode_label()}
              variant="field"
              density="compact"
            />
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
            <div>
              <h4 class="text-text-main text-xs font-bold tracking-wide uppercase">
                {m.asso_cotisations_price_title()}
              </h4>
              {#if tierProducts.length > 1}
                <p class="text-text-muted mt-0.5 text-xs">{m.asso_cotisations_tier_order_hint()}</p>
              {/if}
            </div>
            {#if !tiersLoading && tierProducts.length > 0 && tierCreationSupported}
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
              {#each orderedTiers as product, rank (product.id)}
                {@const rise = product.priceMatrix ? null : riseSummary(product)}
                <li class="border-cn-border/70 bg-cn-bg overflow-hidden rounded-xl border">
                  <div class="flex items-center gap-3 px-4 py-3">
                    <!-- The tier's place in the reading order, cheapest first. -->
                    {#if orderedTiers.length > 1}
                      <span
                        class="bg-cn-surface-alt text-text-muted flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums"
                        aria-label={m.asso_cotisations_tier_rank_aria({
                          rank: rank + 1,
                          count: orderedTiers.length,
                        })}
                      >
                        {rank + 1}
                      </span>
                    {/if}
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <p class="text-text-main text-sm font-semibold">{product.name}</p>
                        {#if product.variantKey === null && tierProducts.length > 1}
                          <span
                            class="bg-cn-surface-alt text-text-muted rounded-full px-2 py-0.5 text-xs font-semibold"
                          >
                            {m.asso_cotisations_tier_base_badge()}
                          </span>
                        {/if}
                      </div>
                      <p class="text-text-muted mt-0.5 text-xs">
                        {#if product.priceMatrix}
                          {m.asso_cotisations_tier_grid_summary()}
                        {:else}
                          {tierPriceLabel(singlePriceCents(product))}
                          {#if rise}
                            · {rise}
                          {/if}
                        {/if}
                      </p>
                      <!--
                        A tier that is not on sale is invisible in the boutique and refused at
                        checkout, so the row has to SAY so - the whole BDE cotisation sat in that
                        state for as long as it existed, with no screen able to report it.
                      -->
                      {#if !product.isActive}
                        <p class="text-amber-warn mt-1 text-xs font-semibold">
                          {product.activationWithheld
                            ? m.asso_cotisations_tier_withheld_hint()
                            : m.asso_cotisations_tier_off_sale_hint()}
                        </p>
                      {/if}
                    </div>
                    <div class="flex shrink-0 items-center gap-2">
                      <label
                        class="flex cursor-pointer items-center gap-2 text-xs font-semibold"
                        title={m.asso_cotisations_tier_active_hint()}
                      >
                        <input
                          type="checkbox"
                          checked={product.isActive}
                          disabled={togglingTierId === product.id}
                          onchange={() => void handleToggleTierActive(product)}
                          class="accent-cn-yellow size-4"
                        />
                        <span class={product.isActive ? 'text-text-main' : 'text-text-muted'}>
                          {m.asso_cotisations_tier_active_label()}
                        </span>
                      </label>
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
                          class="ui-icon-button border-red-err/30 bg-red-err/10 text-red-err hover:bg-red-err/20 rounded-xl border transition-colors"
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
                          void handleSaveTier(product);
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
                            type="text"
                            bind:value={editingName}
                            required
                            class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
                          />
                        </div>
                        <!--
                          Hidden while a grid is on, and not merely ignored: a price field still
                          showing a figure nothing charges is the kind of dead state a manager
                          reads as the truth.
                        -->
                        {#if editingMatrix === null}
                          <div class="space-y-1">
                            <label
                              for="tier-price-{product.id}"
                              class="text-text-muted text-xs font-semibold"
                              >{m.asso_cotisations_price_amount_label()}</label
                            >
                            <input
                              id="tier-price-{product.id}"
                              type="number"
                              min="0.01"
                              step="0.01"
                              inputmode="decimal"
                              bind:value={editingPriceEuros}
                              placeholder="10.00"
                              class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
                            />
                          </div>
                        {/if}
                        <!--
                          A holder of another tier pays in FULL unless this is set: the editor says
                          so in words, and previews what the member will read.
                        -->
                        {#if tierProducts.length > 1 && editingMatrix === null}
                          <div class="sm:col-span-2">
                            <TierRiseEditor
                              idPrefix="tier-{product.id}"
                              toName={editingName.trim() || product.name}
                              fullCents={eurosToCents(editingPriceEuros)}
                              sources={riseSources(tierProducts, product.id)}
                              bind:fromTag={editingUpgradeFromTag}
                              bind:riseEuros={editingRiseEuros}
                            />
                          </div>
                        {/if}
                        <div class="space-y-3 sm:col-span-2">
                          <label class="flex cursor-pointer items-start gap-2">
                            <input
                              type="checkbox"
                              checked={editingMatrix !== null}
                              onchange={(e) => toggleTierGrid(product, e.currentTarget.checked)}
                              class="accent-cn-yellow mt-0.5 size-4"
                            />
                            <span>
                              <span class="text-text-main block text-xs font-semibold">
                                {m.asso_cotisations_tier_grid_toggle_label()}
                              </span>
                              <span class="text-text-muted block text-xs">
                                {m.asso_cotisations_tier_grid_toggle_hint()}
                              </span>
                            </span>
                          </label>
                          {#if editingMatrix !== null}
                            <!--
                              The same editor the forms use, and deliberately so: one grid, one
                              validator, one resolution. `items` is empty because a product has no
                              questions to price on, and the cotisation criterion needs siblings to
                              tell apart.
                            -->
                            <PriceGridEditor
                              bind:matrix={editingMatrix}
                              basePrice={(product.amountCents ?? 0) / 100}
                              tiers={gridTiers}
                              {formations}
                              items={[]}
                              hasCotisation={tierProducts.length > 1}
                            />
                          {/if}
                        </div>
                        <button
                          type="submit"
                          disabled={savingTierId === product.id || gridProblem !== null}
                          class="bg-cn-yellow text-cn-ink w-fit rounded-lg px-4 py-2 text-xs font-bold disabled:opacity-50 sm:col-span-2"
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

          {#if !tiersLoading && tierProducts.length > 0 && !tierCreationSupported}
            <p class="text-text-muted text-xs">{m.asso_cotisations_tier_add_unavailable()}</p>
          {:else if showAddTierForm}
            <form
              class="border-cn-border bg-cn-bg space-y-3 rounded-xl border p-4"
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
                    placeholder={m.asso_cotisations_tier_new_name_placeholder()}
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
                    inputmode="decimal"
                    bind:value={newTierPriceEuros}
                    placeholder="10.00"
                    class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <TierRiseEditor
                idPrefix="new-tier"
                toName={newTierName.trim() || m.asso_cotisations_rise_this_tier()}
                fullCents={eurosToCents(newTierPriceEuros)}
                sources={riseSources(tierProducts)}
                bind:fromTag={newTierMemberPriceTag}
                bind:riseEuros={newTierMemberPriceEuros}
              />
              <div class="flex items-center gap-3 pt-1">
                <button
                  type="submit"
                  disabled={addingTier || !newTierName.trim()}
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
    <div class="border-cn-border bg-cn-surface space-y-4 rounded-2xl border p-6 shadow-sm">
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
                    class="border-cn-border bg-cn-bg flex items-center gap-3 rounded-xl border px-4 py-3"
                  >
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <p class="text-text-main text-sm font-semibold">{cotisantName(item)}</p>
                        <!-- Multi-tier: the badge becomes a picker, so a forfait can be upgraded
                             or downgraded in place (the server swaps the tags atomically). -->
                        {#if canManageMembers && cotisationTiers.length > 1}
                          <Picker
                            value={currentVariantKey(item)}
                            options={cotisationTierOptions}
                            onValueChange={(v) => void handleChangeTier(item, v)}
                            label={m.asso_cotisations_tier_change_label()}
                            disabled={switchingTagId !== null}
                            triggerClass="border-amber-warn/40 bg-amber-warn/15 text-amber-warn flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold disabled:opacity-50"
                          >
                            {#snippet trigger(selected)}
                              <span class="truncate">{selected?.label ?? item.tier}</span>
                              <ChevronDown size={12} strokeWidth={2.5} class="shrink-0" />
                            {/snippet}
                          </Picker>
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
              <Picker
                id="add-cotisant-tier"
                value={addVariantKey}
                options={cotisationTierOptions}
                onValueChange={(v) => (addVariantKey = v)}
                label={m.asso_cotisations_add_tier_label()}
                variant="field"
                density="compact"
              />
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
