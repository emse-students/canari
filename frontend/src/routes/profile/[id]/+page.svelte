<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { fetchUserProfile, type UserProfile, getSavedUserId } from '$lib/stores/user';
  import { followUser, unfollowUser, getUserFollowStatus } from '$lib/posts/api';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import {
    GraduationCap,
    CalendarDays,
    Loader2,
    AlertCircle,
    MessageCircle,
    UserPlus,
    UserCheck,
    Users,
  } from '@lucide/svelte';
  import { slide, fade } from 'svelte/transition';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';
  import ProfileAssociationsSection from '$lib/components/profile/ProfileAssociationsSection.svelte';
  import ProfileRoleHistorySection from '$lib/components/profile/ProfileRoleHistorySection.svelte';
  import ProfileParrainageSection from '$lib/components/profile/ProfileParrainageSection.svelte';
  import ProfileMinesweeperBadge from '$lib/components/profile/ProfileMinesweeperBadge.svelte';
  import {
    fetchUserMemberships,
    fetchUserRoleHistory,
    fetchUserParrainage,
    type UserMembershipRow,
    type UserRoleHistoryRow,
    type SkyEntourage,
  } from '$lib/profile/api';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
  import { Building2 } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  let profile = $state<UserProfile | null>(null);
  let loading = $state(true);
  let error = $state('');
  let following = $state(false);
  let followLoading = $state(false);
  let memberships = $state<UserMembershipRow[]>([]);
  let roleHistory = $state<UserRoleHistoryRow[]>([]);
  let parrainage = $state<SkyEntourage | null>(null);
  let extrasLoading = $state(false);

  // Monotonic token guarding against out-of-order async results: when the user navigates
  // between two profiles quickly, a slower earlier fetch must not overwrite the newer one.
  let loadToken = 0;

  /** Loads a profile and its extras, ignoring the result if a newer load has since started. */
  async function loadProfile(userId: string, token: number) {
    try {
      const [prof, status] = await Promise.all([
        fetchUserProfile(userId),
        getUserFollowStatus(userId).catch(() => ({ following: false })),
      ]);
      if (token !== loadToken) return;
      profile = prof;
      following = status.following;
      extrasLoading = true;
      try {
        const rows = await fetchUserMemberships(userId);
        if (token === loadToken) memberships = rows;
      } catch {
        if (token === loadToken) memberships = [];
      }
      try {
        const rows = await fetchUserRoleHistory(userId);
        if (token === loadToken) roleHistory = rows;
      } catch {
        if (token === loadToken) roleHistory = [];
      }
      try {
        const entourage = await fetchUserParrainage(userId);
        if (token === loadToken) parrainage = entourage;
      } catch {
        if (token === loadToken) parrainage = null;
      } finally {
        if (token === loadToken) extrasLoading = false;
      }
    } catch (err) {
      if (token !== loadToken) return;
      error = err instanceof Error ? err.message : m.profile_public_load_error();
    } finally {
      if (token === loadToken) loading = false;
    }
  }

  // Reactively (re)load whenever the [id] route param changes. onMount would only fire on the
  // first mount - navigating /profile/[a] -> /profile/[b] reuses this same component instance,
  // so an effect on page.params.id is what makes the page actually re-render on the new user.
  $effect(() => {
    const userId = page.params.id;

    // A new target invalidates any in-flight load and resets the visible state so the previous
    // profile's content is never shown while the new one loads.
    const token = ++loadToken;
    profile = null;
    error = '';
    memberships = [];
    roleHistory = [];
    parrainage = null;
    extrasLoading = false;
    loading = true;

    if (!userId) {
      error = m.profile_public_missing_id();
      loading = false;
      return;
    }

    // Redirect to own profile page if viewing self.
    const currentUserId = getSavedUserId();
    if (currentUserId && userId === currentUserId) {
      goto('/profile', { replaceState: true });
      return;
    }

    void loadProfile(userId, token);
  });

  function formatYear(year: number | null): string {
    if (!year) return m.profile_promo_unknown();
    return m.profile_promo_value({ year });
  }

  const displayFallbackName = $derived.by(() => {
    if (profile?.displayName) return profile.displayName;
    if (profile?.id) return getUserDisplayNameSync(profile.id, 'Membre Canari');
    return 'Membre Canari';
  });

  function handleSendMessage() {
    if (profile?.id) {
      sessionStorage.setItem('canari_pending_contact', profile.id);
      goto('/chat');
    }
  }

  async function handleFollowToggle() {
    if (!profile?.id || followLoading) return;
    followLoading = true;
    try {
      if (following) {
        await unfollowUser(profile.id);
        following = false;
      } else {
        await followUser(profile.id);
        following = true;
      }
    } catch {
      /* silent */
    } finally {
      followLoading = false;
    }
  }
</script>

<div class="px-4 py-8 sm:px-6 max-w-3xl mx-auto space-y-6 md:space-y-8">
  {#if loading}
    <div class="flex flex-col items-center justify-center py-32 gap-4 text-text-muted" in:fade>
      <Loader2 size={32} class="animate-spin text-cn-yellow" strokeWidth={2.5} />
      <span class="text-sm font-bold tracking-wider uppercase">{m.profile_public_loading()}</span>
    </div>
  {:else if error}
    <div
      class="rounded-2xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 p-5 flex items-start gap-3 shadow-sm backdrop-blur-md"
      in:slide
    >
      <AlertCircle size={20} class="shrink-0 mt-0.5" />
      <div>
        <h3 class="font-bold text-sm mb-1">{m.common_error_heading()}</h3>
        <p class="text-sm font-medium">{error}</p>
      </div>
    </div>
  {:else if profile}
    <!-- Public profile header -->
    <div
      class="flex flex-col sm:flex-row sm:items-center gap-5 sm:gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500"
    >
      <div
        class="relative shrink-0 self-start sm:self-auto w-24 h-24 rounded-full overflow-hidden ring-4 ring-white/50 dark:ring-black/20 shadow-lg"
      >
        <Avatar userId={profile.id} fill shape="circle" />
      </div>

      <div class="flex-1 min-w-0">
        <h1 class="text-2xl sm:text-3xl font-extrabold text-text-main tracking-tight truncate mb-1">
          {displayFallbackName}
        </h1>
        <ProfileMinesweeperBadge userId={profile.id} />
        {#if profile.formation}
          <div
            class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-cn-yellow/10 border border-cn-yellow/20 text-cn-dark text-xs font-bold uppercase tracking-wider mt-2 shadow-sm"
          >
            <GraduationCap size={14} strokeWidth={2.5} />
            {profile.formation}
          </div>
        {/if}
      </div>

      <!-- Actions -->
      <div class="shrink-0 mt-2 sm:mt-0 flex flex-col sm:flex-row gap-2">
        <button
          onclick={handleFollowToggle}
          disabled={followLoading}
          class="inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-bold transition-all active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-cn-yellow/50 disabled:opacity-60
            {following
            ? 'bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 text-text-main hover:bg-red-500/10 hover:text-red-600 hover:border-red-500/20'
            : 'bg-cn-yellow/10 border border-cn-yellow/20 text-amber-700 dark:text-cn-yellow hover:bg-cn-yellow/20'}"
        >
          {#if following}
            <UserCheck size={18} strokeWidth={2.5} /> {m.profile_public_following_btn()}
          {:else}
            <UserPlus size={18} strokeWidth={2.5} /> {m.profile_public_follow_btn()}
          {/if}
        </button>
        <button
          onclick={handleSendMessage}
          class="inline-flex items-center justify-center gap-2 rounded-xl bg-cn-yellow px-5 py-3 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover transition-all active:scale-95 shadow-md shadow-cn-yellow/20 outline-none focus-visible:ring-2 focus-visible:ring-cn-yellow/50"
        >
          <MessageCircle size={18} strokeWidth={2.5} />
          {m.profile_public_message_btn()}
        </button>
      </div>
    </div>

    <!-- Bio section -->
    {#if profile.bio}
      <div
        class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500 delay-75"
        style="animation-fill-mode: backwards;"
      >
        <h2 class="text-lg font-extrabold text-text-main mb-4">
          {m.profile_public_about_heading()}
        </h2>
        <ProfileBioMarkdown source={profile.bio} />
      </div>
    {/if}

    {#if memberships.length > 0 || extrasLoading}
      <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm">
        <h2 class="text-lg font-extrabold text-text-main mb-5 flex items-center gap-2">
          <Building2 size={20} />
          {m.assoc_list_heading()}
        </h2>
        <ProfileAssociationsSection {memberships} loading={extrasLoading} />
      </div>
    {/if}

    {#if roleHistory.length > 0 || extrasLoading}
      <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm">
        <h2 class="text-lg font-extrabold text-text-main mb-5">
          {m.profile_public_career_heading()}
        </h2>
        <ProfileRoleHistorySection entries={roleHistory} />
      </div>
    {/if}

    {#if (parrainage?.parrains.length ?? 0) > 0 || (parrainage?.fillots.length ?? 0) > 0 || extrasLoading}
      <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm">
        <h2 class="text-lg font-extrabold text-text-main mb-5 flex items-center gap-2">
          <Users size={20} />
          {m.profile_public_sponsorship_heading()}
        </h2>
        <ProfileParrainageSection
          parrains={parrainage?.parrains ?? []}
          fillots={parrainage?.fillots ?? []}
          loading={extrasLoading}
        />
      </div>
    {/if}

    <!-- Information section -->
    <div
      class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500 delay-150"
      style="animation-fill-mode: backwards;"
    >
      <h2 class="text-lg font-extrabold text-text-main mb-6">{m.profile_public_info_heading()}</h2>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div
          class="flex items-center gap-3.5 p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/5 shadow-sm"
        >
          <div class="p-2.5 rounded-xl bg-black/5 dark:bg-black/40 text-text-muted">
            <GraduationCap size={20} strokeWidth={2.5} />
          </div>
          <div class="min-w-0">
            <p class="text-[0.65rem] font-bold uppercase tracking-wider text-text-muted mb-0.5">
              {m.profile_promo_label()}
            </p>
            <p class="text-sm font-bold text-text-main truncate">{formatYear(profile.promo)}</p>
          </div>
        </div>

        <div
          class="flex items-center gap-3.5 p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/5 shadow-sm"
        >
          <div class="p-2.5 rounded-xl bg-black/5 dark:bg-black/40 text-text-muted">
            <CalendarDays size={20} strokeWidth={2.5} />
          </div>
          <div class="min-w-0">
            <p class="text-[0.65rem] font-bold uppercase tracking-wider text-text-muted mb-0.5">
              {m.profile_member_since_label()}
            </p>
            <p class="text-sm font-bold text-text-main capitalize">
              {new Date(profile.createdAt).toLocaleDateString(
                getLocale() === 'en' ? 'en-US' : 'fr-FR',
                { year: 'numeric', month: 'long', day: 'numeric' }
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>
