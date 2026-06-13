<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { listMyAssociations } from '$lib/associations/api';
  import { Shield, CalendarClock, Activity, ArrowLeft, ShieldAlert, UserCog, Wrench, Building2 } from '@lucide/svelte';

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
      icon: 'agenda' | 'status' | 'moderation' | 'users' | 'platform' | 'associations';
    }[] = [{ href: '/admin/agenda', label: 'Agenda en attente', icon: 'agenda' }];
    if (isGlobalAdminUser) {
      items.push(
        { href: '/admin/moderation', label: 'Posts signalés', icon: 'moderation' },
        { href: '/admin/associations', label: 'Assos / BDE', icon: 'associations' },
        { href: '/admin/status', label: 'Présence & connexions', icon: 'status' },
        { href: '/admin/platform', label: 'Plateforme', icon: 'platform' },
        { href: '/admin/users', label: 'Admins', icon: 'users' }
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
    <a href="/dashboard" class="text-sm text-text-muted hover:text-text-main transition-colors inline-flex items-center gap-1">
      <ArrowLeft size={14} />
      Tableau de bord
    </a>

    <header class="flex items-start gap-3">
      <span class="flex h-11 w-11 items-center justify-center rounded-2xl bg-cn-yellow/20 text-cn-dark">
        <Shield size={22} />
      </span>
      <div>
        <h1 class="text-xl font-extrabold text-text-main tracking-tight">Administration</h1>
        <p class="text-sm text-text-muted mt-0.5">
          {#if isGlobalAdminUser}
            Outils globaux et modération de l'agenda.
          {:else}
            Modération de l'agenda de vos associations.
          {/if}
        </p>
      </div>
    </header>

    <nav class="flex gap-2 overflow-x-auto pb-1" aria-label="Administration" data-swipe-nav-ignore>
      <a
        href="/admin"
        class="shrink-0 rounded-xl px-4 py-2 text-sm font-bold transition-colors
        {path === '/admin'
          ? 'bg-cn-yellow text-cn-ink shadow-sm'
          : 'border border-cn-border text-text-muted hover:text-text-main'}"
      >
        Accueil
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
