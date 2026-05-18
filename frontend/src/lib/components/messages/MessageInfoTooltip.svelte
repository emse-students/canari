<script lang="ts">
  import { formatTime24 } from '$lib/utils/dates';
  import { fly } from 'svelte/transition';
  import { SvelteSet } from 'svelte/reactivity';
  import { Clock, Pencil, CheckCheck } from '@lucide/svelte';
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';

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

  function firstNameOnly(value: string): string {
    const cleaned = value.trim();
    if (!cleaned) return value;
    if (cleaned.includes('@')) return cleaned.split('@')[0];
    const parts = cleaned.split(/\s+/).filter(Boolean);
    return parts[0] || cleaned;
  }

  $effect(() => {
    const ids = new SvelteSet<string>();
    for (const id of readBy) ids.add(id);

    for (const userId of ids) {
      if (!resolvedReadByNames[userId]) {
        const cached = getUserDisplayNameSync(userId, userId);
        if (cached !== userId) {
          resolvedReadByNames = { ...resolvedReadByNames, [userId]: cached };
        }
      }
      resolveUserDisplayName(userId).then((resolved) => {
        if (!resolved || resolvedReadByNames[userId] === resolved) return;
        resolvedReadByNames = { ...resolvedReadByNames, [userId]: resolved };
      });
    }
  });

  let readByLabels = $derived(
    readBy.map((userId) => firstNameOnly(resolvedReadByNames[userId] || userId))
  );
</script>

{#if visible}
  <div
    class="absolute {isOwn
      ? 'right-0'
      : 'left-0'} top-full mt-1.5 px-3.5 py-2.5 bg-white/90 dark:bg-black/80 backdrop-blur-xl border border-black/5 dark:border-white/10 text-text-main text-[0.7rem] rounded-xl shadow-xl shadow-black/10 dark:shadow-black/40 z-50 whitespace-nowrap flex flex-col gap-1.5 pointer-events-none"
    in:fly={{ y: -4, duration: 200, opacity: 0, easing: (t) => t * (2 - t) }}
  >
    <!-- Heure d'envoi -->
    <div class="flex items-center gap-1.5 opacity-90">
      <Clock size={12} class="text-text-muted shrink-0" />
      <span>
        Envoyé à <span class="font-semibold">{formatTime24(timestamp)}</span>
      </span>
    </div>

    <!-- Heure de modification (si applicable) -->
    {#if isEdited}
      <div class="flex items-center gap-1.5 opacity-90">
        <Pencil size={12} class="text-text-muted shrink-0" />
        <span>
          Modifié {#if editedAt}à <span class="font-semibold">{formatTime24(editedAt)}</span
            >{/if}
        </span>
      </div>
    {/if}

    <!-- Liste de lecture -->
    {#if readBy.length > 0}
      <div
        class="flex items-center gap-1.5 mt-1 pt-1.5 border-t border-black/5 dark:border-white/10"
      >
        <CheckCheck size={14} strokeWidth={2.5} class="text-amber-500 shrink-0" />
        <span class="font-medium text-text-muted">
          Lu par <span class="font-bold text-text-main">{readByLabels.join(', ')}</span>
        </span>
      </div>
    {/if}
  </div>
{/if}
