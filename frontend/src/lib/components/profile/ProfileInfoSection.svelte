<script lang="ts">
  import { CalendarDays, GraduationCap, Info } from '@lucide/svelte';
  import type { UserProfile } from '$lib/stores/user';
  import ProfileCard from '$lib/components/profile/ProfileCard.svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  let { profile }: { profile: UserProfile } = $props();

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
        <p class="text-text-muted text-2xs mb-0.5 font-bold tracking-wider uppercase">
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
        <p class="text-text-muted text-2xs mb-0.5 font-bold tracking-wider uppercase">
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
</ProfileCard>
