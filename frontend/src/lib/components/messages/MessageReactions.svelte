<script lang="ts">
  import { getUserDisplayNameSync, resolveUserDisplayName } from '$lib/utils/users/displayName';
  import { m } from '$lib/paraglide/messages';

  function firstNameOnly(value: string): string {
    const cleaned = value.trim();
    if (!cleaned) return value;
    if (cleaned.includes('@')) {
      const local = cleaned.split('@')[0];
      return local.split('.')[0];
    }
    return cleaned.split(' ')[0];
  }

  interface Props {
    /** Emoji-keyed map of user IDs who have reacted with each emoji. */
    groupedReactions: Record<string, string[]>;
    /** When true, aligns the reaction row to the right (own messages). */
    isOwn?: boolean;
    /** ID of the current user, used to highlight their own reactions. */
    currentUserId?: string;
    /** Called when the user clicks a reaction badge to toggle their own reaction. */
    onReact?: (emoji: string) => void;
  }

  let { groupedReactions = {}, isOwn = false, currentUserId, onReact }: Props = $props();

  // Resolved display names: userId → first name
  let resolvedNames = $state<Record<string, string>>({});

  $effect(() => {
    const allIds = Object.values(groupedReactions).flat();
    const unique = [...new Set(allIds)];
    for (const uid of unique) {
      if (!resolvedNames[uid]) {
        const sync = getUserDisplayNameSync(uid);
        resolvedNames[uid] = firstNameOnly(sync || m.user_unknown_label());
        // Async refresh
        resolveUserDisplayName(uid).then((name) => {
          if (name) resolvedNames = { ...resolvedNames, [uid]: firstNameOnly(name) };
        });
      }
    }
  });

  function resolveNames(userIds: string[]): string {
    return userIds.map((id) => resolvedNames[id] || m.user_unknown_label()).join(', ');
  }
</script>

{#if Object.keys(groupedReactions).length > 0}
  <!--
    NOTHING IS CLIPPED HERE, AND THAT USED TO BE FALSE IN SILENCE.
    This row carried `max-h-[5.5rem] overflow-hidden`: 88px of box for content that grows with the
    number of DISTINCT emoji on a message. Measured on A1 (Mi 9T, 436 x 945) on 2026-09-14 by
    injecting chips into the live row: at 37 distinct reactions the content stood 184px and the box
    still 88, so 21 chips were drawn and SIXTEEN simply did not exist on screen - no half-cut chip
    betraying the fold, no "+16", no scroll. A deliberate cap shows a count; this one showed nothing,
    which is how it survived unnoticed.
    The number was never a decision either: it was `4.75rem` with no comment, and became `5.5rem`
    inside a commit about the media lightbox. So it is removed rather than tuned - a wrapping row is
    honest at every count, needs no state, and invents no threshold. A message with forty distinct
    reactions is tall, and being tall is the truth about it.
  -->
  <div
    class="mt-1 flex w-full max-w-[min(100%,38rem)] flex-wrap content-start gap-1.5 px-1 pt-0.5 pb-2 {isOwn
      ? 'justify-end'
      : 'justify-start'}"
    role="group"
    aria-label={m.msg_reactions_label()}
  >
    {#each Object.entries(groupedReactions) as [emoji, users] (emoji)}
      <!-- Check whether the current user has reacted with this emoji. -->
      {@const hasReacted = currentUserId ? users.includes(currentUserId) : false}

      <button
        type="button"
        class="flex shrink-0 items-center gap-1.5 rounded-xl border px-2.5 py-1 text-sm shadow-sm transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 active:scale-95 {hasReacted
          ? 'border-amber-500/30 bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:border-amber-500/20 dark:bg-amber-500/20 dark:text-amber-400'
          : 'text-text-muted hover:text-text-main bg-cn-surface border-black/5 hover:bg-black/5 dark:border-white/10 dark:hover:bg-black/50'}"
        onclick={(e) => {
          e.stopPropagation(); // Prevent opening message info when clicking a reaction badge.
          onReact?.(emoji);
        }}
        title={resolveNames(users)}
        aria-pressed={hasReacted}
        aria-label={users.length === 1
          ? m.msg_reaction_aria_label_one({ emoji })
          : m.msg_reaction_aria_label({ emoji, count: users.length })}
      >
        <span class="text-base leading-none drop-shadow-sm">{emoji}</span>
        {#if users.length > 1}
          <span class="text-2xs font-bold">{users.length}</span>
        {/if}
      </button>
    {/each}
  </div>
{/if}
