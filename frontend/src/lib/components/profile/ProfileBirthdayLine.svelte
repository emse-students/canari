<script lang="ts">
  import { Cake } from '@lucide/svelte';
  import { fetchUserBirthday, type ViewedBirthday } from '$lib/birthdays/api';
  import { formatBirthday } from '$lib/birthdays/birthdayDate';
  import { getLocale } from '$lib/paraglide/runtime';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  interface Props {
    /** The member whose profile this is. */
    userId: string;
    /** The reader's own profile: "Joyeux anniversaire" rather than "C'est son anniversaire". */
    self?: boolean;
  }

  let { userId, self = false }: Props = $props();

  /**
   * A MEMBER'S BIRTHDAY ON THEIR PROFILE (docs/wiki/birthdays.md): the date when the server's
   * visibility rule lets the reader see it, and on the day the line saying it is their birthday -
   * which the server answers for everybody (decision 3). Nothing is shown while unknown, and a
   * failure shows nothing: the profile is complete without it. Asked per profile, never cached.
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

  const dateLabel = $derived(
    viewed?.birthday ? formatBirthday(viewed.birthday, getLocale()) : null
  );
</script>

{#if viewed?.today}
  <p
    class="text-cn-dark mt-2 inline-flex items-center gap-1.5 text-sm font-bold"
    data-testid="birthday-today"
  >
    <Cake size={16} strokeWidth={2.5} />
    {self ? m.profile_birthday_today_self() : m.profile_birthday_today()}
  </p>
{/if}
{#if dateLabel}
  <p class="text-text-muted mt-1 text-sm" data-testid="birthday-date">
    {m.profile_birthday_on({ date: dateLabel })}
  </p>
{/if}
