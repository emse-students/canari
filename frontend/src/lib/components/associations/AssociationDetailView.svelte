<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    getAssociationBySlug,
    listMembers,
    followAssociation,
    unfollowAssociation,
    getAssociationFollowStatus,
    hasPermissionFlag,
    ensureAssociationSuperAdmin,
    AssociationPermissionFlag,
    listAssociationProducts,
    listAssociationPartnerships,
    type Association,
    type AssociationMember,
    type AssociationProduct,
    type PartnershipCard,
  } from '$lib/associations/api';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import PartnershipCardList from '$lib/components/shop/PartnershipCardList.svelte';
  import CardTile from '$lib/components/shared/CardTile.svelte';
  import { productFallbackIcon } from '$lib/utils/cardIcons';
  import { generateAvatarColor } from '$lib/utils/avatar';
  import { currentUserId, isGlobalAdmin, isAssociationSuperAdmin } from '$lib/stores/user';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import {
    Bell,
    BellOff,
    Settings,
    Building2,
    CalendarDays,
    Users,
    ShoppingBag,
    Handshake,
    Download,
    Mail,
    ArrowLeft,
  } from '@lucide/svelte';
  import { exportTrombinoscope } from '$lib/utils/trombinoscope';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';
  import AssociationMemberRow from '$lib/components/associations/AssociationMemberRow.svelte';
  import AssociationCalendarSection from '$lib/components/associations/AssociationCalendarSection.svelte';
  import ProductPurchaseButton from '$lib/components/shop/ProductPurchaseButton.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** URL slug of the association or list to display. */
    slug: string;
    /** Controls back-links, labels, and canonical-URL enforcement. */
    kind?: 'association' | 'list';
  }

  let { slug, kind = 'association' }: Props = $props();

  /** Base path for the listing page this entity belongs to. */
  const basePath = $derived(kind === 'list' ? '/lists' : '/associations');
  const backLabel = $derived(
    kind === 'list' ? m.asso_back_to_lists() : m.asso_back_to_associations()
  );

  let asso = $state<Association | null>(null);
  let members = $state<AssociationMember[]>([]);
  let loading = $state(true);
  let error = $state('');
  let resolvedMemberNames = $state<Record<string, string>>({});

  /** Card accent color - the association's own, or a deterministic fallback when unset. */
  let cardAccentColor = $derived(asso ? (asso.color ?? generateAvatarColor(asso.name)) : null);

  let userId = $derived(currentUserId());
  let myMembership = $derived(members.find((m) => m.userId === userId));
  let canManage = $derived(
    isGlobalAdmin() || isAssociationSuperAdmin() || (!!myMembership && myMembership.isAdmin)
  );
  /** Whether the current user can propose / edit events (PROPOSE_EVENT flag or global admin). */
  let canProposeEvent = $derived(
    isGlobalAdmin() ||
      (!!myMembership &&
        hasPermissionFlag(myMembership.permissions ?? 0, AssociationPermissionFlag.PROPOSE_EVENT))
  );

  let following = $state(false);
  let followLoading = $state(false);
  let activeSection = $state<'about' | 'calendar' | 'members' | 'shop' | 'partnerships'>('about');
  let products = $state<AssociationProduct[]>([]);
  let partnerships = $state<PartnershipCard[]>([]);
  let shopCustomAmounts = $state<Record<string, number>>({});

  onMount(loadData);

  async function loadData() {
    loading = true;
    error = '';
    // Resolve cross-association super-admin status so the management entry appears
    // on associations the user does not belong to.
    void ensureAssociationSuperAdmin();
    try {
      const loaded = await getAssociationBySlug(slug);
      // Enforce canonical URL: lists live under /lists, associations under /associations.
      if (loaded.type === 'list' && kind !== 'list') {
        await goto(`/lists/${encodeURIComponent(slug)}`, { replaceState: true });
        return;
      }
      if (loaded.type !== 'list' && kind === 'list') {
        await goto(`/associations/${encodeURIComponent(slug)}`, { replaceState: true });
        return;
      }
      asso = loaded;
      [members, products, partnerships] = await Promise.all([
        listMembers(asso.id),
        listAssociationProducts(asso.id).catch(() => []),
        listAssociationPartnerships(asso.id).catch(() => []),
      ]);
      const names: Record<string, string> = {};
      for (const m of members) {
        names[m.userId] = m.displayName?.trim() || getUserDisplayNameSync(m.userId, m.userId);
      }
      resolvedMemberNames = names;
      for (const m of members) {
        if (!m.displayName?.trim()) {
          resolveUserDisplayName(m.userId).then((resolved) => {
            if (resolved) resolvedMemberNames = { ...resolvedMemberNames, [m.userId]: resolved };
          });
        }
      }
      const uid = currentUserId();
      if (uid) {
        try {
          const st = await getAssociationFollowStatus(asso.id);
          following = st.following;
        } catch {
          following = false;
        }
      } else {
        following = false;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : m.common_not_found();
    } finally {
      loading = false;
    }
  }

  let exportingPdf = $state(false);

  async function handleExportTrombinoscope() {
    if (!asso || exportingPdf) return;
    exportingPdf = true;
    try {
      await exportTrombinoscope(asso, members, resolvedMemberNames);
    } finally {
      exportingPdf = false;
    }
  }

  async function toggleFollow() {
    if (!asso || !userId) return;
    followLoading = true;
    try {
      if (following) {
        await unfollowAssociation(asso.id);
        following = false;
      } else {
        await followAssociation(asso.id);
        following = true;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Erreur';
    } finally {
      followLoading = false;
    }
  }
</script>

<div class="mx-auto max-w-4xl space-y-8 px-4 py-6 sm:px-6">
  <a
    href={basePath}
    class="text-text-muted hover:text-text-main inline-flex items-center gap-2 text-sm transition-colors"
  >
    <ArrowLeft size={16} />
    {backLabel}
  </a>

  {#if loading}
    <div class="flex items-center justify-center py-20">
      <div
        class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else if error && !asso}
    <div class="bg-red-err/10 border-red-err/30 text-red-err rounded-xl border p-4 text-sm">
      {error}
    </div>
  {:else if asso}
    <div class="border-cn-border rounded-2xl border bg-(--cn-surface)/90 p-6 shadow-sm">
      <div class="flex items-start gap-4">
        <div class="flex shrink-0 gap-2">
          <AssociationAvatar name={asso.name} logoUrl={asso.logoUrl} size="lg" />
          {#if kind === 'list' && asso.logoMediaId2}
            <AssociationAvatar
              name={asso.name2 ?? asso.name}
              logoUrl={`/api/media/public/${asso.logoMediaId2}`}
              size="lg"
            />
          {/if}
        </div>
        <div class="min-w-0 flex-1">
          <h1 class="text-text-main truncate text-xl font-extrabold tracking-tight">
            {asso.name}{#if kind === 'list' && asso.name2}<span class="text-text-muted font-bold">
                &amp; {asso.name2}</span
              >{/if}
          </h1>
          <p class="text-text-muted text-sm">
            {#if kind === 'list' && asso.parentName}<span class="text-text-main font-semibold"
                >{asso.parentName}</span
              > ·
            {/if}@{asso.slug} · {asso.memberCount ?? members.length} membre{(asso.memberCount ??
              members.length) !== 1
              ? 's'
              : ''}
            {#if kind === 'list' && asso.promo}
              · {m.list_campaigns_heading({ year: asso.promo })}
            {/if}
          </p>
        </div>
        <div class="flex shrink-0 flex-col items-stretch gap-2 sm:flex-row sm:items-center">
          {#if userId}
            <button
              type="button"
              onclick={() => toggleFollow()}
              disabled={followLoading}
              class="border-cn-border text-text-main flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-medium transition-colors hover:bg-(--cn-surface) disabled:opacity-50"
            >
              {#if following}
                <BellOff size={16} />
                {m.asso_unfollow_button()}
              {:else}
                <Bell size={16} />
                {m.asso_follow_button()}
              {/if}
            </button>
          {/if}
          {#if canManage}
            <a
              href="{basePath}/{encodeURIComponent(slug)}/edit"
              class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-sm font-bold transition-colors"
            >
              <Settings size={16} />
              {kind === 'list' ? m.asso_manage_list_button() : m.asso_manage_button()}
            </a>
          {/if}
        </div>
      </div>
    </div>

    {#if error}
      <div class="bg-red-err/10 border-red-err/30 text-red-err rounded-xl border p-4 text-sm">
        {error}
      </div>
    {/if}

    <nav
      class="border-cn-border/80 sticky top-0 z-30 -mx-4 border-y bg-(--cn-bg)/95 px-4 py-3 backdrop-blur-md sm:mx-0 sm:rounded-2xl sm:border"
      aria-label="Sections"
    >
      <div class="flex gap-2 overflow-x-auto pb-1" data-swipe-nav-ignore>
        <button
          type="button"
          onclick={() => (activeSection = 'about')}
          class="inline-flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
          {activeSection === 'about'
            ? 'bg-cn-yellow text-cn-ink shadow-sm'
            : 'border-cn-border text-text-muted hover:text-text-main border bg-(--cn-surface)'}"
        >
          <Building2 size={17} />
          {m.asso_tab_about()}
        </button>
        <button
          type="button"
          onclick={() => (activeSection = 'calendar')}
          class="inline-flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
          {activeSection === 'calendar'
            ? 'bg-cn-yellow text-cn-ink shadow-sm'
            : 'border-cn-border text-text-muted hover:text-text-main border bg-(--cn-surface)'}"
        >
          <CalendarDays size={17} />
          {m.asso_tab_calendar()}
        </button>
        <button
          type="button"
          onclick={() => (activeSection = 'members')}
          class="inline-flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
          {activeSection === 'members'
            ? 'bg-cn-yellow text-cn-ink shadow-sm'
            : 'border-cn-border text-text-muted hover:text-text-main border bg-(--cn-surface)'}"
        >
          <Users size={17} />
          {m.common_members_label()}
        </button>
        {#if products.length > 0}
          <button
            type="button"
            onclick={() => (activeSection = 'shop')}
            class="inline-flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {activeSection === 'shop'
              ? 'bg-cn-yellow text-cn-ink shadow-sm'
              : 'border-cn-border text-text-muted hover:text-text-main border bg-(--cn-surface)'}"
          >
            <ShoppingBag size={17} />
            {m.asso_tab_shop()}
          </button>
        {/if}
        {#if partnerships.length > 0}
          <button
            type="button"
            onclick={() => (activeSection = 'partnerships')}
            class="inline-flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {activeSection === 'partnerships'
              ? 'bg-cn-yellow text-cn-ink shadow-sm'
              : 'border-cn-border text-text-muted hover:text-text-main border bg-(--cn-surface)'}"
          >
            <Handshake size={17} />
            {m.asso_tab_partnerships()}
          </button>
        {/if}
      </div>
    </nav>

    {#if activeSection === 'about'}
      <div class="border-cn-border space-y-4 rounded-2xl border bg-(--cn-surface)/90 p-6 shadow-sm">
        <h2 class="text-text-main text-lg font-bold tracking-tight">{m.asso_tab_about()}</h2>
        {#if asso.description?.trim()}
          <ProfileBioMarkdown source={asso.description} class="text-sm" />
        {/if}
        {#if asso.bioMarkdown?.trim()}
          <ProfileBioMarkdown source={asso.bioMarkdown} />
        {:else if !asso.description?.trim()}
          <p class="text-text-muted text-sm">{m.asso_no_description()}</p>
        {/if}
        {#if asso.contactEmail?.trim()}
          <a
            href="mailto:{asso.contactEmail}"
            class="text-cn-dark inline-flex items-center gap-2 pt-1 text-sm font-semibold hover:underline"
          >
            <Mail size={15} />
            {asso.contactEmail}
          </a>
        {/if}
      </div>
    {:else if activeSection === 'calendar'}
      <div class="border-cn-border rounded-2xl border bg-(--cn-surface)/90 p-6 shadow-sm">
        <div class="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 class="text-text-main text-lg font-bold tracking-tight">{m.asso_tab_calendar()}</h2>
          <a
            href="/calendar?association={encodeURIComponent(asso.id)}"
            class="text-cn-dark text-xs font-semibold hover:underline"
          >
            {m.asso_view_global_calendar()}
          </a>
        </div>
        <AssociationCalendarSection
          associationId={asso.id}
          associationSlug={asso.slug}
          associationName={asso.name}
          associationLogoUrl={asso.logoUrl}
          canEdit={canProposeEvent}
          associationColor={asso.color ?? null}
        />
      </div>
    {:else if activeSection === 'members'}
      <div class="border-cn-border space-y-4 rounded-2xl border bg-(--cn-surface)/90 p-6 shadow-sm">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-text-main text-lg font-bold tracking-tight">
            {m.common_members_label()}
          </h2>
          {#if members.length > 0}
            <button
              type="button"
              onclick={handleExportTrombinoscope}
              disabled={exportingPdf}
              class="border-cn-border text-text-muted hover:text-text-main inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors hover:bg-(--cn-surface) disabled:opacity-50"
            >
              <Download size={14} />
              {exportingPdf ? m.common_generating_label() : m.asso_trombinoscope_button()}
            </button>
          {/if}
        </div>
        <p class="text-text-muted text-sm">
          {kind === 'list'
            ? m.asso_member_count_list({ count: members.length })
            : m.asso_member_count_association({ count: members.length })}
        </p>
        <div class="space-y-3">
          {#each members as member (member.id)}
            <AssociationMemberRow
              {member}
              displayName={resolvedMemberNames[member.userId] ??
                member.displayName ??
                getUserDisplayNameSync(member.userId)}
              isBDE={asso?.isBDE ?? false}
            />
          {/each}
        </div>
      </div>
    {:else if activeSection === 'shop'}
      <div class="border-cn-border space-y-4 rounded-2xl border bg-(--cn-surface)/90 p-6 shadow-sm">
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-text-main flex items-center gap-2 text-lg font-bold tracking-tight">
            <ShoppingBag size={20} />
            {m.asso_tab_shop()}
          </h2>
          <a href="/shop" class="text-cn-dark text-xs font-semibold hover:underline">
            {m.asso_view_all_shop()}
          </a>
        </div>
        <div class="grid gap-4 sm:grid-cols-2">
          {#each products as product (product.id)}
            <CardTile
              iconUrl={product.iconUrl}
              fallbackIcon={productFallbackIcon(product.type)}
              accentColor={cardAccentColor}
              badgeText={product.badgeText}
            >
              <div class="flex h-full flex-col gap-3 p-5">
                <div class="min-w-0 flex-1">
                  <p class="text-text-main text-sm font-semibold">{product.name}</p>
                  {#if product.description}
                    <p class="text-text-muted mt-0.5 text-xs">{product.description}</p>
                  {/if}
                  <p class="text-text-muted mt-1 text-xs">
                    {#if product.amountCents}
                      {(product.amountCents / 100).toFixed(2)} {product.currency.toUpperCase()}
                    {:else if product.allowCustomAmount}
                      {m.asso_product_custom_price()}
                    {:else}
                      {m.asso_product_free_price()}
                    {/if}
                    <span
                      class="bg-cn-border/40 ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase"
                    >
                      {product.type === 'membership'
                        ? m.asso_product_membership_type()
                        : product.type === 'balance_topup'
                          ? m.asso_product_topup_type()
                          : m.asso_product_other_type()}
                    </span>
                  </p>
                  {#if product.allowCustomAmount && product.amountCents === null}
                    <div class="mt-2 flex items-center gap-2">
                      <input
                        type="number"
                        min={product.customAmountMinCents != null
                          ? product.customAmountMinCents / 100
                          : 0}
                        max={product.customAmountMaxCents != null
                          ? product.customAmountMaxCents / 100
                          : undefined}
                        step="0.01"
                        placeholder={m.asso_product_amount_placeholder()}
                        class="border-cn-border text-text-main focus:ring-cn-accent flex-1 rounded-xl border bg-transparent px-3 py-2 text-sm focus:ring-2 focus:outline-none"
                        bind:value={shopCustomAmounts[product.id]}
                      />
                    </div>
                  {/if}
                </div>
                <ProductPurchaseButton
                  {product}
                  customAmountEuros={shopCustomAmounts[product.id]}
                  variant="yellow"
                  class="w-full"
                />
              </div>
            </CardTile>
          {/each}
        </div>
      </div>
    {:else if activeSection === 'partnerships'}
      <div class="border-cn-border space-y-4 rounded-2xl border bg-(--cn-surface)/90 p-6 shadow-sm">
        <h2 class="text-text-main flex items-center gap-2 text-lg font-bold tracking-tight">
          <Handshake size={20} />
          {m.asso_tab_partnerships()}
        </h2>
        <PartnershipCardList cards={partnerships} accentColor={cardAccentColor} />
      </div>
    {/if}
  {/if}
</div>
