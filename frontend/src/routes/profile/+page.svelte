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
  import ProfileMinesweeperBadge from '$lib/components/profile/ProfileMinesweeperBadge.svelte';
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

<div class="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6 md:space-y-8">
  {#if loading}
    <div class="text-text-muted flex flex-col items-center justify-center gap-4 py-32" in:fade>
      <Loader2 size={32} class="text-cn-yellow animate-spin" strokeWidth={2.5} />
      <span class="text-sm font-bold tracking-wider uppercase">{m.profile_loading()}</span>
    </div>
  {:else if error}
    <div
      class="flex items-start gap-3 rounded-2xl border border-red-500/20 bg-red-500/10 p-5 text-red-600 shadow-sm backdrop-blur-md dark:text-red-400"
      in:slide
    >
      <AlertCircle size={20} class="mt-0.5 shrink-0" />
      <div>
        <h3 class="mb-1 text-sm font-bold">{m.common_generic_error_label()}</h3>
        <p class="text-sm font-medium">{error}</p>
      </div>
    </div>
  {:else if profile}
    <!-- Profile header -->
    <div
      class="animate-in fade-in slide-in-from-bottom-4 flex items-center gap-5 duration-500 sm:gap-6"
    >
      <div class="relative h-24 w-24 flex-shrink-0 sm:h-28 sm:w-28">
        <div
          class="h-full w-full overflow-hidden rounded-full shadow-lg ring-4 ring-white/50 dark:ring-black/20"
        >
          <Avatar userId={profile.id} fill shape="circle" />
        </div>
        <button
          type="button"
          onclick={changeProfilePhoto}
          title={m.profile_photo_change_label()}
          aria-label={m.profile_photo_change_label()}
          class="bg-cn-yellow hover:bg-cn-yellow-hover text-cn-ink shadow-cn-yellow/30 absolute right-0 bottom-0 flex h-8
                 w-8 items-center justify-center
                 rounded-full shadow-md ring-2 ring-white transition-all
                 active:scale-95 dark:ring-(--cn-bg)"
        >
          <Camera size={15} strokeWidth={2.5} />
        </button>
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
      <a
        href="/settings"
        title={m.settings_page_title()}
        class="text-text-muted hover:text-cn-dark focus-visible:ring-cn-yellow inline-flex items-center gap-1.5 self-start rounded-xl px-3 py-1.5 text-xs font-bold transition-all outline-none hover:bg-black/5 focus-visible:ring-2 active:scale-95 dark:hover:bg-white/10"
      >
        <SlidersHorizontal size={15} strokeWidth={2.5} />
        <span class="hidden sm:inline">{m.settings_page_title()}</span>
      </a>
    </div>

    <!-- Bio -->
    <div
      class="border-cn-border animate-in fade-in slide-in-from-bottom-4 rounded-2xl border bg-(--cn-surface) p-6 shadow-sm delay-75 duration-500 md:p-8"
      style="animation-fill-mode: backwards;"
    >
      <div class="mb-4 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="bg-cn-yellow/10 text-cn-dark rounded-xl p-2.5">
            <UserRound size={22} strokeWidth={2.5} />
          </div>
          <h2 class="text-text-main text-lg font-extrabold">{m.profile_bio_heading()}</h2>
        </div>
        {#if !editingBio}
          <button
            onclick={startEditBio}
            class="text-text-muted hover:text-cn-dark focus-visible:ring-cn-yellow inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm font-bold transition-all outline-none hover:bg-black/5 focus-visible:ring-2 active:scale-95 dark:hover:bg-white/10"
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
            class="focus-within:border-cn-yellow/50 focus-within:ring-cn-yellow/30 w-full min-w-0 overflow-hidden rounded-[1.25rem] border border-black/10 bg-white/80 shadow-inner transition-all focus-within:ring-2 dark:border-white/10 dark:bg-black/40"
            editorClass="min-h-[100px] w-full max-w-full px-4 py-3 text-[0.95rem] text-text-main leading-relaxed"
            placeholder={m.profile_bio_placeholder()}
          />
          <div class="flex items-center justify-between">
            <span
              class="text-text-muted pl-1 text-xs font-semibold {bioInput.length >= 490
                ? 'text-orange-500'
                : ''}"
            >
              {bioInput.length} / 500
            </span>
            <div class="flex gap-2">
              <button
                onclick={cancelEditBio}
                class="text-text-muted hover:text-text-main focus-visible:ring-text-muted rounded-xl px-4 py-2 text-sm font-bold transition-all outline-none hover:bg-black/5 focus-visible:ring-2 active:scale-95 dark:hover:bg-white/5"
              >
                {m.common_cancel_button()}
              </button>
              <button
                onclick={saveBio}
                disabled={saving || bioInput.trim() === profile.bio}
                class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover shadow-cn-yellow/20 focus-visible:ring-cn-yellow/50 inline-flex items-center gap-2 rounded-xl px-5 py-2 text-sm font-bold shadow-md transition-all outline-none focus-visible:ring-2 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
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
            <p class="text-text-main text-[0.95rem] leading-relaxed opacity-90">
              {m.profile_bio_empty()}
            </p>
          {/if}
        </div>
      {/if}
    </div>

    <!-- Associations -->
    <div
      class="border-cn-border animate-in fade-in slide-in-from-bottom-4 rounded-2xl border bg-(--cn-surface) p-6 shadow-sm delay-100 duration-500 md:p-8"
      style="animation-fill-mode: backwards;"
    >
      <div class="mb-5 flex items-center gap-3">
        <div class="bg-cn-yellow/10 text-cn-dark rounded-xl p-2.5">
          <Building2 size={22} strokeWidth={2.5} />
        </div>
        <h2 class="text-text-main text-lg font-extrabold">{m.profile_assoc_heading()}</h2>
      </div>
      <ProfileAssociationsSection {memberships} loading={membershipsLoading} />
    </div>

    <!-- Associative career -->
    <div
      class="border-cn-border animate-in fade-in slide-in-from-bottom-4 rounded-2xl border bg-(--cn-surface) p-6 shadow-sm delay-125 duration-500 md:p-8"
      style="animation-fill-mode: backwards;"
    >
      <div class="mb-5 flex items-center gap-3">
        <div class="bg-cn-yellow/10 text-cn-dark rounded-xl p-2.5">
          <History size={22} strokeWidth={2.5} />
        </div>
        <h2 class="text-text-main text-lg font-extrabold">{m.profile_career_heading()}</h2>
        {#if roleHistoryLoading}
          <Loader2 size={16} class="text-cn-yellow animate-spin" />
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
      <div class="border-cn-border rounded-2xl border bg-(--cn-surface) p-6 shadow-sm md:p-8">
        <div class="mb-5 flex items-center gap-3">
          <div class="bg-cn-yellow/10 text-cn-dark rounded-xl p-2.5">
            <Users size={22} strokeWidth={2.5} />
          </div>
          <h2 class="text-text-main text-lg font-extrabold">
            {m.profile_public_sponsorship_heading()}
          </h2>
          {#if parrainageLoading}
            <Loader2 size={16} class="text-cn-yellow animate-spin" />
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
      class="border-cn-border animate-in fade-in slide-in-from-bottom-4 rounded-2xl border bg-(--cn-surface) p-6 shadow-sm delay-150 duration-500 md:p-8"
      style="animation-fill-mode: backwards;"
    >
      <div class="mb-6 flex items-center gap-3">
        <div class="bg-cn-yellow/10 text-cn-dark rounded-xl p-2.5">
          <Info size={22} strokeWidth={2.5} />
        </div>
        <h2 class="text-text-main text-lg font-extrabold">{m.profile_info_heading()}</h2>
      </div>

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
