<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { fetchUserProfile, type UserProfile, getSavedUserId } from '$lib/stores/user';
  import { followUser, unfollowUser, getUserFollowStatus } from '$lib/posts/api';
  import { listBlockedUsers, blockUser, unblockUser } from '$lib/users/blocks';
  import { createReport, ModerationApiError } from '$lib/moderation/api';
  import type { ReportReason } from '$lib/moderation/reasons';
  import ReportReasonDialog from '$lib/components/moderation/ReportReasonDialog.svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { Log } from '$lib/utils/Log';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import {
    GraduationCap,
    CalendarDays,
    LoaderCircle,
    CircleAlert,
    MessageCircle,
    UserPlus,
    UserCheck,
    Users,
    Flag,
    Ban,
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
  /** True when the signed-in user has blocked the person whose profile this is. */
  let blocked = $state(false);
  let blockLoading = $state(false);
  let reportOpen = $state(false);
  let reportSubmitting = $state(false);
  /** Inline feedback for the report and block actions, cleared on the next attempt. */
  let actionMessage = $state('');

  // Monotonic token guarding against out-of-order async results: when the user navigates
  // between two profiles quickly, a slower earlier fetch must not overwrite the newer one.
  let loadToken = 0;

  /** Loads a profile and its extras, ignoring the result if a newer load has since started. */
  async function loadProfile(userId: string, token: number) {
    try {
      const [prof, status, blocks] = await Promise.all([
        fetchUserProfile(userId),
        getUserFollowStatus(userId).catch(() => ({ following: false })),
        // A blocked person is hidden from search but their profile stays reachable - by url, or
        // from the blocked list itself - so this page has to know, or it would offer to block
        // somebody who already is.
        listBlockedUsers().catch((e) => {
          Log.d('profile.loadBlocks failed', e);
          return [];
        }),
      ]);
      if (token !== loadToken) return;
      profile = prof;
      following = status.following;
      blocked = blocks.some((b) => b.userId === userId);
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
    } catch (err) {
      Log.d('profile.handleFollowToggle failed', err);
    } finally {
      followLoading = false;
    }
  }

  /**
   * Blocks or unblocks this person.
   *
   * The confirmation spells out what a block does and what it leaves alone, because the scope is
   * narrow and easy to over-read: the two accounts stop finding each other and neither can pull the
   * other into anything new, while existing conversations, groups and communities are untouched.
   */
  async function handleBlockToggle() {
    if (!profile?.id || blockLoading) return;
    actionMessage = '';

    if (!blocked) {
      const confirmed = await showConfirm(m.profile_block_confirm({ name: displayFallbackName }), {
        danger: true,
        confirmLabel: m.profile_block_btn(),
      });
      if (!confirmed) return;
    }

    blockLoading = true;
    try {
      if (blocked) {
        await unblockUser(profile.id);
        blocked = false;
        actionMessage = m.profile_unblock_done();
      } else {
        await blockUser(profile.id);
        blocked = true;
        // The server severs both follows as part of blocking; reflect it rather than re-fetching.
        following = false;
        actionMessage = m.profile_block_done();
      }
    } catch (err) {
      Log.d('profile.handleBlockToggle failed', err);
      error = err instanceof Error ? err.message : m.common_generic_error_label();
    } finally {
      blockLoading = false;
    }
  }

  /** Files a report against this person. Separate from blocking: one is private, the other is not. */
  async function submitUserReport(reason: ReportReason) {
    if (!profile?.id) return;
    reportSubmitting = true;
    actionMessage = '';
    try {
      await createReport('user', profile.id, reason, undefined, profile.id);
      actionMessage = m.post_signalement_merci();
    } catch (err) {
      if (err instanceof ModerationApiError && err.isAlreadyReported) {
        actionMessage = m.profile_already_reported();
      } else {
        Log.d('profile.submitUserReport failed', err);
        error = err instanceof Error ? err.message : m.post_unable_to_report();
      }
    } finally {
      reportSubmitting = false;
      reportOpen = false;
    }
  }
</script>

<div class="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6 md:space-y-8">
  {#if loading}
    <div class="text-text-muted flex flex-col items-center justify-center gap-4 py-32" in:fade>
      <LoaderCircle size={32} class="text-cn-yellow animate-spin" strokeWidth={2.5} />
      <span class="text-sm font-bold tracking-wider uppercase">{m.profile_public_loading()}</span>
    </div>
  {:else if error}
    <div
      class="flex items-start gap-3 rounded-2xl border border-red-500/20 bg-red-500/10 p-5 text-red-600 shadow-sm backdrop-blur-md dark:text-red-400"
      in:slide
    >
      <CircleAlert size={20} class="mt-0.5 shrink-0" />
      <div>
        <h3 class="mb-1 text-sm font-bold">{m.common_error_heading()}</h3>
        <p class="text-sm font-medium">{error}</p>
      </div>
    </div>
  {:else if profile}
    <!-- Public profile header -->
    <div
      class="animate-in fade-in slide-in-from-bottom-4 flex flex-col gap-5 duration-500 sm:flex-row sm:items-center sm:gap-6"
    >
      <div
        class="relative h-24 w-24 shrink-0 self-start overflow-hidden rounded-full shadow-lg ring-4 ring-white/50 sm:self-auto dark:ring-black/20"
      >
        <Avatar userId={profile.id} fill shape="circle" />
      </div>

      <div class="min-w-0 flex-1">
        <h1 class="text-text-main mb-1 truncate text-2xl font-extrabold tracking-tight sm:text-3xl">
          {displayFallbackName}
        </h1>
        <ProfileMinesweeperBadge userId={profile.id} />
        {#if profile.formation}
          <div
            class="bg-cn-yellow/10 border-cn-yellow/20 text-cn-dark mt-2 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold tracking-wider uppercase shadow-sm"
          >
            <GraduationCap size={14} strokeWidth={2.5} />
            {profile.formation}
          </div>
        {/if}
      </div>

      <!-- Actions -->
      <div class="mt-2 flex shrink-0 flex-col gap-2 sm:mt-0 sm:flex-row">
        <button
          onclick={handleFollowToggle}
          disabled={followLoading}
          class="focus-visible:ring-cn-yellow/50 inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-bold transition-all outline-none focus-visible:ring-2 active:scale-95 disabled:opacity-60
            {following
            ? 'text-text-main border border-black/10 bg-white/60 hover:border-red-500/20 hover:bg-red-500/10 hover:text-red-600 dark:border-white/10 dark:bg-white/10'
            : 'bg-cn-yellow/10 border-cn-yellow/20 dark:text-cn-yellow hover:bg-cn-yellow/20 border text-amber-700'}"
        >
          {#if following}
            <UserCheck size={18} strokeWidth={2.5} /> {m.profile_public_following_btn()}
          {:else}
            <UserPlus size={18} strokeWidth={2.5} /> {m.profile_public_follow_btn()}
          {/if}
        </button>
        <button
          onclick={handleSendMessage}
          class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover shadow-cn-yellow/20 focus-visible:ring-cn-yellow/50 inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-bold shadow-md transition-all outline-none focus-visible:ring-2 active:scale-95"
        >
          <MessageCircle size={18} strokeWidth={2.5} />
          {m.profile_public_message_btn()}
        </button>
      </div>
    </div>

    <!--
      Reporting and blocking are two separate gestures, deliberately. A block is private and stays
      between the two people; a report asks a moderator to look. Offering them as one control would
      have made every block a moderation event, which is the opposite of the intent.
    -->
    <div class="flex flex-wrap items-center justify-end gap-2">
      {#if actionMessage}
        <span class="text-text-muted mr-auto text-xs font-medium">{actionMessage}</span>
      {/if}
      <button
        type="button"
        onclick={() => (reportOpen = true)}
        class="text-text-muted hover:text-text-main inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors hover:bg-black/5 dark:hover:bg-white/5"
      >
        <Flag size={14} strokeWidth={2.5} />
        {m.profile_report_btn()}
      </button>
      <button
        type="button"
        onclick={handleBlockToggle}
        disabled={blockLoading}
        class="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50
          {blocked
          ? 'text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5'
          : 'text-red-600 hover:bg-red-500/10 dark:text-red-400'}"
      >
        <Ban size={14} strokeWidth={2.5} />
        {blocked ? m.profile_unblock_btn() : m.profile_block_btn()}
      </button>
    </div>

    {#if blocked}
      <p
        class="text-text-muted rounded-xl border border-black/5 bg-black/[0.03] px-4 py-3 text-xs dark:border-white/10 dark:bg-white/[0.03]"
      >
        {m.profile_blocked_notice()}
      </p>
    {/if}

    <!-- Bio section -->
    {#if profile.bio}
      <div
        class="border-cn-border animate-in fade-in slide-in-from-bottom-4 rounded-2xl border bg-(--cn-surface) p-6 shadow-sm delay-75 duration-500 md:p-8"
        style="animation-fill-mode: backwards;"
      >
        <h2 class="text-text-main mb-4 text-lg font-extrabold">
          {m.profile_public_about_heading()}
        </h2>
        <ProfileBioMarkdown source={profile.bio} />
      </div>
    {/if}

    {#if memberships.length > 0 || extrasLoading}
      <div class="border-cn-border rounded-2xl border bg-(--cn-surface) p-6 shadow-sm md:p-8">
        <h2 class="text-text-main mb-5 flex items-center gap-2 text-lg font-extrabold">
          <Building2 size={20} />
          {m.assoc_list_heading()}
        </h2>
        <ProfileAssociationsSection {memberships} loading={extrasLoading} />
      </div>
    {/if}

    {#if roleHistory.length > 0 || extrasLoading}
      <div class="border-cn-border rounded-2xl border bg-(--cn-surface) p-6 shadow-sm md:p-8">
        <h2 class="text-text-main mb-5 text-lg font-extrabold">
          {m.profile_public_career_heading()}
        </h2>
        <ProfileRoleHistorySection entries={roleHistory} />
      </div>
    {/if}

    {#if (parrainage?.parrains.length ?? 0) > 0 || (parrainage?.fillots.length ?? 0) > 0 || extrasLoading}
      <div class="border-cn-border rounded-2xl border bg-(--cn-surface) p-6 shadow-sm md:p-8">
        <h2 class="text-text-main mb-5 flex items-center gap-2 text-lg font-extrabold">
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
      class="border-cn-border animate-in fade-in slide-in-from-bottom-4 rounded-2xl border bg-(--cn-surface) p-6 shadow-sm delay-150 duration-500 md:p-8"
      style="animation-fill-mode: backwards;"
    >
      <h2 class="text-text-main mb-6 text-lg font-extrabold">{m.profile_public_info_heading()}</h2>

      <div class="grid grid-cols-1 gap-5 md:grid-cols-2">
        <div
          class="flex items-center gap-3.5 rounded-2xl border border-black/5 bg-white/50 p-4 shadow-sm dark:border-white/5 dark:bg-white/5"
        >
          <div class="text-text-muted rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
            <GraduationCap size={20} strokeWidth={2.5} />
          </div>
          <div class="min-w-0">
            <p class="text-text-muted mb-0.5 text-[0.65rem] font-bold tracking-wider uppercase">
              {m.profile_promo_label()}
            </p>
            <p class="text-text-main truncate text-sm font-bold">{formatYear(profile.promo)}</p>
          </div>
        </div>

        <div
          class="flex items-center gap-3.5 rounded-2xl border border-black/5 bg-white/50 p-4 shadow-sm dark:border-white/5 dark:bg-white/5"
        >
          <div class="text-text-muted rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
            <CalendarDays size={20} strokeWidth={2.5} />
          </div>
          <div class="min-w-0">
            <p class="text-text-muted mb-0.5 text-[0.65rem] font-bold tracking-wider uppercase">
              {m.profile_member_since_label()}
            </p>
            <p class="text-text-main text-sm font-bold capitalize">
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

<ReportReasonDialog
  open={reportOpen}
  title={m.report_user_dialog_title()}
  targetPreview={displayFallbackName}
  submitting={reportSubmitting}
  onSubmit={submitUserReport}
  onClose={() => (reportOpen = false)}
/>
