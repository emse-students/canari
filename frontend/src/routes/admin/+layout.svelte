<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { listMyAssociations } from '$lib/associations/api';
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
  } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  let { children } = $props();

  let ready = $state(false);
  let isGlobalAdminUser = $state(false);
  let isAssociationAdmin = $state(false);

  const path = $derived(page.url.pathname);

  onMount(async () => {
    isGlobalAdminUser = isGlobalAdmin();
    if (isGlobalAdminUser) {
      isAssociationAdmin = true;
      ready = true;
      return;
    }
    try {
      const mine = await listMyAssociations();
      isAssociationAdmin = mine.some((a) => a.isAdmin);
    } catch {
      isAssociationAdmin = false;
    }
    ready = true;
    if (!isAssociationAdmin) {
      void goto('/dashboard', { replaceState: true });
    }
  });

  const navItems = $derived.by(() => {
    const items: {
      href: string;
      label: string;
      icon: 'agenda' | 'status' | 'moderation' | 'users' | 'platform' | 'associations' | 'cercle';
    }[] = [{ href: '/admin/agenda', label: m.admin_pending_agenda_label(), icon: 'agenda' }];
    if (isGlobalAdminUser) {
      items.push(
        { href: '/admin/moderation', label: m.admin_reported_posts_label(), icon: 'moderation' },
        { href: '/admin/associations', label: m.admin_associations_label(), icon: 'associations' },
        { href: '/admin/status', label: m.admin_presence_connections_label(), icon: 'status' },
        { href: '/admin/platform', label: m.admin_platform_label(), icon: 'platform' },
        { href: '/admin/cercle', label: m.admin_cercle_label(), icon: 'cercle' },
        { href: '/admin/users', label: m.admin_admins_label(), icon: 'users' }
      );
    }
    return items;
  });
</script>

{#if !ready}
  <div class="flex justify-center py-24">
    <div
      class="h-8 w-8 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
    ></div>
  </div>
{:else}
  <div class="px-4 py-6 sm:px-6 max-w-4xl mx-auto space-y-6">
    <a
      href="/dashboard"
      class="text-sm text-text-muted hover:text-text-main transition-colors inline-flex items-center gap-1"
    >
      <ArrowLeft size={14} />
      {m.admin_dashboard_link()}
    </a>

    <header class="flex items-start gap-3">
      <span
        class="flex h-11 w-11 items-center justify-center rounded-2xl bg-cn-yellow/20 text-cn-dark"
      >
        <Shield size={22} />
      </span>
      <div>
        <h1 class="text-xl font-extrabold text-text-main tracking-tight">{m.admin_title()}</h1>
        <p class="text-sm text-text-muted mt-0.5">
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
          : 'border border-cn-border text-text-muted hover:text-text-main'}"
      >
        {m.admin_home_label()}
      </a>
      {#each navItems as item (item.href)}
        <a
          href={item.href}
          class="inline-flex items-center gap-1.5 shrink-0 rounded-xl px-4 py-2 text-sm font-bold transition-colors
          {path.startsWith(item.href)
            ? 'bg-cn-yellow text-cn-ink shadow-sm'
            : 'border border-cn-border text-text-muted hover:text-text-main'}"
        >
          {#if item.icon === 'agenda'}
            <CalendarClock size={15} />
          {:else if item.icon === 'moderation'}
            <ShieldAlert size={15} />
          {:else if item.icon === 'users'}
            <UserCog size={15} />
          {:else if item.icon === 'associations'}
            <Building2 size={15} />
          {:else if item.icon === 'platform'}
            <Wrench size={15} />
          {:else if item.icon === 'cercle'}
            <Wallet size={15} />
          {:else}
            <Activity size={15} />
          {/if}
          {item.label}
        </a>
      {/each}
    </nav>

    {@render children?.()}
  </div>
{/if}
