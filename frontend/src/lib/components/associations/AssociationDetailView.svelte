<script lang="ts">
  import { resolve } from '$app/paths';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { Log } from '$lib/utils/Log';
  import { goto } from '$app/navigation';
  import {
    getAssociationBySlug,
    listMembers,
    followAssociation,
    unfollowAssociation,
    getAssociationFollowStatus,
    getAssociationPushMuteStatus,
    muteAssociationPush,
    unmuteAssociationPush,
    hasPermissionFlag,
    getMyBdeReach,
    type BdeReach,
    AssociationPermissionFlag,
    listAssociationProducts,
    listAssociationPartnerships,
    associationSecondLogoSrc,
    type Association,
    type AssociationMember,
    type AssociationProduct,
    type PartnershipCard,
  } from '$lib/associations/api';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import { PAGE_WIDTHS, type PageWidth } from '$lib/components/layout/pageWidth';
  import PartnershipCardList from '$lib/components/shop/PartnershipCardList.svelte';
  import CardTile from '$lib/components/shared/CardTile.svelte';
  import { CARD_GRID } from '$lib/components/layout/cardGrid';
  import { productFallbackIcon } from '$lib/utils/cardIcons';
  import { associationAccent } from '$lib/associations/accent';
  import { currentUserId, isGlobalAdmin } from '$lib/stores/user';
  import { resolveUserDisplayName, rosterDisplayName } from '$lib/utils/users/displayName';
  import {
    Bell,
    BellOff,
    Volume2,
    VolumeX,
    Settings,
    CalendarDays,
    Users,
    ShoppingBag,
    Handshake,
    Download,
    Mail,
  } from '@lucide/svelte';
  import Breadcrumb from '$lib/components/navigation/Breadcrumb.svelte';
  import SectionHub from '$lib/components/navigation/SectionHub.svelte';
  import type { HubRow } from '$lib/components/navigation/breadcrumb';
  import {
    mayOpenPublicSection,
    parsePublicSection,
    publicSectionHref,
    publicSectionWidth,
    publicTrail,
    visiblePublicSections,
    type PublicBase,
    type PublicSection,
  } from '$lib/associations/publicSections';
  import { exportTrombinoscope } from '$lib/utils/trombinoscope';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';
  import AssociationMemberRow from '$lib/components/associations/AssociationMemberRow.svelte';
  import AssociationCalendarSection from '$lib/components/associations/AssociationCalendarSection.svelte';
  import ProductPurchaseButton from '$lib/components/shop/ProductPurchaseButton.svelte';
  import { gridPriceIsProvisional, gridPriceLabel, gridRefuses } from '$lib/pricing/viewerPrice';
  import { m } from '$lib/paraglide/messages';
  import { wordingFor } from '$lib/associations/kindWording';

  interface Props {
    /** URL slug of the association or list to display. */
    slug: string;
    /** Controls back-links, labels, and canonical-URL enforcement. */
    kind?: 'association' | 'list';
  }

  let { slug, kind = 'association' }: Props = $props();

  let asso = $state<Association | null>(null);
  let members = $state<AssociationMember[]>([]);
  let loading = $state(true);
  let error = $state('');
  let resolvedMemberNames = $state<Record<string, string>>({});

  /** Card accent color - the association's own, or a deterministic fallback when unset. */
  let cardAccentColor = $derived(asso ? associationAccent(asso) : null);

  /**
   * A LIST'S SECOND THEME - the campaign identity it runs beside its public one.
   *
   * Either half may exist without the other (renamed before the logo is uploaded, or the reverse),
   * so the block is drawn when EITHER is present and the avatar falls back to the main name for its
   * initials - never for the LABEL, which would print the same name twice. Same rule, same helper
   * and same subordinate rendering as `AssociationTile`, which is where the decision was taken.
   */
  const secondName = $derived(kind === 'list' ? (asso?.name2?.trim() ?? '') : '');
  const secondLogoUrl = $derived(
    kind === 'list' ? associationSecondLogoSrc(asso?.logoMediaId2) : null
  );
  const hasSecondTheme = $derived(Boolean(secondName) || Boolean(secondLogoUrl));

  let userId = $derived(currentUserId());
  let myMembership = $derived(members.find((m) => m.userId === userId));
  /**
   * The associations whose BDE grants the viewer a scoped power - the server's own answer. A BDE
   * governs the associations reaching its spaces, not every association (WP6c step 2), so the two
   * BDE-derived controls below read THIS association out of it.
   */
  let bdeReach = $state<BdeReach>({ validateEvents: [], manageAsso: [] });
  let canManage = $derived(
    isGlobalAdmin() ||
      (!!asso && bdeReach.manageAsso.includes(asso.id)) ||
      (!!myMembership && myMembership.isAdmin)
  );
  /** Whether the current user can propose / edit events (PROPOSE_EVENT flag or global admin). */
  let canProposeEvent = $derived(
    isGlobalAdmin() ||
      (!!myMembership &&
        hasPermissionFlag(myMembership.permissions ?? 0, AssociationPermissionFlag.PROPOSE_EVENT))
  );
  /**
   * Whether the current user may declare a school-wide `break` band. The client mirror of the
   * server's `assertMayDecideKind`: a band is a statement about the school, so the control belongs
   * to the authority that speaks for it, and nobody else is offered a field the API will refuse.
   */
  let canDeclareBreak = $derived(
    isGlobalAdmin() || (!!asso && bdeReach.validateEvents.includes(asso.id))
  );

  let following = $state(false);
  let followLoading = $state(false);
  /** The viewer's push mute of THIS association: its pushes only, never the feed or the follow. */
  let pushMuted = $state(false);
  let muteLoading = $state(false);
  /**
   * The open section is a ROUTE segment (`/associations/<slug>/<section>`), never local state: Back
   * goes up one level, a reload keeps the place and a link can be shared. `null` is the hub. A post's
   * "see the event" link (`?section=calendar&fromPost=`) is redirected to the segment by `+page.ts`;
   * `AssociationCalendarSection` still reads `?fromPost=` for the event within it.
   */
  let activeSection = $derived<PublicSection | null>(
    parsePublicSection((page.params as Record<string, string | undefined>).section)
  );

  /**
   * THE WIDTH FOLLOWS THE SECTION, BECAUSE THIS PAGE IS SEVERAL PAGES (user, 2026-09-14: *"les pages
   * doivent utiliser l'espace disponible"*): the reasoning is on `publicSectionWidth`.
   */
  const sectionWidth = $derived<PageWidth>(publicSectionWidth(activeSection));
  let products = $state<AssociationProduct[]>([]);
  let partnerships = $state<PartnershipCard[]>([]);
  let shopCustomAmounts = $state<Record<string, number>>({});

  /** What decides which conditional sections exist: ONE rule, shared by the hub and the route guard. */
  const content = $derived({
    productCount: products.length,
    partnershipCount: partnerships.length,
  });
  const base = $derived<PublicBase>(kind === 'list' ? '/lists' : '/associations');
  const words = $derived(wordingFor(kind));

  const SECTION_ICONS: Record<PublicSection, HubRow['icon']> = {
    calendar: CalendarDays,
    members: Users,
    shop: ShoppingBag,
    partnerships: Handshake,
  };

  /** The localized name of a section; a message must be read at render time, hence a function. */
  function sectionLabel(section: PublicSection): string {
    switch (section) {
      case 'calendar':
        return m.asso_tab_calendar();
      case 'members':
        return m.common_members_label();
      case 'shop':
        return m.asso_tab_shop();
      case 'partnerships':
        return m.asso_tab_partnerships();
    }
  }

  /** The path to this page (see `publicTrail`); every crumb is a link. */
  const crumbs = $derived(
    publicTrail(base, slug, activeSection, {
      directory: words.directoryLabel(),
      directoryHref: words.directoryHref,
      asso: asso?.name,
      section: activeSection ? sectionLabel(activeSection) : undefined,
    })
  );

  /** One hub row per section that exists; a count only where the roster already has it. */
  const hubRows = $derived(
    visiblePublicSections(content).map((section): HubRow => ({
      key: section,
      href: publicSectionHref(base, slug, section),
      label: sectionLabel(section),
      icon: SECTION_ICONS[section],
      summary:
        section === 'members'
          ? kind === 'list'
            ? m.asso_member_count_list({ count: members.length })
            : m.asso_member_count_association({ count: members.length })
          : undefined,
    }))
  );

  /**
   * Whether the requested section may be DRAWN: a typed `/shop` on an association with nothing to
   * sell is refused here, in the same render that knows the content, so the empty card never
   * flashes before the effect below sends the reader to the hub.
   */
  const sectionRefused = $derived(
    activeSection !== null && !loading && !!asso && !mayOpenPublicSection(activeSection, content)
  );

  // A segment is user input: once the page is loaded, a section that does not exist for it (a shop
  // with nothing to sell) is replaced by the hub rather than drawn empty.
  $effect(() => {
    if (loading || !asso || !activeSection) return;
    if (!mayOpenPublicSection(activeSection, content)) {
      Log.d('AssociationDetailView: section refused, back to the hub', activeSection);
      void goto(resolve(publicSectionHref(base, slug)), { replaceState: true });
    }
  });

  onMount(loadData);

  async function loadData() {
    loading = true;
    error = '';
    // Resolve the BDE reach so the management entry appears on associations the user does not
    // belong to but whose BDE they sit in, and so the `break` control appears for that BDE's
    // validators. Not awaited: the page is the association, not these two controls.
    void getMyBdeReach().then((reach) => (bdeReach = reach));
    try {
      const loaded = await getAssociationBySlug(slug);
      // Enforce canonical URL: lists live under /lists, associations under /associations.
      if (loaded.type === 'list' && kind !== 'list') {
        await goto(resolve(publicSectionHref('/lists', slug, activeSection)), {
          replaceState: true,
        });
        return;
      }
      if (loaded.type !== 'list' && kind === 'list') {
        await goto(resolve(publicSectionHref('/associations', slug, activeSection)), {
          replaceState: true,
        });
        return;
      }
      asso = loaded;
      // THE FOLLOW STATUS JOINS THE BATCH RATHER THAN FOLLOWING IT. It used to be a FOURTH round
      // trip, awaited after these three had all come back, and all it decides is whether one
      // button reads "Suivre" or "Ne plus suivre" - so on a bad link the whole page sat finished
      // behind a label.
      const uid = currentUserId();
      let followStatus: { following: boolean };
      let muteStatus: { muted: boolean };
      [members, products, partnerships, followStatus, muteStatus] = await Promise.all([
        listMembers(asso.id),
        listAssociationProducts(asso.id).catch(() => []),
        listAssociationPartnerships(asso.id).catch(() => []),
        uid
          ? getAssociationFollowStatus(asso.id).catch(() => ({ following: false }))
          : Promise.resolve({ following: false }),
        uid
          ? getAssociationPushMuteStatus(asso.id).catch(() => ({ muted: false }))
          : Promise.resolve({ muted: false }),
      ]);
      following = followStatus.following;
      pushMuted = muteStatus.muted;
      const names: Record<string, string> = {};
      for (const m of members) {
        names[m.userId] = rosterDisplayName(m);
      }
      resolvedMemberNames = names;
      for (const m of members) {
        if (!m.displayName?.trim()) {
          resolveUserDisplayName(m.userId).then((resolved) => {
            if (resolved) resolvedMemberNames = { ...resolvedMemberNames, [m.userId]: resolved };
          });
        }
      }
    } catch (err) {
      error = m.common_not_found();
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
    // Same rule as the profile's follow button: the state is local, so it moves on the tap and
    // goes back if the write is refused.
    const wasFollowing = following;
    following = !wasFollowing;
    followLoading = true;
    try {
      if (wasFollowing) await unfollowAssociation(asso.id);
      else await followAssociation(asso.id);
    } catch (err) {
      Log.d('AssociationDetailView.toggleFollow failed', err);
      following = wasFollowing;
      error = m.common_generic_error_label();
    } finally {
      followLoading = false;
    }
  }

  async function togglePushMute() {
    if (!asso || !userId) return;
    // Optimistic like the follow button above: back on a refused write.
    const wasMuted = pushMuted;
    pushMuted = !wasMuted;
    muteLoading = true;
    try {
      if (wasMuted) await unmuteAssociationPush(asso.id);
      else await muteAssociationPush(asso.id);
    } catch (err) {
      Log.d('AssociationDetailView.togglePushMute failed', err);
      pushMuted = wasMuted;
      error = m.common_generic_error_label();
    } finally {
      muteLoading = false;
    }
  }
</script>

<!--
  THE PAGE COLUMN IS DECLARED, NOT INVENTED. This was `mx-auto max-w-4xl` - 896px, a FOURTH width
  outside the three in `pageWidth.ts`, and the same number `admin/+layout.svelte` was caught
  carrying on 2026-09-10. The 52-route sweep that found that one could not find this one: it read
  ROUTES, and `/associations/[slug]` and `/lists/[slug]` are eight-line files that render THIS
  component, so the width was one level below everything the sweep looked at. A count of routes is
  not a count of page columns.

  Which of the three it is now follows the TAB, and the reasoning is on `sectionWidth` above: the
  page is five pages behind a tab bar and a single column fitted none of them. The prose inside is
  capped to the reading measure by its own container, so widening the page never lengthens a line
  of text - which is why the widening is free and the capping was not.
-->
<PageContainer width={sectionWidth} class="space-y-8">
  <!--
    THE PATH, NOT A BACK LINK (user, 2026-10-08: "on navigue en profondeur"): directory > the
    entity > the open section, every crumb a link, the arrow going up ONE level.
  -->
  <Breadcrumb {crumbs} />

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
    <!--
      THE IDENTITY CARD BELONGS TO THE HUB. Inside a section the path already names the entity, and
      repeating a 150px card above a month or a card wall pushed the content under the fold.
    -->
    {#if activeSection === null}
      <div class="border-cn-border bg-cn-surface rounded-2xl border p-6 shadow-sm">
        <!--
        THE HEADER WRAPS, AND THE NAME IS NO LONGER CUT. Three children sat in one non-wrapping row
        - an avatar and an action group both `shrink-0`, with `min-w-0 flex-1` between them - so on
        a phone the name got whatever was left, and `truncate` then hid the overflow. That is the
        same defect the association TILES had, in the page that exists to show the name.

        `flex-wrap` with the action group pushed to its own line below `sm` gives the name the full
        width before anything is dropped, and the `truncate` goes with it: a long name wraps onto a
        second line instead of ending in an ellipsis.
      -->
        <div class="flex flex-wrap items-start gap-4">
          <AssociationAvatar name={asso.name} logoUrl={asso.logoUrl} size="lg" />
          <div class="min-w-0 flex-1 basis-64">
            <h1 class="text-text-main text-xl font-bold tracking-tight [overflow-wrap:anywhere]">
              {asso.name}
            </h1>
            <!--
            THE META LINE IS A FLEX ROW, NOT A RUN OF TEXT, and the separators are its children.
            Written as prose it read `{/if}@{asso.slug}`, and Svelte TRIMS the whitespace at the end
            of an `{#if}` block - so the space that was supposed to follow the middot never reached
            the DOM and production showed `BDE - Bureau des Eleves ·@minestagnard`. Spacing carried
            by `gap-*` cannot be trimmed by a compiler, which is the whole reason for the shape.

            NO MEMBER COUNT (user, 2026-09-23). The members tab states it, and on a list it printed
            "0 membre" for a campaign whose roster is simply not registered yet.
          -->
            <p class="text-text-muted flex flex-wrap items-center gap-x-1.5 text-xs">
              {#if kind === 'list' && asso.parentName}
                <span class="text-text-main font-semibold">{asso.parentName}</span>
                <span aria-hidden="true">&#183;</span>
              {/if}
              <span>@{asso.slug}</span>
            </p>
            <!--
            THE SECOND LOGO SITS WITH THE SECOND NAME, not with the first (user, 2026-09-23: *"ce
            n'est pas logique d'avoir logo1 puis titre1 et titre2 puis logo2"*). Both logos used to
            share one row at `lg` while both names shared the `<h1>`, so the pairing a reader had to
            make crossed over itself. This is the subordinate row `AssociationTile` already draws -
            the `sm` avatar under the main one - so the two surfaces state the same thing the same
            way, and `& ` in front of a name (whose leading space Svelte also trimmed, giving
            `Mines'tagnard& Mines'diana Jones`) is gone with the shape that needed it.
          -->
            {#if hasSecondTheme}
              <div class="mt-1.5 flex items-center gap-2">
                <AssociationAvatar
                  name={secondName || asso.name}
                  logoUrl={secondLogoUrl}
                  size="sm"
                />
                {#if secondName}
                  <span
                    class="text-text-muted min-w-0 text-sm font-semibold [overflow-wrap:anywhere]"
                  >
                    {secondName}
                  </span>
                {/if}
              </div>
            {/if}
            {#if kind === 'list' && asso.promo}
              <span
                class="text-cn-dark bg-cn-yellow/20 mt-2 inline-block rounded-full px-2 py-0.5 text-xs font-semibold"
              >
                {m.list_campaigns_heading({ year: asso.promo })}
              </span>
            {/if}
          </div>
          <div
            class="flex w-full shrink-0 flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center"
          >
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
              <button
                type="button"
                onclick={() => togglePushMute()}
                disabled={muteLoading}
                aria-pressed={pushMuted}
                data-testid="asso-push-mute"
                class="border-cn-border text-text-main flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-medium transition-colors hover:bg-(--cn-surface) disabled:opacity-50"
              >
                {#if pushMuted}
                  <Volume2 size={16} />
                  {m.asso_push_unmute_button()}
                {:else}
                  <VolumeX size={16} />
                  {m.asso_push_mute_button()}
                {/if}
              </button>
            {/if}
            {#if canManage}
              <a
                href="{base}/{encodeURIComponent(slug)}/edit"
                class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-sm font-bold transition-colors"
              >
                <Settings size={16} />
                {wordingFor(asso.type).manageButton()}
              </a>
            {/if}
          </div>
        </div>
      </div>
    {/if}

    {#if error}
      <div class="bg-red-err/10 border-red-err/30 text-red-err rounded-xl border p-4 text-sm">
        {error}
      </div>
    {/if}
    {#if sectionRefused}
      <!-- Nothing is drawn: the effect above is already sending the reader back to the hub. -->
    {:else if activeSection === null}
      <SectionHub rows={hubRows} label={m.asso_sections_nav_label()} />
      <div class="border-cn-border bg-cn-surface space-y-4 rounded-2xl border p-6 shadow-sm">
        <h2 class="text-text-main text-lg font-bold tracking-tight">{m.asso_tab_about()}</h2>
        <!--
          THE PROSE KEEPS THE READING MEASURE THE PAGE GAVE UP. Widening the column to `tool` is
          right for the walls and wrong for a paragraph: 1024px less the card's padding is about 150
          characters a line, roughly double what `pageWidth.ts` calls the feed's measure. The cap is
          on the container so every block inside it - both bios and the empty-state line - shares
          one left edge and one length.
        -->
        <div class="{PAGE_WIDTHS.reading} space-y-4">
          {#if asso.description?.trim()}
            <ProfileBioMarkdown source={asso.description} class="text-sm" />
          {/if}
          {#if asso.bioMarkdown?.trim()}
            <ProfileBioMarkdown source={asso.bioMarkdown} />
          {:else if !asso.description?.trim()}
            <p class="text-text-muted text-sm">{m.asso_no_description()}</p>
          {/if}
        </div>
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
      <div class="border-cn-border bg-cn-surface rounded-2xl border p-6 shadow-sm">
        <div class="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h1 class="text-text-main text-lg font-bold tracking-tight">{m.asso_tab_calendar()}</h1>
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
          canEdit={canProposeEvent}
          {canDeclareBreak}
        />
      </div>
    {:else if activeSection === 'members'}
      <div class="border-cn-border bg-cn-surface space-y-4 rounded-2xl border p-6 shadow-sm">
        <div class="flex items-center justify-between gap-2">
          <h1 class="text-text-main text-lg font-bold tracking-tight">
            {m.common_members_label()}
          </h1>
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
              displayName={resolvedMemberNames[member.userId] ?? rosterDisplayName(member)}
              isBDE={asso?.isBDE ?? false}
            />
          {/each}
        </div>
      </div>
    {:else if activeSection === 'shop'}
      <div class="border-cn-border bg-cn-surface space-y-4 rounded-2xl border p-6 shadow-sm">
        <div class="flex items-center justify-between gap-2">
          <h1 class="text-text-main flex items-center gap-2 text-lg font-bold tracking-tight">
            <ShoppingBag size={20} />
            {m.asso_tab_shop()}
          </h1>
          <a href={resolve('/shop')} class="text-cn-dark text-xs font-semibold hover:underline">
            {m.asso_view_all_shop()}
          </a>
        </div>
        <div class={CARD_GRID}>
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
                    <!--
                      A grid answers first and alone: while one is set the product's own amount
                      decides nothing, so printing it would name a figure no checkout charges.
                    -->
                    {#if gridPriceLabel(product) !== null}
                      {gridPriceLabel(product)}
                    {:else if product.amountCents}
                      {(product.amountCents / 100).toFixed(2)} {product.currency.toUpperCase()}
                    {:else if product.allowCustomAmount}
                      {m.asso_product_custom_price()}
                    {:else}
                      {m.asso_product_free_price()}
                    {/if}
                    <span
                      class="bg-cn-border/40 text-2xs ml-2 rounded-full px-1.5 py-0.5 font-bold uppercase"
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
                {#if gridRefuses(product)}
                  <p class="text-xs text-amber-700 dark:text-amber-400">
                    {m.shop_price_unavailable_hint()}
                  </p>
                {:else if gridPriceIsProvisional(product, userId !== null)}
                  <p class="text-text-muted text-xs">{m.shop_price_profile_hint()}</p>
                {/if}
                <ProductPurchaseButton
                  {product}
                  customAmountEuros={shopCustomAmounts[product.id]}
                  disabled={gridRefuses(product)}
                  class="w-full"
                />
              </div>
            </CardTile>
          {/each}
        </div>
      </div>
    {:else if activeSection === 'partnerships'}
      <div class="border-cn-border bg-cn-surface space-y-4 rounded-2xl border p-6 shadow-sm">
        <h1 class="text-text-main flex items-center gap-2 text-lg font-bold tracking-tight">
          <Handshake size={20} />
          {m.asso_tab_partnerships()}
        </h1>
        <PartnershipCardList cards={partnerships} accentColor={cardAccentColor} />
      </div>
    {/if}
  {/if}
</PageContainer>
