<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { Building2, RotateCcwClock, Users } from '@lucide/svelte';
  import Breadcrumb from '$lib/components/navigation/Breadcrumb.svelte';
  import ProfileAssociationsSection from '$lib/components/profile/ProfileAssociationsSection.svelte';
  import ProfileBioSection from '$lib/components/profile/ProfileBioSection.svelte';
  import ProfileCard from '$lib/components/profile/ProfileCard.svelte';
  import ProfileInfoSection from '$lib/components/profile/ProfileInfoSection.svelte';
  import ProfileNotepadSection from '$lib/components/profile/ProfileNotepadSection.svelte';
  import ProfileParrainageSection from '$lib/components/profile/ProfileParrainageSection.svelte';
  import ProfileRoleHistorySection from '$lib/components/profile/ProfileRoleHistorySection.svelte';
  import ProfileSubscriptionsSection from '$lib/components/profile/ProfileSubscriptionsSection.svelte';
  import { useMyProfile } from '$lib/profile/myProfileModel.svelte';
  import { mayOpenProfileSection, profileTrail } from '$lib/profile/profileSections';
  import { m } from '$lib/paraglide/messages';

  // `+page.ts` has already refused an unknown segment, so `data.section` is always a real key, and
  // the layout renders this page only once the profile is loaded.
  let { data } = $props();
  const section = $derived(data.section);
  const model = useMyProfile();
  const profile = $derived(model.profile);

  // A section the reader cannot open (sponsorship with nobody in it) goes back to the hub once the
  // answer is known: a typed address must not show an empty page for a menu entry that is absent.
  $effect(() => {
    if (model.parrainageLoading) return;
    const facts = {
      membershipCount: null,
      careerCount: null,
      hasSponsorship: model.hasSponsorship,
    };
    if (!mayOpenProfileSection(section, facts)) {
      void goto(resolve('/profile'), { replaceState: true });
    }
  });
</script>

<Breadcrumb crumbs={profileTrail(section, m.nav_my_profile_title())} />

{#if profile}
  <div class="space-y-6 md:space-y-8">
    {#if section === 'bio'}
      <ProfileBioSection {profile} onSaved={(saved) => (model.profile = saved)} />
    {:else if section === 'associations'}
      <ProfileCard
        icon={Building2}
        heading={m.profile_assoc_heading()}
        loading={model.membershipsLoading}
      >
        <ProfileAssociationsSection
          memberships={model.memberships}
          loading={model.membershipsLoading}
        />
      </ProfileCard>
    {:else if section === 'subscriptions'}
      <ProfileSubscriptionsSection />
    {:else if section === 'career'}
      <ProfileCard
        icon={RotateCcwClock}
        heading={m.profile_career_heading()}
        loading={model.roleHistoryLoading}
      >
        <ProfileRoleHistorySection
          entries={model.roleHistory}
          editable={true}
          onChanged={() => model.reloadRoleHistory()}
        />
      </ProfileCard>
    {:else if section === 'notepad'}
      <ProfileNotepadSection />
    {:else if section === 'sponsorship'}
      <ProfileCard
        icon={Users}
        heading={m.profile_public_sponsorship_heading()}
        loading={model.parrainageLoading}
      >
        <ProfileParrainageSection
          parrains={model.parrainage?.parrains ?? []}
          fillots={model.parrainage?.fillots ?? []}
          loading={model.parrainageLoading}
        />
      </ProfileCard>
    {:else if section === 'info'}
      <ProfileInfoSection {profile} />
    {/if}
  </div>
{/if}
