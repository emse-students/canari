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
    type Association,
    type AssociationMember,
    type AssociationProduct,
  } from '$lib/associations/api';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
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
    Download,
    Mail,
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
  const backLabel = $derived(kind === 'list' ? m.asso_back_to_lists() : m.asso_back_to_associations());

  let asso = $state<Association | null>(null);
  let members = $state<AssociationMember[]>([]);
  let loading = $state(true);
  let error = $state('');
  let resolvedMemberNames = $state<Record<string, string>>({});

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
  let activeSection = $state<'about' | 'calendar' | 'members' | 'shop'>('about');
  let products = $state<AssociationProduct[]>([]);
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
      [members, products] = await Promise.all([
        listMembers(asso.id),
        listAssociationProducts(asso.id).catch(() => []),
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

<div class="px-4 py-6 sm:px-6 max-w-4xl mx-auto space-y-8">
  <a href={basePath} class="text-sm text-text-muted hover:text-text-main transition-colors">
    {backLabel}
  </a>

  {#if loading}
    <div class="flex items-center justify-center py-20">
      <div
        class="h-8 w-8 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
      ></div>
    </div>
  {:else if error && !asso}
    <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-4 text-sm">{error}</div>
  {:else if asso}
    <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 p-6 shadow-sm">
      <div class="flex items-start gap-4">
        <div class="flex gap-2 shrink-0">
          <AssociationAvatar name={asso.name} logoUrl={asso.logoUrl} size="lg" />
          {#if kind === 'list' && asso.logoMediaId2}
            <AssociationAvatar
              name={asso.name2 ?? asso.name}
              logoUrl={`/api/media/public/${asso.logoMediaId2}`}
              size="lg"
            />
          {/if}
        </div>
        <div class="flex-1 min-w-0">
          <h1 class="text-xl font-extrabold text-text-main tracking-tight truncate">
            {asso.name}{#if kind === 'list' && asso.name2}<span class="text-text-muted font-bold">
                &amp; {asso.name2}</span
              >{/if}
          </h1>
          <p class="text-sm text-text-muted">
            {#if kind === 'list' && asso.parentName}<span class="font-semibold text-text-main"
                >{asso.parentName}</span
              > · {/if}@{asso.slug} · {asso.memberCount ?? members.length} membre{(asso.memberCount ??
              members.length) !== 1
              ? 's'
              : ''}
            {#if kind === 'list' && asso.promo}
              · {m.list_campaigns_heading({ year: asso.promo })}
            {/if}
          </p>
        </div>
        <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 shrink-0">
          {#if userId}
            <button
              type="button"
              onclick={() => toggleFollow()}
              disabled={followLoading}
              class="flex items-center justify-center gap-1.5 rounded-xl border border-cn-border px-3 py-2 text-sm font-medium text-text-main hover:bg-[var(--cn-surface)] transition-colors disabled:opacity-50"
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
              class="inline-flex items-center justify-center gap-1.5 rounded-xl bg-cn-yellow px-3 py-2 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover transition-colors"
            >
              <Settings size={16} />
              {kind === 'list' ? m.asso_manage_list_button() : m.asso_manage_button()}
            </a>
          {/if}
        </div>
      </div>
    </div>

    {#if error}
      <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-4 text-sm">{error}</div>
    {/if}

    <nav
      class="sticky top-0 z-30 -mx-4 px-4 py-3 bg-[var(--cn-bg)]/95 backdrop-blur-md border-y border-cn-border/80 sm:border sm:rounded-2xl sm:mx-0"
      aria-label="Sections"
    >
      <div class="flex gap-2 overflow-x-auto pb-1" data-swipe-nav-ignore>
        <button
          type="button"
          onclick={() => (activeSection = 'about')}
          class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
          {activeSection === 'about'
            ? 'bg-cn-yellow text-cn-ink shadow-sm'
            : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
        >
          <Building2 size={17} />
          {m.asso_tab_about()}
        </button>
        <button
          type="button"
          onclick={() => (activeSection = 'calendar')}
          class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
          {activeSection === 'calendar'
            ? 'bg-cn-yellow text-cn-ink shadow-sm'
            : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
        >
          <CalendarDays size={17} />
          {m.asso_tab_calendar()}
        </button>
        <button
          type="button"
          onclick={() => (activeSection = 'members')}
          class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
          {activeSection === 'members'
            ? 'bg-cn-yellow text-cn-ink shadow-sm'
            : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
        >
          <Users size={17} />
          {m.common_members_label()}
        </button>
        {#if products.length > 0}
          <button
            type="button"
            onclick={() => (activeSection = 'shop')}
            class="inline-flex items-center gap-2 shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
            {activeSection === 'shop'
              ? 'bg-cn-yellow text-cn-ink shadow-sm'
              : 'border border-cn-border bg-[var(--cn-surface)] text-text-muted hover:text-text-main'}"
          >
            <ShoppingBag size={17} />
            {m.asso_tab_shop()}
          </button>
        {/if}
      </div>
    </nav>

    {#if activeSection === 'about'}
      <div
        class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 p-6 space-y-4 shadow-sm"
      >
        <h2 class="text-lg font-bold text-text-main tracking-tight">{m.asso_tab_about()}</h2>
        {#if asso.description?.trim()}
          <ProfileBioMarkdown source={asso.description} class="text-sm" />
        {/if}
        {#if asso.bioMarkdown?.trim()}
          <ProfileBioMarkdown source={asso.bioMarkdown} />
        {:else if !asso.description?.trim()}
          <p class="text-sm text-text-muted">{m.asso_no_description()}</p>
        {/if}
        {#if asso.contactEmail?.trim()}
          <a
            href="mailto:{asso.contactEmail}"
            class="inline-flex items-center gap-2 text-sm font-semibold text-cn-dark hover:underline pt-1"
          >
            <Mail size={15} />
            {asso.contactEmail}
          </a>
        {/if}
      </div>
    {:else if activeSection === 'calendar'}
      <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 p-6 shadow-sm">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
          <h2 class="text-lg font-bold text-text-main tracking-tight">{m.asso_tab_calendar()}</h2>
          <a
            href="/calendar?association={encodeURIComponent(asso.id)}"
            class="text-xs font-semibold text-cn-dark hover:underline"
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
      <div
        class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 p-6 space-y-4 shadow-sm"
      >
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-lg font-bold text-text-main tracking-tight">{m.common_members_label()}</h2>
          {#if members.length > 0}
            <button
              type="button"
              onclick={handleExportTrombinoscope}
              disabled={exportingPdf}
              class="inline-flex items-center gap-1.5 rounded-xl border border-cn-border px-3 py-2 text-xs font-semibold text-text-muted hover:text-text-main hover:bg-[var(--cn-surface)] transition-colors disabled:opacity-50"
            >
              <Download size={14} />
              {exportingPdf ? m.common_generating_label() : m.asso_trombinoscope_button()}
            </button>
          {/if}
        </div>
        <p class="text-sm text-text-muted">
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
                member.userId}
            />
          {/each}
        </div>
      </div>
    {:else if activeSection === 'shop'}
      <div
        class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 p-6 space-y-4 shadow-sm"
      >
        <div class="flex items-center justify-between gap-2">
          <h2 class="text-lg font-bold text-text-main tracking-tight flex items-center gap-2">
            <ShoppingBag size={20} />
            {m.asso_tab_shop()}
          </h2>
          <a href="/shop" class="text-xs font-semibold text-cn-dark hover:underline">
            {m.asso_view_all_shop()}
          </a>
        </div>
        <div class="space-y-3">
          {#each products as product (product.id)}
            <div class="flex items-start gap-4 rounded-xl border border-cn-border p-4">
              <div class="flex-1 min-w-0">
                <p class="text-sm font-semibold text-text-main">{product.name}</p>
                {#if product.description}
                  <p class="text-xs text-text-muted mt-0.5">{product.description}</p>
                {/if}
                <p class="text-xs text-text-muted mt-1">
                  {#if product.amountCents}
                    {(product.amountCents / 100).toFixed(2)} {product.currency.toUpperCase()}
                  {:else if product.allowCustomAmount}
                    {m.asso_product_custom_price()}
                  {:else}
                    {m.asso_product_free_price()}
                  {/if}
                  <span
                    class="ml-2 px-1.5 py-0.5 rounded-full bg-cn-border/40 text-[10px] font-bold uppercase"
                  >
                    {product.type === 'membership'
                      ? m.asso_product_membership_type()
                      : product.type === 'balance_topup'
                        ? m.asso_product_topup_type()
                        : m.asso_product_other_type()}
                  </span>
                </p>
                {#if product.allowCustomAmount && product.amountCents === null}
                  <div class="flex items-center gap-2 mt-2 max-w-xs">
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
                      class="flex-1 rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-cn-accent"
                      bind:value={shopCustomAmounts[product.id]}
                    />
                  </div>
                {/if}
              </div>
              <ProductPurchaseButton
                {product}
                customAmountEuros={shopCustomAmounts[product.id]}
                variant="yellow"
                class="shrink-0 text-xs px-3 py-2"
              />
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>
