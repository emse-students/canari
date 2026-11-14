<script lang="ts">
  import { Camera } from '@lucide/svelte';
  import ProfileHeader from '$lib/components/profile/ProfileHeader.svelte';
  import SectionHub from '$lib/components/navigation/SectionHub.svelte';
  import ProfileSummaryLine from '$lib/components/profile/ProfileSummaryLine.svelte';
  import ProfileMinesweeperBadge from '$lib/components/profile/ProfileMinesweeperBadge.svelte';
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
    settings link was a corner icon, then a button of the action row; it is now the LAST ROW of
    the list below (owner, 2026-11-14), so the header carries no action. The centred stacked column on a phone is the owner's
    (2026-09-14: *"tu pourrais centrer la photo, la formation et le nom"*).
  -->
  <ProfileHeader userId={profile.id} name={displayFallbackName}>
    {#snippet avatarBadge()}
      <button
        type="button"
        onclick={changeProfilePhoto}
        title={m.profile_photo_change_label()}
        aria-label={m.profile_photo_change_label()}
        class="tap-target bg-accent hover:bg-accent-hover text-on-accent shadow-accent/30 absolute right-0 bottom-0 z-10 flex h-8
 w-8 items-center justify-center
 rounded-full shadow-md ring-2 ring-white transition-all
 active:scale-95 dark:ring-(--cn-bg)"
      >
        <Camera size={15} strokeWidth={2.5} />
      </button>
    {/snippet}
    {#snippet details()}
      <ProfileSummaryLine userId={profile!.id} {profile} self />
      <ProfileMinesweeperBadge userId={profile!.id} />
    {/snippet}
  </ProfileHeader>

  <SectionHub {rows} label={m.profile_hub_label()} />
{/if}
