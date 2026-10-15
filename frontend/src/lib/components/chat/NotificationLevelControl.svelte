<script lang="ts">
  /**
   * The Tous / Mentions / Aucune control - ONE component for a salon (`ChannelSettingsPanel`) and a
   * private conversation (`ChatGroupPanel`), which have the same three levels. It draws and reports
   * a choice; persisting it, and reverting a refused write, belong to the caller.
   */
  import { AtSign, Bell, BellOff } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import type { ChannelNotificationLevel } from '$lib/services/ChannelService';

  interface Props {
    /** The level in force, or null when the server has not stated one (nothing is checked). */
    level: ChannelNotificationLevel | null;
    /** The level is being read: no radio group is drawn, since it would state something unknown. */
    loading: boolean;
    /** A write is in flight: the options are disabled so two cannot race. */
    saving: boolean;
    /** What the levels mean for THIS kind of conversation. */
    description: string;
    /** Unique id of the heading the radio group is labelled by. */
    headingId: string;
    /** Why the last choice did not stick (the caller reverted it), or '' when it did. */
    error?: string;
    onSelect: (level: ChannelNotificationLevel) => void;
  }

  let { level, loading, saving, description, headingId, error = '', onSelect }: Props = $props();

  const options = [
    { value: 'all', icon: Bell, label: () => m.chat_channel_notif_all_label() },
    { value: 'mentions', icon: AtSign, label: () => m.chat_channel_notif_mentions_label() },
    { value: 'none', icon: BellOff, label: () => m.chat_channel_notif_none_label() },
  ] as const;
</script>

<div class="space-y-3 pt-2">
  <div class="flex items-center gap-2">
    <Bell size={16} class="text-amber-500" strokeWidth={2.5} />
    <h3 id={headingId} class="text-text-main text-sm font-bold">
      {m.chat_channel_notifications_label()}
    </h3>
  </div>
  <p class="text-text-muted text-xs">{description}</p>
  <!--
    A RADIO GROUP, NOT THREE BUTTONS. These three are mutually exclusive and exactly one is active,
    but the active one used to be marked by colour classes alone - so a screen reader announced three
    identical buttons with no way to say which level was in force. `aria-checked` is the control's own
    answer to that question, it is what assistive technology is told, and it outlives any restyling.

    NOT DRAWN WHILE THE ANSWER IS IN FLIGHT. A radio group is a statement that one of its options is
    in force, so rendering one before the server has answered states something nobody knows - and
    that is exactly how a level silently failed to change. Its presence MEANS the question has been
    answered, one way or the other.
  -->
  {#if loading}
    <div class="text-text-muted px-1 text-xs" aria-busy="true">
      {m.common_loading_label()}
    </div>
  {:else}
    <div
      class="grid grid-cols-3 gap-2"
      role="radiogroup"
      aria-labelledby={headingId}
      aria-busy={saving}
    >
      {#each options as option (option.value)}
        {@const Icon = option.icon}
        <button
          type="button"
          role="radio"
          aria-checked={level === option.value}
          onclick={() => onSelect(option.value)}
          disabled={saving}
          class="flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-xs font-bold transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-50 {level ===
          option.value
            ? 'border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-400'
            : 'text-text-muted border-black/10 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5'}"
        >
          <Icon size={18} strokeWidth={2.5} />
          {option.label()}
        </button>
      {/each}
    </div>
  {/if}
  {#if error}
    <p class="text-xs font-medium text-red-600 dark:text-red-400" role="alert">{error}</p>
  {/if}
</div>
