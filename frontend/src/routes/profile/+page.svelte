<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { fetchMyProfile, updateMyProfile, type UserProfile } from '$lib/stores/user';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import {
    fetchUserMemberships,
    fetchUserRoleHistory,
    fetchUserParrainage,
    type UserMembershipRow,
    type UserRoleHistoryRow,
    type SkyEntourage,
  } from '$lib/profile/api';
  import ProfileAssociationsSection from '$lib/components/profile/ProfileAssociationsSection.svelte';
  import ProfileNotepadSection from '$lib/components/profile/ProfileNotepadSection.svelte';
  import ProfileRoleHistorySection from '$lib/components/profile/ProfileRoleHistorySection.svelte';
  import ProfileParrainageSection from '$lib/components/profile/ProfileParrainageSection.svelte';
  import {
    Edit3,
    Check,
    GraduationCap,
    CalendarDays,
    Loader2,
    AlertCircle,
    Camera,
    Building2,
    Users,
    UserRound,
    History,
    Info,
    SlidersHorizontal,
  } from '@lucide/svelte';
  import { slide, fade } from 'svelte/transition';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import { trimComposerText } from '$lib/utils/markdown/composerText';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  let profile = $state<UserProfile | null>(null);
  let loading = $state(true);
  let error = $state('');

  async function changeProfilePhoto() {
    const { navigateExternal } = await import('$lib/utils/openExternal');
    await navigateExternal('https://gallery.mitv.fr/mes-photos');
  }

  // Bio state
  let editingBio = $state(false);
  let bioInput = $state('');
  let saving = $state(false);

  let memberships = $state<UserMembershipRow[]>([]);
  let membershipsLoading = $state(false);
  let roleHistory = $state<UserRoleHistoryRow[]>([]);
  let roleHistoryLoading = $state(false);
  let parrainage = $state<SkyEntourage | null>(null);
  let parrainageLoading = $state(false);

  onMount(async () => {
    try {
      profile = await fetchMyProfile();
      bioInput = profile.bio || '';
      void loadProfileExtras(profile.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : m.profile_load_error_fallback();
      if (msg.toLowerCase().includes('session') || msg.includes('401')) {
        await goto('/login?returnTo=/profile', { replaceState: true });
        return;
      }
      error = msg;
    } finally {
      loading = false;
    }
  });

  async function loadProfileExtras(userId: string) {
    membershipsLoading = true;
    roleHistoryLoading = true;
    try {
      memberships = await fetchUserMemberships(userId);
    } catch {
      memberships = [];
    } finally {
      membershipsLoading = false;
    }
    try {
      roleHistory = await fetchUserRoleHistory(userId);
    } catch {
      roleHistory = [];
    } finally {
      roleHistoryLoading = false;
    }
    parrainageLoading = true;
    try {
      parrainage = await fetchUserParrainage(userId);
    } catch {
      parrainage = null;
    } finally {
      parrainageLoading = false;
    }
  }

  async function reloadRoleHistory() {
    if (!profile?.id) return;
    roleHistoryLoading = true;
    try {
      roleHistory = await fetchUserRoleHistory(profile.id);
    } finally {
      roleHistoryLoading = false;
    }
  }

  async function saveBio() {
    saving = true;
    try {
      bioInput = trimComposerText(bioInput);
      profile = await updateMyProfile({ bio: bioInput });
      editingBio = false;
    } catch (err) {
      error = err instanceof Error ? err.message : m.profile_bio_save_error_fallback();
    } finally {
      saving = false;
    }
  }

  function startEditBio() {
    bioInput = profile?.bio || '';
    editingBio = true;
  }

  function cancelEditBio() {
    editingBio = false;
    bioInput = profile?.bio || '';
  }

  function formatYear(year: number | null): string {
    if (!year) return m.profile_promo_unknown();
    return m.profile_promo_value({ year });
  }

  // Fallback display name when displayName is empty.
  const displayFallbackName = $derived.by(() => {
    if (profile?.displayName) return profile.displayName;
    return m.profile_default_name();
  });
</script>

<div class="px-4 py-8 sm:px-6 max-w-3xl mx-auto space-y-6 md:space-y-8">
  {#if loading}
    <div class="flex flex-col items-center justify-center py-32 gap-4 text-text-muted" in:fade>
      <Loader2 size={32} class="animate-spin text-cn-yellow" strokeWidth={2.5} />
      <span class="text-sm font-bold tracking-wider uppercase">{m.profile_loading()}</span>
    </div>
  {:else if error}
    <div
      class="rounded-2xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 p-5 flex items-start gap-3 shadow-sm backdrop-blur-md"
      in:slide
    >
      <AlertCircle size={20} class="shrink-0 mt-0.5" />
      <div>
        <h3 class="font-bold text-sm mb-1">{m.common_generic_error_label()}</h3>
        <p class="text-sm font-medium">{error}</p>
      </div>
    </div>
  {:else if profile}
    <!-- Profile header -->
    <div
      class="flex items-center gap-5 sm:gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500"
    >
      <div class="relative w-24 h-24 sm:w-28 sm:h-28 flex-shrink-0">
        <div
          class="w-full h-full shadow-lg ring-4 ring-white/50 dark:ring-black/20 rounded-full overflow-hidden"
        >
          <Avatar userId={profile.id} fill shape="circle" />
        </div>
        <button
          type="button"
          onclick={changeProfilePhoto}
          title={m.profile_photo_change_label()}
          aria-label={m.profile_photo_change_label()}
          class="absolute bottom-0 right-0 flex items-center justify-center w-8 h-8 rounded-full
                 bg-cn-yellow hover:bg-cn-yellow-hover text-cn-ink
                 shadow-md shadow-cn-yellow/30 ring-2 ring-white dark:ring-[var(--cn-bg)]
                 transition-all active:scale-95"
        >
          <Camera size={15} strokeWidth={2.5} />
        </button>
      </div>
      <div class="flex-1 min-w-0">
        <h1 class="text-2xl sm:text-3xl font-extrabold text-text-main tracking-tight truncate mb-1">
          {displayFallbackName}
        </h1>
        {#if profile.formation}
          <div
            class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-cn-yellow/10 border border-cn-yellow/20 text-cn-dark text-xs font-bold uppercase tracking-wider mt-2 shadow-sm"
          >
            <GraduationCap size={14} strokeWidth={2.5} />
            {profile.formation}
          </div>
        {/if}
      </div>
      <a
        href="/settings"
        title={m.settings_page_title()}
        class="self-start inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold text-text-muted hover:text-cn-dark hover:bg-black/5 dark:hover:bg-white/10 transition-all outline-none focus-visible:ring-2 focus-visible:ring-cn-yellow active:scale-95"
      >
        <SlidersHorizontal size={15} strokeWidth={2.5} />
        <span class="hidden sm:inline">{m.settings_page_title()}</span>
      </a>
    </div>

    <!-- Bio -->
    <div
      class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500 delay-75"
      style="animation-fill-mode: backwards;"
    >
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-3">
          <div class="p-2.5 rounded-xl bg-cn-yellow/10 text-cn-dark">
            <UserRound size={22} strokeWidth={2.5} />
          </div>
          <h2 class="text-lg font-extrabold text-text-main">{m.profile_bio_heading()}</h2>
        </div>
        {#if !editingBio}
          <button
            onclick={startEditBio}
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-bold text-text-muted hover:text-cn-dark hover:bg-black/5 dark:hover:bg-white/10 transition-all outline-none focus-visible:ring-2 focus-visible:ring-cn-yellow active:scale-95"
          >
            <Edit3 size={16} strokeWidth={2.5} />
            {m.common_edit_label()}
          </button>
        {/if}
      </div>

      {#if editingBio}
        <div transition:slide={{ duration: 200 }} class="space-y-3">
          <MarkdownComposerField
            bind:value={bioInput}
            maxlength={500}
            minHeight="100px"
            class="w-full min-w-0 rounded-[1.25rem] border border-black/10 dark:border-white/10 bg-white/80 dark:bg-black/40 shadow-inner focus-within:border-cn-yellow/50 focus-within:ring-2 focus-within:ring-cn-yellow/30 transition-all overflow-hidden"
            editorClass="min-h-[100px] w-full max-w-full px-4 py-3 text-[0.95rem] text-text-main leading-relaxed"
            placeholder={m.profile_bio_placeholder()}
          />
          <div class="flex items-center justify-between">
            <span
              class="text-xs font-semibold text-text-muted pl-1 {bioInput.length >= 490
                ? 'text-orange-500'
                : ''}"
            >
              {bioInput.length} / 500
            </span>
            <div class="flex gap-2">
              <button
                onclick={cancelEditBio}
                class="rounded-xl px-4 py-2 text-sm font-bold text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5 transition-all active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-text-muted"
              >
                {m.common_cancel_button()}
              </button>
              <button
                onclick={saveBio}
                disabled={saving || bioInput.trim() === profile.bio}
                class="inline-flex items-center gap-2 rounded-xl bg-cn-yellow px-5 py-2 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 shadow-md shadow-cn-yellow/20 disabled:shadow-none outline-none focus-visible:ring-2 focus-visible:ring-cn-yellow/50"
              >
                {#if saving}
                  <Loader2 size={16} class="animate-spin" strokeWidth={3} />
                  {m.common_saving_label()}
                {:else}
                  <Check size={16} strokeWidth={3} /> {m.common_save_button()}
                {/if}
              </button>
            </div>
          </div>
        </div>
      {:else}
        <div transition:fade={{ duration: 200 }} class="min-h-[3rem]">
          {#if profile.bio?.trim()}
            <ProfileBioMarkdown source={profile.bio} />
          {:else}
            <p class="text-[0.95rem] text-text-main leading-relaxed opacity-90">
              {m.profile_bio_empty()}
            </p>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Associations -->
    <div
      class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500 delay-100"
      style="animation-fill-mode: backwards;"
    >
      <div class="flex items-center justify-between mb-5">
        <div class="flex items-center gap-3">
          <div class="p-2.5 rounded-xl bg-cn-yellow/10 text-cn-dark">
            <Building2 size={22} strokeWidth={2.5} />
          </div>
          <h2 class="text-lg font-extrabold text-text-main">{m.profile_assoc_heading()}</h2>
        </div>
        <a
          href="/directory"
          class="inline-flex items-center gap-1 text-xs font-bold text-cn-dark hover:underline"
        >
          <Users size={14} />
          {m.profile_directory_link()}
        </a>
      </div>
      <ProfileAssociationsSection {memberships} loading={membershipsLoading} />
    </div>

    <!-- Associative career -->
    <div
      class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500 delay-125"
      style="animation-fill-mode: backwards;"
    >
      <div class="flex items-center gap-3 mb-5">
        <div class="p-2.5 rounded-xl bg-cn-yellow/10 text-cn-dark">
          <History size={22} strokeWidth={2.5} />
        </div>
        <h2 class="text-lg font-extrabold text-text-main">{m.profile_career_heading()}</h2>
        {#if roleHistoryLoading}
          <Loader2 size={16} class="animate-spin text-cn-yellow" />
        {/if}
      </div>
      <ProfileRoleHistorySection
        entries={roleHistory}
        editable={true}
        onChanged={reloadRoleHistory}
      />
    </div>

    <!-- Personal notepad (private, plaintext server-side) -->
    <ProfileNotepadSection />

    <!-- Sponsorship (close tree, from Sky) -->
    {#if (parrainage?.parrains.length ?? 0) > 0 || (parrainage?.fillots.length ?? 0) > 0 || parrainageLoading}
      <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm">
        <div class="flex items-center gap-3 mb-5">
          <div class="p-2.5 rounded-xl bg-cn-yellow/10 text-cn-dark">
            <Users size={22} strokeWidth={2.5} />
          </div>
          <h2 class="text-lg font-extrabold text-text-main">
            {m.profile_public_sponsorship_heading()}
          </h2>
          {#if parrainageLoading}
            <Loader2 size={16} class="animate-spin text-cn-yellow" />
          {/if}
        </div>
        <ProfileParrainageSection
          parrains={parrainage?.parrains ?? []}
          fillots={parrainage?.fillots ?? []}
          loading={parrainageLoading}
        />
      </div>
    {/if}

    <!-- Information -->
    <div
      class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500 delay-150"
      style="animation-fill-mode: backwards;"
    >
      <div class="flex items-center gap-3 mb-6">
        <div class="p-2.5 rounded-xl bg-cn-yellow/10 text-cn-dark">
          <Info size={22} strokeWidth={2.5} />
        </div>
        <h2 class="text-lg font-extrabold text-text-main">{m.profile_info_heading()}</h2>
      </div>

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
                {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                }
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>
