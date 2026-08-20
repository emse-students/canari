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

{#if Object.keys(reactionCounts).length > 0}
  <div class="border-cn-border/40 flex flex-wrap gap-2 border-b px-5 py-2">
    {#each Object.entries(reactionCounts) as [reactionType, count] (reactionType)}
      {@const reaction = reactionList.find((r) => r.type === reactionType)}
      <button
        type="button"
        onclick={() => onReactionClick(reactionType)}
        onmouseenter={(e) => onBadgeEnter(reactionType, e.currentTarget as HTMLElement)}
        onmouseleave={scheduleHide}
        class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 transition-all {userReaction ===
        reactionType
          ? 'bg-cn-yellow/20 ring-cn-yellow ring-1'
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
    class="bg-cn-tooltip pointer-events-auto fixed z-[9999] max-w-[14rem] min-w-[10rem] rounded-xl px-3 py-2.5 text-[0.75rem] font-medium text-white shadow-xl"
    style="top: {popupPos.top}px; left: {popupPos.left}px;"
    role="tooltip"
    onmouseenter={cancelHide}
    onmouseleave={scheduleHide}
  >
    <p class="mb-1.5 text-[0.6rem] font-bold tracking-wide text-white/60 uppercase">
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
