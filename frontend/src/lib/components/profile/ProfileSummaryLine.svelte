<script lang="ts">
  import { fetchUserBirthday, type ViewedBirthday } from '$lib/birthdays/api';
  import { formatBirthday } from '$lib/birthdays/birthdayDate';
  import type { UserProfile } from '$lib/stores/user';
  import { campusLabel, postLabel } from '$lib/profile/miconnectProfile';
  import { getLocale } from '$lib/paraglide/runtime';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  interface Props {
    /** The member whose profile this is. */
    userId: string;
    profile: Pick<UserProfile, 'cursus' | 'posts' | 'campus'>;
    /** The reader's own profile: "Joyeux anniversaire" rather than "C'est son anniversaire". */
    self?: boolean;
  }

  let { userId, profile, self = false }: Props = $props();

  /**
   * THE ONE MUTED LINE UNDER A NAME (owner, 2026-11-10: "affichage ameliorable" - four pills and an
   * "Anniversaire le ..." sentence replaced by one calm line): "ICM · Saint-Etienne · 🎂 18 juillet" -
   * every formation of the cursus, the posts, the campus and the birthday WHEN the server's
   * visibility rule lets the reader see it (docs/wiki/birthdays.md). No pill, no icon.
   *
   * On the day itself a second line says it is their birthday - which the server answers for
   * everybody (decision 3). The birthday is asked per profile, never cached; a failure or an unknown
   * answer shows nothing, since the profile is complete without it.
   */
  let viewed = $state<ViewedBirthday | null>(null);

  $effect(() => {
    const subject = userId;
    viewed = null;
    let cancelled = false;
    fetchUserBirthday(subject)
      .then((answer) => {
        if (!cancelled) viewed = answer;
      })
      .catch((e: unknown) => Log.d('profile.birthday read failed', e));
    return () => {
      cancelled = true;
    };
  });

  const parts = $derived.by(() => {
    const out: string[] = [];
    for (const entry of profile.cursus ?? []) out.push(entry.formation);
    for (const post of profile.posts ?? []) out.push(postLabel(post));
    if (profile.campus) out.push(campusLabel(profile.campus));
    if (viewed?.birthday) {
      out.push(m.profile_birthday_chip({ date: formatBirthday(viewed.birthday, getLocale()) }));
    }
    return out;
  });
</script>

{#if parts.length > 0}
  <p class="text-text-muted text-sm wrap-break-word" data-profile-summary>
    {parts.join(' · ')}
  </p>
{/if}
{#if viewed?.today}
  <p class="text-cn-dark mt-1 text-sm font-bold" data-testid="birthday-today">
    {self ? m.profile_birthday_today_self() : m.profile_birthday_today()}
  </p>
{/if}
