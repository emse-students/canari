<script lang="ts">
  import { onMount } from 'svelte';
  import { Cake } from '@lucide/svelte';
  import ProfileCard from '$lib/components/profile/ProfileCard.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import { CONTROL_LABEL_CLASS } from '$lib/components/ui/controlClasses';
  import type { PickerOption } from '$lib/components/ui/picker';
  import {
    BIRTHDAY_CHANGE_TOO_SOON,
    BIRTHDAY_VISIBILITIES,
    DEFAULT_BIRTHDAY_VISIBILITY,
    clearMyBirthday,
    fetchMyBirthday,
    saveMyBirthday,
    type BirthdayVisibility,
    type OwnBirthday,
    type OwnBirthdayState,
  } from '$lib/birthdays/api';
  import {
    birthdayMonthNames,
    daysInBirthdayMonth,
    formatCalendarDate,
    isBirthdayDate,
  } from '$lib/birthdays/birthdayDate';
  import { ApiRefusalError } from '$lib/utils/apiRefusalError';
  import { ownBirthday } from '$lib/birthdays/birthdaysToday.svelte';
  import { currentUserId } from '$lib/stores/user';
  import { showToast } from '$lib/stores/toast.svelte';
  import { getLocale } from '$lib/paraglide/runtime';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * THE MEMBER'S BIRTHDAY (owner, 2026-11-08; docs/wiki/birthdays.md): a day and a month - never a
   * year - and who sees the date outside the day, FOLLOWERS by default. The profile section is the
   * entry point; the one-time prompt card opens it. Saving and removing are each one request, and
   * the state the server answers is what the form shows next.
   *
   * A NEW date counts from the next day and cannot change again for 30 days (a removal then a new
   * date included): said before the first save, and while the window is open the date selects are
   * locked with the day it opens - the server's `changeOpensOn`, so the form never learns it by
   * being refused. Who sees the date, and removing it, stay free.
   */

  /** Each choice's label and one-line consequence, listed so each stays a literal Paraglide call. */
  const VISIBILITY_COPY: Record<BirthdayVisibility, { label: () => string; hint: () => string }> = {
    school: {
      label: m.profile_birthday_visibility_school,
      hint: m.profile_birthday_visibility_school_hint,
    },
    followers: {
      label: m.profile_birthday_visibility_followers,
      hint: m.profile_birthday_visibility_followers_hint,
    },
    nobody: {
      label: m.profile_birthday_visibility_nobody,
      hint: m.profile_birthday_visibility_nobody_hint,
    },
  };

  const monthNames = birthdayMonthNames(getLocale());
  /** The twelve months, January first; the value is the month number. */
  const monthOptions: PickerOption[] = monthNames.map((name, index) => ({
    value: String(index + 1),
    label: name,
  }));

  let loading = $state(true);
  let loadFailed = $state(false);
  let busy = $state(false);
  /** What the server holds, `null` when nothing is entered. */
  let stored = $state<OwnBirthday | null>(null);
  /** `YYYY-MM-DD`: the first day a NEW date is accepted, `null` when one is now. */
  let changeOpensOn = $state<string | null>(null);
  /** The form: 0 means "not chosen yet". */
  let month = $state(0);
  let day = $state(0);
  let visibility = $state<BirthdayVisibility>(DEFAULT_BIRTHDAY_VISIBILITY);

  const dayCount = $derived(month > 0 ? daysInBirthdayMonth(month) : 31);
  /** The days the chosen month has (29 for February: a birthday some years have). */
  const dayOptions = $derived<PickerOption[]>(
    Array.from({ length: dayCount }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))
  );
  const valid = $derived(isBirthdayDate(month, day));
  const dateLocked = $derived(changeOpensOn !== null);
  const opensLabel = $derived(
    changeOpensOn ? formatCalendarDate(changeOpensOn, getLocale()) : null
  );
  const unchanged = $derived(
    stored !== null &&
      stored.month === month &&
      stored.day === day &&
      stored.visibility === visibility
  );

  // A day the new month does not have (31 then April) is cleared rather than silently moved.
  $effect(() => {
    if (day > dayCount) day = 0;
  });

  function show(state: OwnBirthdayState) {
    const value = state.birthday;
    stored = value;
    changeOpensOn = state.changeOpensOn;
    month = value?.month ?? 0;
    day = value?.day ?? 0;
    visibility = value?.visibility ?? DEFAULT_BIRTHDAY_VISIBILITY;
    const account = currentUserId();
    if (account) ownBirthday.set(account, value !== null);
  }

  onMount(async () => {
    try {
      show(await fetchMyBirthday());
    } catch (e) {
      Log.d('profile.birthday load failed', e);
      loadFailed = true;
    } finally {
      loading = false;
    }
  });

  async function save() {
    if (!valid) return;
    busy = true;
    try {
      show(await saveMyBirthday({ month, day, visibility }));
      showToast(m.profile_birthday_saved(), 'info');
    } catch (e) {
      Log.d('profile.birthday save failed', e);
      if (e instanceof ApiRefusalError && e.code === BIRTHDAY_CHANGE_TOO_SOON) {
        // Another device changed it first: say so, and show the server's state and its window.
        showToast(m.profile_birthday_change_too_soon());
        try {
          show(await fetchMyBirthday());
        } catch (reload) {
          Log.d('profile.birthday reload after refusal failed', reload);
        }
      } else {
        showToast(m.profile_birthday_save_error());
      }
    } finally {
      busy = false;
    }
  }

  async function remove() {
    busy = true;
    try {
      show(await clearMyBirthday());
      showToast(m.profile_birthday_removed(), 'info');
    } catch (e) {
      Log.d('profile.birthday remove failed', e);
      showToast(m.profile_birthday_save_error());
    } finally {
      busy = false;
    }
  }
</script>

<ProfileCard icon={Cake} heading={m.profile_birthday_heading()} {loading}>
  <p class="text-text-muted mb-5 text-sm">{m.profile_birthday_intro()}</p>

  {#if loadFailed}
    <p class="text-sm font-medium text-red-600 dark:text-red-400" role="alert">
      {m.profile_birthday_load_error()}
    </p>
  {:else if !loading}
    <div class="grid grid-cols-2 gap-3">
      <Select
        id="birthday-day"
        label={m.profile_birthday_day_label()}
        placeholder={m.profile_birthday_day_label()}
        value={day > 0 ? String(day) : ''}
        options={dayOptions}
        disabled={busy || dateLocked}
        onValueChange={(v) => (day = Number(v))}
      />
      <Select
        id="birthday-month"
        label={m.profile_birthday_month_label()}
        placeholder={m.profile_birthday_month_label()}
        value={month > 0 ? String(month) : ''}
        options={monthOptions}
        disabled={busy || dateLocked}
        onValueChange={(v) => (month = Number(v))}
      />
    </div>

    <fieldset class="mt-5">
      <legend class={CONTROL_LABEL_CLASS}>{m.profile_birthday_visibility_label()}</legend>
      <div class="space-y-2">
        {#each BIRTHDAY_VISIBILITIES as choice (choice)}
          <label
            class="border-cn-border flex cursor-pointer items-start gap-3 rounded-xl border p-3 {visibility ===
            choice
              ? 'bg-cn-yellow/10'
              : ''}"
          >
            <input
              type="radio"
              name="birthday-visibility"
              value={choice}
              bind:group={visibility}
              disabled={busy}
              class="accent-cn-yellow mt-1"
            />
            <span>
              <span class="text-text-main block text-sm font-bold">
                {VISIBILITY_COPY[choice].label()}
              </span>
              <span class="text-text-muted block text-xs">{VISIBILITY_COPY[choice].hint()}</span>
            </span>
          </label>
        {/each}
      </div>
    </fieldset>

    <p class="text-text-muted mt-4 text-xs">{m.profile_birthday_ring_note()}</p>
    {#if opensLabel}
      <p class="text-text-muted mt-2 text-xs" data-testid="birthday-change-opens">
        {m.profile_birthday_change_opens({ date: opensLabel })}
      </p>
    {:else}
      <p class="text-text-muted mt-2 text-xs">{m.profile_birthday_takes_effect()}</p>
    {/if}

    <div class="mt-5 flex flex-wrap gap-2">
      <Button
        onclick={() => void save()}
        disabled={!valid || unchanged || (dateLocked && !stored)}
        loading={busy}
      >
        {m.profile_birthday_save()}
      </Button>
      {#if stored}
        <Button variant="ghost" onclick={() => void remove()} disabled={busy}>
          {m.profile_birthday_remove()}
        </Button>
      {/if}
    </div>
  {/if}
</ProfileCard>
