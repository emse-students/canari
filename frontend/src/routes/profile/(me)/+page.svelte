<script lang="ts">
  import { resolve } from '$app/paths';
  import { Camera, SlidersHorizontal } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import ProfileHeader from '$lib/components/profile/ProfileHeader.svelte';
  import SectionHub from '$lib/components/navigation/SectionHub.svelte';
  import ProfileChips from '$lib/components/profile/ProfileChips.svelte';
  import ProfileCorrectionRequest from '$lib/components/profile/ProfileCorrectionRequest.svelte';
  import ProfileMinesweeperBadge from '$lib/components/profile/ProfileMinesweeperBadge.svelte';
  import ProfileBirthdayLine from '$lib/components/profile/ProfileBirthdayLine.svelte';
  import { useMyProfile } from '$lib/profile/myProfileModel.svelte';
  import { profileHubRows } from '$lib/profile/profileSections';
  import { m } from '$lib/paraglide/messages';
  import { openProfilePhotoPage } from '$lib/utils/profilePhotoLink';

  // The identity block plus one row per section (`/profile/me/<section>`). The layout has loaded the
  // profile before this page renders, and owns the loading, error and sign-in handling.
  const model = useMyProfile();
  const profile = $derived(model.profile);

  const changeProfilePhoto = () => openProfilePhotoPage();

  // Fallback display name when displayName is empty.
  const displayFallbackName = $derived(profile?.displayName || m.profile_default_name());

  // A count only once its list has arrived, so the row never says "0" for a list still loading.
  const rows = $derived(
    profileHubRows({
      memberships: model.membershipsLoading ? null : model.memberships,
      careerCount: model.roleHistoryLoading ? null : model.roleHistory.length,
      hasSponsorship: model.hasSponsorship,
    })
  );
</script>

{#if profile}
  <!--
    THE SAME HEADER AS SOMEONE ELSE'S PROFILE (`ProfileHeader`), with the own profile's actions. The
    settings link was a corner icon pinned absolutely at the top right, with `sm:pr-12` reserved
    on the name so it never ran under it - the very arrangement that drew the action row over a
    wrapped name on the other profile. It is now a button of the action row, which drops below the
    identity when there is no room beside it. The centred stacked column on a phone is the owner's
    (2026-09-14: *"tu pourrais centrer la photo, la formation et le nom"*).
  -->
  <ProfileHeader userId={profile.id} name={displayFallbackName}>
    {#snippet avatarBadge()}
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
    {/snippet}
    {#snippet details()}
      <ProfileMinesweeperBadge userId={profile!.id} />
      <ProfileChips {profile} />
      <ProfileBirthdayLine userId={profile!.id} self />
      <ProfileCorrectionRequest />
    {/snippet}
    {#snippet actions()}
      <Button variant="secondary" href={resolve('/settings')} class="min-h-11 flex-1 sm:flex-none">
        <SlidersHorizontal size={16} class="shrink-0" aria-hidden="true" />
        <span class="whitespace-nowrap">{m.settings_page_title()}</span>
      </Button>
    {/snippet}
  </ProfileHeader>

  <SectionHub {rows} label={m.profile_hub_label()} />
{/if}
