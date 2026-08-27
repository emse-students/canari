<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { Component } from 'svelte';
  import { isGlobalAdmin, isAssociationSuperAdmin, isContentModerator } from '$lib/stores/user';
  import { ensureMyAssociations } from '$lib/associations/api';
  import AdminNavGroup from '$lib/components/admin/AdminNavGroup.svelte';
  import {
    Shield,
    CalendarClock,
    Activity,
    ArrowLeft,
    ShieldAlert,
    UserCog,
    Wrench,
    Building2,
    Wallet,
    FileCheckCorner,
    Map,
    HardDrive,
  } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface NavItem {
    href: string;
    label: string;
    icon: Component;
  }

  interface NavGroup {
    label: string;
    icon: Component;
    items: NavItem[];
  }

  let { children } = $props();

  let ready = $state(false);
  let isGlobalAdminUser = $state(false);
  let isAssociationAdmin = $state(false);
  let isSuperAdminUser = $state(false);
  let isModeratorUser = $state(false);

  const path = $derived(page.url.pathname);

  onMount(async () => {
    isGlobalAdminUser = isGlobalAdmin();
    if (isGlobalAdminUser) {
      // A platform administrator holds every tier by definition; nothing to ask anyone.
      isAssociationAdmin = true;
      isSuperAdminUser = true;
      isModeratorUser = true;
      ready = true;
      return;
    }
    // ONE membership request answers all three: it publishes both BDE tiers as a side effect, and
    // the redirect below must decide on a resolved value - a background probe would bounce a
    // moderator to the dashboard whenever it lost the race.
    const mine = await ensureMyAssociations();
    isAssociationAdmin = mine.some((a) => a.isAdmin);
    isSuperAdminUser = isAssociationSuperAdmin();
    isModeratorUser = isContentModerator();
    ready = true;
    if (!isAssociationAdmin && !isModeratorUser) {
      void goto('/dashboard', { replaceState: true });
    }
  });

  // Grouped into dropdowns by theme rather than a flat row of up to 9 tabs. A group renders only
  // if at least one of its items is visible to the current user, so a plain association admin
  // (not global, not BDE super-admin) still sees just "Moderation" (containing only Agenda).
  const navGroups = $derived.by((): NavGroup[] => {
    const moderationItems: NavItem[] = [
      { href: '/admin/agenda', label: m.admin_pending_agenda_label(), icon: CalendarClock },
    ];
    // Reports, hidden posts and mutes: the same tier the server's `isContentModerator` accepts.
    // Gating this on `isGlobalAdminUser` alone is what left a BDE holding MODERATE with a right
    // and no way in.
    if (isGlobalAdminUser || isModeratorUser) {
      moderationItems.push({
        href: '/admin/moderation',
        label: m.admin_reported_posts_label(),
        icon: ShieldAlert,
      });
    }

    const communityItems: NavItem[] = [];
    if (isGlobalAdminUser) {
      communityItems.push({
        href: '/admin/associations',
        label: m.admin_associations_label(),
        icon: Building2,
      });
    }
    // Document-reviewer grants + Carte de la Vie Asso: global admins and BDE super-admins.
    if (isGlobalAdminUser || isSuperAdminUser) {
      communityItems.push(
        {
          href: '/admin/document-reviewers',
          label: m.docreview_nav_label(),
          icon: FileCheckCorner,
        },
        { href: '/admin/carte', label: m.carte_card_label(), icon: Map }
      );
    }

    const platformItems: NavItem[] = isGlobalAdminUser
      ? [
          { href: '/admin/platform', label: m.admin_platform_label(), icon: Wrench },
          { href: '/admin/users', label: m.admin_admins_label(), icon: UserCog },
          { href: '/admin/status', label: m.admin_presence_connections_label(), icon: Activity },
        ]
      : [];

    return [
      { label: m.admin_group_moderation_label(), icon: ShieldAlert, items: moderationItems },
      { label: m.admin_group_community_label(), icon: Building2, items: communityItems },
      { label: m.admin_group_platform_label(), icon: Wrench, items: platformItems },
    ].filter((group) => group.items.length > 0);
  });

  // Single-page sections stay direct links rather than one-item dropdowns.
  const directLinks = $derived.by((): NavItem[] => {
    if (!isGlobalAdminUser) return [];
    return [
      { href: '/admin/cercle', label: m.admin_cercle_label(), icon: Wallet },
      { href: '/admin/storage', label: m.admin_storage_label(), icon: HardDrive },
    ];
  });
</script>

{#if !ready}
  <div class="flex justify-center py-24">
    <div
      class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
    ></div>
  </div>
{:else}
  <div class="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6">
    <a
      href="/dashboard"
      class="text-text-muted hover:text-text-main inline-flex items-center gap-1 text-sm transition-colors"
    >
      <ArrowLeft size={14} />
      {m.admin_dashboard_link()}
    </a>

    <header class="flex items-start gap-3">
      <span
        class="bg-cn-yellow/20 text-cn-dark flex h-11 w-11 items-center justify-center rounded-2xl"
      >
        <Shield size={22} />
      </span>
      <div>
        <h1 class="text-text-main text-xl font-extrabold tracking-tight">{m.admin_title()}</h1>
        <p class="text-text-muted mt-0.5 text-sm">
          {#if isGlobalAdminUser}
            {m.admin_global_description()}
          {:else}
            {m.admin_associations_description()}
          {/if}
        </p>
      </div>
    </header>

    <nav class="flex gap-2 overflow-x-auto pb-1" aria-label={m.admin_title()} data-swipe-nav-ignore>
      <a
        href="/admin"
        class="shrink-0 rounded-xl px-4 py-2 text-sm font-bold transition-colors
        {path === '/admin'
          ? 'bg-cn-yellow text-cn-ink shadow-sm'
          : 'border-cn-border text-text-muted hover:text-text-main border'}"
      >
        {m.admin_home_label()}
      </a>
      {#each navGroups as group (group.label)}
        <AdminNavGroup
          label={group.label}
          icon={group.icon}
          items={group.items}
          active={group.items.some((item) => path.startsWith(item.href))}
        />
      {/each}
      {#each directLinks as item (item.href)}
        <a
          href={item.href}
          class="inline-flex shrink-0 items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-bold transition-colors
          {path.startsWith(item.href)
            ? 'bg-cn-yellow text-cn-ink shadow-sm'
            : 'border-cn-border text-text-muted hover:text-text-main border'}"
        >
          <item.icon size={15} />
          {item.label}
        </a>
      {/each}
    </nav>

    {@render children?.()}
  </div>
{/if}
