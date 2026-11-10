<script lang="ts">
  import { CalendarDays, GraduationCap, Info, MapPin } from '@lucide/svelte';
  import type { UserProfile } from '$lib/stores/user';
  import ProfileCard from '$lib/components/profile/ProfileCard.svelte';
  import ProfileCorrectionRequest from '$lib/components/profile/ProfileCorrectionRequest.svelte';
  import { campusLabel } from '$lib/profile/miconnectProfile';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  let { profile }: { profile: UserProfile } = $props();

  /** Formation(s) and campus: the one place they are shown in full, beside their correction. */
  const schooling = $derived(
    [
      ...(profile.cursus ?? []).map((e) => e.formation),
      profile.campus ? campusLabel(profile.campus) : '',
    ]
      .filter(Boolean)
      .join(' · ') || m.profile_promo_unknown()
  );

  function formatYear(year: number | null): string {
    if (!year) return m.profile_promo_unknown();
    return m.profile_promo_value({ year });
  }
</script>

<ProfileCard icon={Info} heading={m.profile_info_heading()}>
  <div class="grid grid-cols-1 gap-5 md:grid-cols-2">
    <div
      class="bg-cn-surface flex items-center gap-3.5 rounded-2xl border border-black/5 p-4 shadow-sm dark:border-white/5"
    >
      <div class="text-text-muted rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
        <GraduationCap size={20} strokeWidth={2.5} />
      </div>
      <div class="min-w-0">
        <p class="text-text-muted text-2xs mb-0.5 font-bold">
          {m.profile_promo_label()}
        </p>
        <p class="text-text-main truncate text-sm font-bold">
          {profile.cursus?.length
            ? profile.cursus.map((e) => formatYear(e.promo)).join(' · ')
            : formatYear(null)}
        </p>
      </div>
    </div>

    <div
      class="bg-cn-surface flex items-center gap-3.5 rounded-2xl border border-black/5 p-4 shadow-sm dark:border-white/5"
    >
      <div class="text-text-muted rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
        <CalendarDays size={20} strokeWidth={2.5} />
      </div>
      <div class="min-w-0">
        <p class="text-text-muted text-2xs mb-0.5 font-bold">
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

    <div
      class="bg-cn-surface flex items-center gap-3.5 rounded-2xl border border-black/5 p-4 shadow-sm md:col-span-2 dark:border-white/5"
    >
      <div class="text-text-muted rounded-xl bg-black/5 p-2.5 dark:bg-black/40">
        <MapPin size={20} strokeWidth={2.5} />
      </div>
      <div class="min-w-0">
        <p class="text-text-muted text-2xs mb-0.5 font-bold">{m.profile_info_schooling_label()}</p>
        <p class="text-text-main text-sm font-bold" data-testid="profile-schooling">{schooling}</p>
      </div>
    </div>
  </div>

  <!-- THE CORRECTION REQUEST LIVES HERE (owner, 2026-11-10), beside the formation and campus it
       corrects, no longer in the profile header. -->
  <ProfileCorrectionRequest />
</ProfileCard>
