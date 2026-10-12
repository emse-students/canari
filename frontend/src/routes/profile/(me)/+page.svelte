<script lang="ts">
  import { resolve } from '$app/paths';
  import { Camera, SlidersHorizontal } from '@lucide/svelte';
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import SectionHub from '$lib/components/navigation/SectionHub.svelte';
  import ProfileChips from '$lib/components/profile/ProfileChips.svelte';
  import ProfileCorrectionRequest from '$lib/components/profile/ProfileCorrectionRequest.svelte';
  import ProfileMinesweeperBadge from '$lib/components/profile/ProfileMinesweeperBadge.svelte';
  import { useMyProfile } from '$lib/profile/myProfileModel.svelte';
  import { profileHubRows } from '$lib/profile/profileSections';
  import { m } from '$lib/paraglide/messages';

  // The identity block plus one row per section (`/profile/me/<section>`). The layout has loaded the
  // profile before this page renders, and owns the loading, error and sign-in handling.
  const model = useMyProfile();
  const profile = $derived(model.profile);

  async function changeProfilePhoto() {
    const { navigateExternal } = await import('$lib/utils/openExternal');
    await navigateExternal('https://gallery.mitv.fr/mes-photos');
  }

  // Fallback display name when displayName is empty.
  const displayFallbackName = $derived(profile?.displayName || m.profile_default_name());

  // A count only once its list has arrived, so the row never says "0" for a list still loading.
  const rows = $derived(
    profileHubRows({
      membershipCount: model.membershipsLoading ? null : model.memberships.length,
      careerCount: model.roleHistoryLoading ? null : model.roleHistory.length,
      hasSponsorship: model.hasSponsorship,
    })
  );
</script>

{#if profile}
  <!--
    A COLUMN ON A PHONE, A ROW FROM `sm` - the shape `profile/[id]` has carried all along, and the
    reason this header is the one that clipped. As a row at every width, a 390px screen spent 96px
    on the avatar, 40px on two gaps and ~39px on the settings link, leaving the NAME 183px;
    `truncate` then cut it. Stacked, the name gets the whole column and wraps instead.

    THE STACKED COLUMN IS CENTRED (user, 2026-09-14: *"tu pourrais centrer la photo, la formation et
    le nom sur la page profile"*): one axis runs through avatar, name, badge and formation chip, so
    the block reads as one identity rather than four stacked fragments.

    THE SETTINGS LINK IS A CORNER ICON (user, 2026-10-06: top right), absolute at the header's
    top-right at every width. The name's column keeps `sm:pr-12` so a long name never runs under it.
  -->
  <div
    class="animate-in fade-in slide-in-from-bottom-4 relative flex flex-col items-center gap-5 duration-500 sm:flex-row sm:items-center sm:gap-6"
  >
    <div class="relative h-24 w-24 shrink-0 sm:h-28 sm:w-28">
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
        class="tap-target bg-cn-yellow hover:bg-cn-yellow-hover text-cn-ink shadow-cn-yellow/30 absolute right-0 bottom-0 flex h-8
 w-8 items-center justify-center
 rounded-full shadow-md ring-2 ring-white transition-all
 active:scale-95 dark:ring-(--cn-bg)"
      >
        <Camera size={15} strokeWidth={2.5} />
      </button>
    </div>
    <div class="min-w-0 flex-1 text-center sm:pr-12 sm:text-left">
      <h1 class="text-text-main mb-1 text-2xl font-bold tracking-tight sm:text-3xl">
        {displayFallbackName}
      </h1>
      <ProfileMinesweeperBadge userId={profile.id} />
      <ProfileChips {profile} />
      <ProfileCorrectionRequest />
    </div>
    <a
      href={resolve('/settings')}
      title={m.settings_page_title()}
      aria-label={m.settings_page_title()}
      class="ui-icon-button text-text-muted hover:text-cn-dark focus-visible:ring-cn-yellow absolute top-0 right-0 rounded-xl hover:bg-black/5 focus-visible:ring-2 active:scale-95 dark:hover:bg-white/10"
    >
      <SlidersHorizontal size={18} strokeWidth={2.5} />
    </a>
  </div>

  <SectionHub {rows} label={m.profile_hub_label()} />
{/if}
