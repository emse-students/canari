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
    SlidersHorizontal,
    Moon,
    Sun,
    LogOut,
    Shield,
    FolderOpen,
  } from '@lucide/svelte';
  import { goto } from '$app/navigation';
  import { clearAuth } from '$lib/stores/auth';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { listMyAssociations, getReviewerAccess } from '$lib/associations/api';
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

  /** Items reachable from the desktop nav but absent from the mobile nav. */
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
  /** True when the user may review associations' public documents (school/MDE staff, admins, BDE). */
  let hasReviewerAccess = $state(false);

  onMount(async () => {
    // Reviewer access is independent of admin/association status (external staff).
    void getReviewerAccess()
      .then((v) => (hasReviewerAccess = v))
      .catch(() => (hasReviewerAccess = false));
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

<div class="mx-auto max-w-4xl p-6">
  <div class="mb-8">
    <h1 class="text-text-main flex items-center gap-3 text-2xl font-bold">
      <LayoutDashboard size={28} class="text-cn-yellow" />
      {m.nav_dashboard_label()}
    </h1>
    <p class="text-text-muted mt-1">{m.dashboard_subtitle()}</p>
  </div>

  {#snippet card(s: Section)}
    <a
      href={s.href}
      class="group border-cn-border hover:border-cn-yellow flex items-start gap-4 rounded-2xl border bg-(--cn-surface) p-4 transition-colors hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))]"
    >
      <span
        class="border-cn-border group-hover:border-cn-yellow shrink-0 rounded-xl border bg-(--surface-elevated) p-2.5 transition-colors"
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
        <span class="text-text-main block font-semibold">{s.label}</span>
        <span class="text-text-muted mt-0.5 block text-sm">{s.description}</span>
      </span>
    </a>
  {/snippet}

  <!-- Account quick actions. Shown on every viewport: desktop also has the sidebar gear, but the
       dashboard is a discoverable hub where users expect profile / settings / theme / logout too. -->
  <section class="mb-8">
    <h2 class="text-text-muted mb-3 text-xs font-semibold tracking-widest uppercase">
      {m.dashboard_account_heading()}
    </h2>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <button
        type="button"
        onclick={() => goto('/profile')}
        class="border-cn-border hover:border-cn-yellow flex flex-col items-center gap-2 rounded-2xl border bg-(--cn-surface) p-4 transition-colors hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))]"
        title={m.dashboard_profile_title()}
      >
        <User size={22} class="text-text-muted" />
        <span class="text-text-main text-sm font-medium">{m.dashboard_profile_btn()}</span>
      </button>

      <button
        type="button"
        onclick={() => goto('/settings')}
        class="border-cn-border hover:border-cn-yellow flex flex-col items-center gap-2 rounded-2xl border bg-(--cn-surface) p-4 transition-colors hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))]"
        title={m.dashboard_settings_title()}
      >
        <SlidersHorizontal size={22} class="text-text-muted" />
        <span class="text-text-main text-sm font-medium">{m.dashboard_settings_btn()}</span>
      </button>

      <button
        type="button"
        onclick={() => themeStore.toggle()}
        class="border-cn-border hover:border-cn-yellow flex flex-col items-center gap-2 rounded-2xl border bg-(--cn-surface) p-4 transition-colors hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))]"
        title={m.dashboard_theme_title()}
      >
        {#if themeStore.isDark}
          <Sun size={22} class="text-text-muted" />
        {:else}
          <Moon size={22} class="text-text-muted" />
        {/if}
        <span class="text-text-main text-sm font-medium">{m.dashboard_theme_btn()}</span>
      </button>

      <button
        type="button"
        onclick={handleLogout}
        class="text-red-err flex flex-col items-center gap-2 rounded-2xl border border-red-400/40 bg-red-500/5 p-4 transition-colors hover:bg-red-500/10"
        title={m.dashboard_logout_title()}
      >
        <LogOut size={22} />
        <span class="text-sm font-medium">{m.dashboard_logout_btn()}</span>
      </button>
    </div>
  </section>

  <!-- Explorer (Agenda, Boutique, Associations, Formulaires) -->
  <section class="mb-8">
    <h2 class="text-text-muted mb-3 text-xs font-semibold tracking-widest uppercase">
      {m.dashboard_explore_heading()}
    </h2>
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {#each exploreItems as s (s.href)}
        {@render card(s)}
      {/each}
    </div>
  </section>

  <!-- Reviewer des documents administratifs (personnel Ecole/MDE, admins, BDE) -->
  {#if hasReviewerAccess}
    <section class="mb-8">
      <h2 class="text-text-muted mb-3 text-xs font-semibold tracking-widest uppercase">
        {m.reviewer_docs_dashboard_heading()}
      </h2>
      <a
        href="/documents"
        class="border-cn-border hover:border-cn-yellow flex items-start gap-4 rounded-2xl border bg-(--cn-surface) p-4 transition-colors hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))]"
        title={m.reviewer_docs_dashboard_label()}
      >
        <span
          class="bg-cn-yellow/15 text-cn-dark flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
        >
          <FolderOpen size={20} />
        </span>
        <span class="min-w-0 flex-1">
          <span class="text-text-main block font-bold">{m.reviewer_docs_dashboard_label()}</span>
          <span class="text-text-muted mt-0.5 block text-sm">
            {m.reviewer_docs_dashboard_desc()}
          </span>
        </span>
      </a>
    </section>
  {/if}

  <!-- Administration (admins d'association et admins globaux) -->
  {#if showAdminSection || isAdmin}
    <section class="mb-8">
      <h2 class="text-text-muted mb-3 text-xs font-semibold tracking-widest uppercase">
        {m.dashboard_admin_heading()}
      </h2>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <a
          href="/admin"
          class="border-cn-border hover:border-cn-yellow flex flex-col items-center gap-2 rounded-2xl border bg-(--cn-surface) p-4 transition-colors hover:bg-[color-mix(in_srgb,var(--cn-yellow)_8%,var(--cn-surface))]"
          title={m.dashboard_admin_generic_label()}
        >
          <Shield size={22} class="text-text-muted" />
          <span class="text-text-main text-sm font-medium">{m.dashboard_admin_generic_label()}</span
          >
          <span class="text-text-muted text-center text-xs">{m.dashboard_admin_generic_desc()}</span
          >
        </a>
      </div>
    </section>
  {/if}
</div>
