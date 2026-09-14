<script lang="ts">
  import { resolveUserDisplayName, getUserDisplayNameSync } from '$lib/utils/users/displayName';
  import { portal } from '$lib/actions/portal';
  import { m } from '$lib/paraglide/messages';

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
  let popupPos = $state<{ top: number; left: number } | null>(null);
  let resolvedNames = $state<Record<string, string[]>>({});
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  async function loadNames(reactionType: string) {
    if (resolvedNames[reactionType]) return;
    const ids = Object.entries(reactions)
      .filter(([, rt]) => rt === reactionType)
      .map(([uid]) => uid);
    const names = await Promise.all(ids.map((id) => resolveUserDisplayName(id)));
    resolvedNames = {
      ...resolvedNames,
      [reactionType]: names.map((n, i) => n ?? getUserDisplayNameSync(ids[i], ids[i])),
    };
  }

  function onBadgeEnter(reactionType: string, anchor: HTMLElement) {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    const rect = anchor.getBoundingClientRect();
    popupPos = { top: rect.bottom + 6, left: rect.left };
    popupReactionType = reactionType;
    void loadNames(reactionType);
  }

  function scheduleHide() {
    hideTimer = setTimeout(() => {
      popupReactionType = null;
      popupPos = null;
    }, 120);
  }

  function cancelHide() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }
</script>

<!--
  A STRIP, NOT A ROW. This drew its own bordered band under the action bar - 49 px on A1 (Mi 9T,
  436 x 945 CSS px) measured 2026-09-14, to carry a single badge reading one emoji and the digit 1.
  Facebook puts the same tally at the right edge of the action bar itself and owns no row for it, so
  this now renders inside `PostActions` and keeps only what is its own: the badges, and the "who
  reacted" tooltip below.

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
        onmouseleave={scheduleHide}
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

<!-- "Who reacted" tooltip - hover only. -->
{#if popupReactionType && popupPos}
  <div
    use:portal
    class="bg-cn-tooltip text-2xs pointer-events-auto fixed z-(--z-tooltip) max-w-[14rem] min-w-[10rem] rounded-xl px-3 py-2.5 font-medium text-white shadow-xl"
    style="top: {popupPos.top}px; left: {popupPos.left}px;"
    role="tooltip"
    onmouseenter={cancelHide}
    onmouseleave={scheduleHide}
  >
    <p class="text-2xs mb-1.5 font-bold tracking-wide text-white/60 uppercase">
      {reactionList.find((r) => r.type === popupReactionType)?.emoji ?? '😊'}
      {popupReactionType}
    </p>
    {#if popupReactionType && resolvedNames[popupReactionType]}
      <ul class="space-y-0.5">
        {#each resolvedNames[popupReactionType] as name (name)}
          <li class="truncate">{name}</li>
        {/each}
      </ul>
    {:else}
      <p class="italic opacity-60">{m.common_loading_label()}</p>
    {/if}
  </div>
{/if}
