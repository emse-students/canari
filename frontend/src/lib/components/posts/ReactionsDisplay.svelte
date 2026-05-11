<script lang="ts">
  import { resolveUserDisplayName, getUserDisplayNameSync } from '$lib/utils/users/displayName';
  import { portal } from '$lib/actions/portal';

  interface Props {
    reactionCounts: Record<string, number>;
    reactions: Record<string, string>; // userId → reactionType
    userReaction: string | null;
    reactionList: Array<{ type: string; emoji: string; icon: string }>;
    onReactionClick: (reactionType: string) => void;
  }

  let { reactionCounts, reactions, userReaction, reactionList, onReactionClick }: Props = $props();

  let popupReactionType = $state<string | null>(null);
  let popupPos = $state<{ top: number; left: number } | null>(null);
  let resolvedNames = $state<Record<string, string[]>>({});

  async function openPopup(reactionType: string, anchor: HTMLElement) {
    if (popupReactionType === reactionType) {
      popupReactionType = null;
      return;
    }
    const rect = anchor.getBoundingClientRect();
    popupPos = { top: rect.bottom + 6, left: rect.left };
    popupReactionType = reactionType;

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

  function closePopup() {
    popupReactionType = null;
    popupPos = null;
  }
</script>

{#if Object.keys(reactionCounts).length > 0}
  <div class="px-5 py-2 border-b border-cn-border/40 flex flex-wrap gap-2">
    {#each Object.entries(reactionCounts) as [reactionType, count] (reactionType)}
      {@const reaction = reactionList.find((r) => r.type === reactionType)}
      <button
        type="button"
        onclick={(e) => {
          e.stopPropagation();
          openPopup(reactionType, e.currentTarget as HTMLElement);
        }}
        ondblclick={() => onReactionClick(reactionType)}
        class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full transition-all {userReaction === reactionType
          ? 'bg-cn-yellow/20 ring-1 ring-cn-yellow'
          : 'bg-[var(--cn-surface)] hover:bg-cn-yellow/10'}"
        title="Cliquer pour voir · Double-cliquer pour réagir"
      >
        <span class="text-lg">{reaction?.emoji ?? '😊'}</span>
        <span class="text-sm font-bold text-text-main">{count}</span>
      </button>
    {/each}
  </div>
{/if}

<!-- Popup "Qui a réagi" -->
{#if popupReactionType && popupPos}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div use:portal class="fixed inset-0 z-[9998]" onclick={closePopup} onkeydown={(e) => e.key === 'Escape' && closePopup()}></div>
  <div
    use:portal
    class="fixed z-[9999] min-w-[10rem] max-w-[14rem] rounded-xl bg-[#1a2236] text-white text-[0.75rem] font-medium shadow-xl px-3 py-2.5"
    style="top: {popupPos.top}px; left: {popupPos.left}px;"
    role="dialog"
    aria-label="Personnes ayant réagi"
  >
    <p class="font-bold text-white/60 uppercase tracking-wide text-[0.6rem] mb-1.5">
      {reactionList.find((r) => r.type === popupReactionType)?.emoji ?? '😊'} {popupReactionType}
    </p>
    {#if popupReactionType && resolvedNames[popupReactionType]}
      <ul class="space-y-0.5">
        {#each resolvedNames[popupReactionType] as name (name)}
          <li class="truncate">{name}</li>
        {/each}
      </ul>
    {:else}
      <p class="opacity-60 italic">Chargement…</p>
    {/if}
    <p class="text-[0.6rem] text-white/40 mt-2">Double-clic pour réagir</p>
  </div>
{/if}
