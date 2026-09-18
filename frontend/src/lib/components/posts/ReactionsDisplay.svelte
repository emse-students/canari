<script lang="ts">
  import ReactorsPanel from '$lib/components/shared/ReactorsPanel.svelte';

  interface Props {
    /** Aggregated count of each reaction type across all users. */
    reactionCounts: Record<string, number>;
    /** Map of userId to their chosen reaction type, used to resolve voter names. */
    reactions: Record<string, string>;
    /** The reaction type the current user has applied, or null if none. */
    userReaction: string | null;
    /** Full catalogue of available reaction types with their display emoji. */
    reactionList: ReadonlyArray<{ type: string; emoji: string }>;
    /** Called when the user clicks a reaction badge to toggle their own reaction of the same type. */
    onReactionClick: (reactionType: string) => void;
  }

  let { reactionCounts, reactions, userReaction, reactionList, onReactionClick }: Props = $props();

  let popupReactionType = $state<string | null>(null);
  let anchorEl = $state<HTMLElement | null>(null);
  let panel = $state<ReturnType<typeof ReactorsPanel> | null>(null);

  const reactorsOf = $derived(
    Object.entries(reactions)
      .filter(([, type]) => type === popupReactionType)
      .map(([uid]) => uid)
  );

  function onBadgeEnter(reactionType: string, anchor: HTMLElement) {
    anchorEl = anchor;
    popupReactionType = reactionType;
  }

  function closePopup() {
    popupReactionType = null;
    anchorEl = null;
  }
</script>

<!--
  A STRIP, NOT A ROW. This drew its own bordered band under the action bar - 49 px on A1 (Mi 9T,
  436 x 945 CSS px) measured 2026-09-14, to carry a single badge reading one emoji and the digit 1.
  Facebook puts the same tally at the right edge of the action bar itself and owns no row for it, so
  this now renders inside `PostActions` and keeps only what is its own: the badges, and the "who
  reacted" panel, which is `ReactorsPanel` and is shared with the chat.

  `flex-nowrap` because it shares a 44 px line: badges past the card's width are clipped rather than
  wrapped, which is what keeps the bar one line high whatever the post collected.

  A reader's own reaction is marked by a TINT, not by a bright ring around the pill. The ring was a
  second outline inside a card that already has one, and it sat beside a button now showing that same
  emoji - two loud signals for one fact, which is what made the badge read as an alert.
-->
{#if Object.keys(reactionCounts).length > 0}
  <div class="flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden">
    {#each Object.entries(reactionCounts) as [reactionType, count] (reactionType)}
      {@const reaction = reactionList.find((r) => r.type === reactionType)}
      <button
        type="button"
        onclick={() => onReactionClick(reactionType)}
        onmouseenter={(e) => onBadgeEnter(reactionType, e.currentTarget as HTMLElement)}
        onmouseleave={() => panel?.scheduleHide()}
        class="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 transition-all {userReaction ===
        reactionType
          ? 'bg-cn-yellow/15'
          : 'hover:bg-cn-yellow/10 bg-(--cn-surface)'}"
        title={reaction?.type}
      >
        <span class="text-lg">{reaction?.emoji ?? '😊'}</span>
        <span class="text-text-main text-sm font-bold">{count}</span>
      </button>
    {/each}
  </div>
{/if}

<ReactorsPanel
  bind:this={panel}
  anchor={anchorEl}
  emoji={popupReactionType
    ? (reactionList.find((r) => r.type === popupReactionType)?.emoji ?? '😊')
    : null}
  label={popupReactionType ?? undefined}
  userIds={reactorsOf}
  onClose={closePopup}
/>
