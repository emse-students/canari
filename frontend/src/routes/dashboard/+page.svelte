<script lang="ts">
  import { onMount } from 'svelte';
  import {
    LayoutDashboard,
    MessageCircle,
    Newspaper,
    Users,
    CalendarDays,
    ShoppingBag,
    FileText,
    User,
    Moon,
    Sun,
    LogOut,
    ShieldAlert,
    Activity,
    UserCog,
    Shield,
  } from '@lucide/svelte';
  import { goto } from '$app/navigation';
  import { clearAuth } from '$lib/stores/auth';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { listMyAssociations } from '$lib/associations/api';
  import { themeStore } from '$lib/stores/themeStore.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Section {
    label: string;
    description: string;
    href: string;
    icon:
      | 'users'
      | 'newspaper'
      | 'message-circle'
      | 'calendar-days'
      | 'shopping-bag'
      | 'file-text'
      | 'shield';
  }

  /** Items accessible depuis la nav desktop mais absents de la nav mobile. */
  const exploreItems = $derived<Section[]>([
    {
      label: m.nav_calendar_label(),
      description: m.nav_calendar_desc(),
      href: '/calendar',
      icon: 'calendar-days',
    },
    {
      label: m.nav_shop_label(),
      description: m.nav_shop_desc(),
      href: '/shop',
      icon: 'shopping-bag',
    },
    {
      label: m.assoc_list_heading(),
      description: m.assoc_list_subtitle(),
      href: '/associations',
      icon: 'users',
    },
    {
      label: m.nav_forms_label(),
      description: m.nav_forms_desc(),
      href: '/forms',
      icon: 'file-text',
    },
  ]);

  let showAdminSection = $state(false);
  let isAdmin = $derived(isGlobalAdmin());

  onMount(async () => {
    if (isGlobalAdmin()) {
      showAdminSection = true;
      return;
    }
    try {
      const mine = await listMyAssociations();
      showAdminSection = mine.some((a) => a.isAdmin);
    } catch {
      showAdminSection = false;
    }
  });

  async function handleLogout() {
    await clearAuth();
    void goto('/login', { replaceState: true });
  }
</script>

<div class="p-6 max-w-4xl mx-auto">
  <div class="mb-8">
    <h1 class="text-2xl font-bold text-text-main flex items-center gap-3">
      <LayoutDashboard size={28} class="text-cn-yellow" />
      {m.nav_dashboard_label()}
    </h1>
    <p class="text-text-muted mt-1">{m.dashboard_subtitle()}</p>
  </div>

  {#snippet card(s: Section)}
    <a
      href={s.href}
      class="group flex items-start gap-4 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-cn-yellow hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))] transition-colors"
    >
      <span
        class="flex-shrink-0 p-2.5 rounded-xl border border-cn-border bg-[var(--surface-elevated)] group-hover:border-cn-yellow transition-colors"
      >
        {#if s.icon === 'users'}
          <Users size={20} class="text-text-muted" />
        {:else if s.icon === 'newspaper'}
          <Newspaper size={20} class="text-text-muted" />
        {:else if s.icon === 'message-circle'}
          <MessageCircle size={20} class="text-text-muted" />
        {:else if s.icon === 'calendar-days'}
          <CalendarDays size={20} class="text-text-muted" />
        {:else if s.icon === 'shopping-bag'}
          <ShoppingBag size={20} class="text-text-muted" />
        {:else if s.icon === 'file-text'}
          <FileText size={20} class="text-text-muted" />
        {:else if s.icon === 'shield'}
          <Shield size={20} class="text-text-muted" />
        {/if}
      </span>
      <span>
        <span class="block font-semibold text-text-main">{s.label}</span>
        <span class="block text-sm text-text-muted mt-0.5">{s.description}</span>
      </span>
    </a>
  {/snippet}

  <!-- Compte (mobile uniquement) -->
  <section class="mb-8 md:hidden">
    <h2 class="text-xs font-semibold uppercase tracking-widest text-text-muted mb-3">{m.dashboard_account_heading()}</h2>
    <div class="grid grid-cols-3 gap-3">
      <button
        type="button"
        onclick={() => goto('/profile')}
        class="flex flex-col items-center gap-2 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-cn-yellow hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))] transition-colors"
        title={m.dashboard_profile_title()}
      >
        <User size={22} class="text-text-muted" />
        <span class="text-sm font-medium text-text-main">{m.dashboard_profile_btn()}</span>
      </button>

      <button
        type="button"
        onclick={() => themeStore.toggle()}
        class="flex flex-col items-center gap-2 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-cn-yellow hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))] transition-colors"
        title={m.dashboard_theme_title()}
      >
        {#if themeStore.isDark}
          <Sun size={22} class="text-text-muted" />
        {:else}
          <Moon size={22} class="text-text-muted" />
        {/if}
        <span class="text-sm font-medium text-text-main">{m.dashboard_theme_btn()}</span>
      </button>

      <button
        type="button"
        onclick={handleLogout}
        class="flex flex-col items-center gap-2 p-4 rounded-2xl border border-red-400/40 bg-red-500/5 text-red-600 hover:bg-red-500/10 transition-colors"
        title={m.dashboard_logout_title()}
      >
        <LogOut size={22} />
        <span class="text-sm font-medium">{m.dashboard_logout_btn()}</span>
      </button>
    </div>
  </section>

  <!-- Explorer (Agenda, Boutique, Associations, Formulaires) -->
  <section class="mb-8">
    <h2 class="text-xs font-semibold uppercase tracking-widest text-text-muted mb-3">{m.dashboard_explore_heading()}</h2>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {#each exploreItems as s (s.href)}
        {@render card(s)}
      {/each}
    </div>
  </section>

  <!-- Administration (admins d'association et admins globaux) -->
  {#if showAdminSection || isAdmin}
    <section class="mb-8">
      <h2 class="text-xs font-semibold uppercase tracking-widest text-text-muted mb-3">
        {m.dashboard_admin_heading()}
      </h2>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {#if showAdminSection && !isAdmin}
          <a
            href="/admin"
            class="flex flex-col items-center gap-2 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-cn-yellow hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))] transition-colors"
            title={m.dashboard_admin_generic_label()}
          >
            <Shield size={22} class="text-text-muted" />
            <span class="text-sm font-medium text-text-main">{m.dashboard_admin_generic_label()}</span>
            <span class="text-xs text-text-muted text-center">{m.dashboard_admin_generic_desc()}</span>
          </a>
        {/if}

        {#if isAdmin}
          <a
            href="/admin/moderation"
            class="flex flex-col items-center gap-2 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-red-400 hover:bg-red-50/40 transition-colors"
            title={m.dashboard_admin_moderation_label()}
          >
            <ShieldAlert size={22} class="text-red-500" />
            <span class="text-sm font-medium text-text-main">{m.dashboard_admin_moderation_label()}</span>
            <span class="text-xs text-text-muted text-center">{m.dashboard_admin_moderation_desc()}</span>
          </a>
          <a
            href="/admin/status"
            class="flex flex-col items-center gap-2 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-cn-yellow hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))] transition-colors"
            title={m.dashboard_admin_status_label()}
          >
            <Activity size={22} class="text-text-muted" />
            <span class="text-sm font-medium text-text-main">{m.dashboard_admin_status_label()}</span>
            <span class="text-xs text-text-muted text-center">{m.dashboard_admin_status_desc()}</span>
          </a>
          <a
            href="/admin/users"
            class="flex flex-col items-center gap-2 p-4 rounded-2xl border border-cn-border bg-[var(--cn-surface)] hover:border-amber-400 hover:bg-amber-50/40 dark:hover:bg-amber-900/10 transition-colors"
            title={m.dashboard_admin_users_label()}
          >
            <UserCog size={22} class="text-amber-500" />
            <span class="text-sm font-medium text-text-main">{m.dashboard_admin_users_label()}</span>
            <span class="text-xs text-text-muted text-center">{m.dashboard_admin_users_desc()}</span>
          </a>
        {/if}
      </div>
    </section>
  {/if}
</div>
