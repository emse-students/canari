<script lang="ts">
  import { onMount } from 'svelte';
  import { notificationPreferences } from '$lib/stores/notificationPreferences.svelte';
  import {
    NOTIFICATION_CATEGORIES,
    type NotificationCategory,
  } from '$lib/notifications/categories';
  import { m } from '$lib/paraglide/messages';
  import SettingsAccountBells from './SettingsAccountBells.svelte';
  import { resetSuggestions } from '$lib/follows/suggestions.svelte';
  import { Log } from '$lib/utils/Log';
  import Toggle from '$lib/components/ui/Toggle.svelte';

  /**
   * One switch per notification category, per ACCOUNT: the choice is stored server-side, which
   * applies it before it sends a push, and this device applies the same set to the notifications it
   * raises itself. All on by default; an opt-in category (`OPT_IN_CATEGORIES`: Suggestions) also has
   * a PUSH switch, off by default (owner, "Deux niveaux", 2026-11-11). Labels are listed here, not derived, so each stays a literal
   * Paraglide call the compiler can see.
   */
  const COPY: Record<NotificationCategory, { label: () => string; desc: () => string }> = {
    messages: { label: m.settings_notif_messages_label, desc: m.settings_notif_messages_desc },
    channels: { label: m.settings_notif_channels_label, desc: m.settings_notif_channels_desc },
    posts: { label: m.settings_notif_posts_label, desc: m.settings_notif_posts_desc },
    comments: { label: m.settings_notif_comments_label, desc: m.settings_notif_comments_desc },
    mentions: { label: m.settings_notif_mentions_label, desc: m.settings_notif_mentions_desc },
    reactions: { label: m.settings_notif_reactions_label, desc: m.settings_notif_reactions_desc },
    events: { label: m.settings_notif_events_label, desc: m.settings_notif_events_desc },
    forms: { label: m.settings_notif_forms_label, desc: m.settings_notif_forms_desc },
    follows: { label: m.settings_notif_follows_label, desc: m.settings_notif_follows_desc },
    bookings: { label: m.settings_notif_bookings_label, desc: m.settings_notif_bookings_desc },
    birthdays: { label: m.settings_notif_birthdays_label, desc: m.settings_notif_birthdays_desc },
    suggestions: {
      label: m.settings_notif_suggestions_label,
      desc: m.settings_notif_suggestions_desc,
    },
  };

  let loadError = $state(false);
  let saveError = $state(false);

  onMount(async () => {
    loadError = !(await notificationPreferences.load());
  });

  async function toggle(category: NotificationCategory) {
    saveError = false;
    const ok = await notificationPreferences.setEnabled(
      category,
      !notificationPreferences.isEnabled(category)
    );
    saveError = !ok;
    // "Suggestions dans l'app" also covers the follow suggestions the feed read once (owner, "Deux
    // niveaux", 2026-11-11): the read this session holds was answered for the old choice, so it is
    // forgotten and the next feed asks again.
    if (ok && category === 'suggestions') {
      Log.d('SETTINGS', 'suggestions switch changed - the follow suggestions read is forgotten');
      resetSuggestions();
    }
  }

  /** The PUSH of an opt-in category: off by default, and turning it on turns the category on too. */
  async function togglePush(category: NotificationCategory) {
    saveError = false;
    const on = !notificationPreferences.isPushEnabled(category);
    Log.d('SETTINGS', `push of ${category}: ${on ? 'on' : 'off'}`);
    const wasOn = notificationPreferences.isEnabled(category);
    const ok = await notificationPreferences.setPushEnabled(category, on);
    saveError = !ok;
    if (ok && !wasOn && category === 'suggestions') resetSuggestions();
  }

  /** The copy of each opt-in category's push switch. */
  const PUSH_COPY: Partial<
    Record<NotificationCategory, { label: () => string; desc: () => string }>
  > = {
    suggestions: {
      label: m.settings_notif_suggestions_push_label,
      desc: m.settings_notif_suggestions_push_desc,
    },
  };
</script>

<div
  class="border-cn-border animate-in fade-in slide-in-from-bottom-4 rounded-2xl border bg-(--cn-surface) p-6 shadow-sm delay-200 duration-500 md:p-8"
  style="animation-fill-mode: backwards;"
>
  <div class="mb-6 flex items-center gap-3">
    <div>
      <h2 class="sr-only">{m.settings_notifications_heading()}</h2>
      <p class="text-text-muted text-xs font-medium">
        {m.settings_notifications_subtitle()}
      </p>
    </div>
  </div>

  {#if loadError}
    <p class="mb-4 rounded-xl bg-red-500/10 px-4 py-3 text-sm font-medium text-red-600">
      {m.settings_notifications_load_error()}
    </p>
  {/if}
  {#if saveError}
    <p class="mb-4 rounded-xl bg-red-500/10 px-4 py-3 text-sm font-medium text-red-600">
      {m.settings_notifications_save_error()}
    </p>
  {/if}

  <div class="space-y-5">
    {#each NOTIFICATION_CATEGORIES as category (category)}
      {@const on = notificationPreferences.isEnabled(category)}
      <div class="flex items-center justify-between gap-4" data-category={category}>
        <div>
          <p class="text-text-main text-sm font-bold">{COPY[category].label()}</p>
          <p class="text-text-muted mt-0.5 text-xs font-medium">{COPY[category].desc()}</p>
        </div>

        <button
          role="switch"
          aria-checked={on}
          aria-label={m.settings_notif_switch_aria({ category: COPY[category].label() })}
          onclick={() => void toggle(category)}
          class="focus-visible:ring-accent-icon relative h-6 w-12 shrink-0 rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-offset-2
 {on ? 'bg-accent' : 'bg-black/20 dark:bg-white/15'}"
        >
          <span
            class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200
 {on ? 'translate-x-6' : 'translate-x-0'}"
          ></span>
        </button>
      </div>
      {@const push = PUSH_COPY[category]}
      {#if push}
        {@const pushOn = notificationPreferences.isPushEnabled(category)}
        <div data-category-push={category}>
          <Toggle
            layout="row"
            checked={pushOn}
            label={push.label()}
            hint={push.desc()}
            onchange={() => void togglePush(category)}
          />
        </div>
      {/if}
    {/each}
  </div>

  <SettingsAccountBells />
</div>
