<script lang="ts">
  import { formatTime24 } from '$lib/utils/dates';
  import { fly } from 'svelte/transition';
  import { untrack } from 'svelte';
  import { Log } from '$lib/utils/Log';
  import { Clock, Pencil, CheckCheck } from '@lucide/svelte';
  import {
    getUserDisplayNameSync,
    getUserFirstNameSync,
    resolveUserDisplayName,
  } from '$lib/utils/users/displayName';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Whether the tooltip is currently visible. */
    visible: boolean;
    /** Send time of the message. */
    timestamp: Date;
    /** Last edit time, shown only when isEdited is true. */
    editedAt?: Date;
    /** List of user IDs who have read the message. */
    readBy?: string[];
    /** When true, positions the tooltip on the right side (own messages). */
    isOwn?: boolean;
    /** When true, shows an edit row with the editedAt time. */
    isEdited?: boolean;
  }

  let {
    visible = false,
    timestamp,
    editedAt,
    readBy = [],
    isOwn = false,
    isEdited = false,
  }: Props = $props();

  let resolvedReadByNames = $state<Record<string, string>>({});

  /**
   * Names the readers of this message, in TWO writes at most: the names already cached, then the
   * names the network answered. EVERY bubble mounts this tooltip, so it does nothing until the panel
   * is shown, and the map is read untracked: an effect that read the map it writes re-ran once per
   * name resolved and re-resolved every reader each time - O(readers^2) per bubble, 2.4 s of CPU on
   * a 60-reader salon open (community-open-slowness-mi9t-2026-10-13, finding 3).
   */
  function resolveReaders(ids: string[]): void {
    Log.d('MESSAGE', `info panel: resolving ${ids.length} reader name(s)`);
    const known = untrack(() => resolvedReadByNames);
    const cached: Record<string, string> = {};
    for (const userId of ids) {
      if (known[userId]) continue;
      const name = getUserDisplayNameSync(userId, userId);
      if (name !== userId) cached[userId] = name;
    }
    if (Object.keys(cached).length > 0) resolvedReadByNames = { ...known, ...cached };

    void Promise.all(
      ids.map(async (userId) => [userId, await resolveUserDisplayName(userId)] as const)
    ).then((answers) => {
      const current = untrack(() => resolvedReadByNames);
      const fresh: Record<string, string> = {};
      for (const [userId, name] of answers) {
        if (name && current[userId] !== name) fresh[userId] = name;
      }
      if (Object.keys(fresh).length > 0) resolvedReadByNames = { ...current, ...fresh };
    });
  }

  $effect(() => {
    if (!visible) return;
    const ids = [...new Set(readBy)];
    if (ids.length === 0) return;
    untrack(() => resolveReaders(ids));
  });

  let readByLabels = $derived(
    readBy.map((userId) =>
      getUserFirstNameSync(userId, resolvedReadByNames[userId] || m.user_unknown_label())
    )
  );
</script>

{#if visible}
  <div
    class="absolute {isOwn
      ? 'right-0'
      : 'left-0'} text-text-main bg-cn-surface text-2xs top-full z-50 mt-1.5 flex w-max max-w-[min(20rem,calc(100vw-2rem))] flex-col gap-1.5 rounded-xl border border-black/5 px-3.5 py-2.5 shadow-xl shadow-black/10 dark:border-white/10 dark:shadow-black/40"
    in:fly={{ y: -4, duration: 200, opacity: 0, easing: (t) => t * (2 - t) }}
  >
    <!-- Send timestamp. -->
    <div class="flex items-center gap-1.5 opacity-90">
      <Clock size={12} class="text-text-muted shrink-0" />
      <span>
        {m.msg_envoye_a()} <span class="font-semibold">{formatTime24(timestamp)}</span>
      </span>
    </div>

    <!-- Edit timestamp (if applicable). -->
    {#if isEdited}
      <div class="flex items-center gap-1.5 opacity-90">
        <Pencil size={12} class="text-text-muted shrink-0" />
        <span>
          {m.msg_modifie_a()}
          {#if editedAt}<span class="font-semibold">{formatTime24(editedAt)}</span>{/if}
        </span>
      </div>
    {/if}

    <!-- Read receipt list. -->
    {#if readBy.length > 0}
      <div
        class="mt-1 flex items-start gap-1.5 border-t border-black/5 pt-1.5 dark:border-white/10"
      >
        <CheckCheck size={14} strokeWidth={2.5} class="mt-px shrink-0 text-amber-500" />
        <!-- The names WRAP: a long roster used to stay on one line and run off the screen. -->
        <span class="text-text-muted min-w-0 font-medium wrap-break-word">
          {m.msg_lu_par()} <span class="text-text-main font-bold">{readByLabels.join(', ')}</span>
        </span>
      </div>
    {/if}
  </div>
{/if}
