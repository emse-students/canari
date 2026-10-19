<script lang="ts">
  /**
   * Calls allowed / not allowed for ONE private conversation - the per-conversation call
   * permission, drawn beside the notification level (`NotificationLevelControl`) and built the same
   * way: a radio group stating the value in force, nothing drawn while it is unknown. It draws and
   * reports a choice; persisting it, and reverting a refused write, belong to the caller.
   */
  import { Phone, PhoneOff } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Whether calls may ring here, or null when the server has not answered (nothing checked). */
    allowed: boolean | null;
    /** The value is being read: no radio group is drawn, since it would state something unknown. */
    loading: boolean;
    /** A write is in flight: the options are disabled so two cannot race. */
    saving: boolean;
    /** Unique id of the heading the radio group is labelled by. */
    headingId: string;
    /** Why the last choice did not stick (the caller reverted it), or '' when it did. */
    error?: string;
    onSelect: (allowed: boolean) => void;
  }

  let { allowed, loading, saving, headingId, error = '', onSelect }: Props = $props();

  const options = [
    { value: true, icon: Phone, label: () => m.chat_calls_permission_allowed_label() },
    { value: false, icon: PhoneOff, label: () => m.chat_calls_permission_refused_label() },
  ] as const;
</script>

<div class="space-y-3 pt-2">
  <div class="flex items-center gap-2">
    <Phone size={16} class="text-amber-500" strokeWidth={2.5} />
    <h3 id={headingId} class="text-text-main text-sm font-bold">
      {m.chat_calls_permission_label()}
    </h3>
  </div>
  <p class="text-text-muted text-xs">{m.chat_calls_permission_description()}</p>
  {#if loading}
    <div class="text-text-muted px-1 text-xs" aria-busy="true">
      {m.common_loading_label()}
    </div>
  {:else}
    <div
      class="grid grid-cols-2 gap-2"
      role="radiogroup"
      aria-labelledby={headingId}
      aria-busy={saving}
    >
      {#each options as option (option.value)}
        {@const Icon = option.icon}
        <button
          type="button"
          role="radio"
          aria-checked={allowed === option.value}
          onclick={() => onSelect(option.value)}
          disabled={saving}
          class="flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-xs font-bold transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-50 {allowed ===
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
