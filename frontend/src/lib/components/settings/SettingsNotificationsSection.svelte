<script lang="ts">
  import { onMount } from 'svelte';
  import { Bell } from '@lucide/svelte';
  import { notificationPreferences } from '$lib/stores/notificationPreferences.svelte';
  import {
    NOTIFICATION_CATEGORIES,
    type NotificationCategory,
  } from '$lib/notifications/categories';
  import { m } from '$lib/paraglide/messages';

  /**
   * One switch per notification category, per ACCOUNT: the choice is stored server-side, which
   * applies it before it sends a push, and this device applies the same set to the notifications it
   * raises itself. All on by default. Labels are listed here, not derived, so each stays a literal
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
  }
</script>

<div
  class="border-cn-border animate-in fade-in slide-in-from-bottom-4 rounded-2xl border bg-(--cn-surface) p-6 shadow-sm delay-200 duration-500 md:p-8"
  style="animation-fill-mode: backwards;"
>
  <div class="mb-6 flex items-center gap-3">
    <div class="bg-cn-yellow/10 text-cn-dark rounded-xl p-2.5">
      <Bell size={22} strokeWidth={2.5} />
    </div>
    <div>
      <h2 class="text-text-main text-lg font-bold">{m.settings_notifications_heading()}</h2>
      <p class="text-text-muted mt-0.5 text-xs font-medium">
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
          class="focus-visible:ring-cn-yellow relative h-6 w-12 shrink-0 rounded-full transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-offset-2
 {on ? 'bg-cn-yellow' : 'bg-black/20 dark:bg-white/15'}"
        >
          <span
            class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200
 {on ? 'translate-x-6' : 'translate-x-0'}"
          ></span>
        </button>
      </div>
    {/each}
  </div>
</div>
