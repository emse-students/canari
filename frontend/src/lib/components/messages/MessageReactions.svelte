<script lang="ts">
  interface Props {
    groupedReactions: Record<string, string[]>;
    isOwn?: boolean;
    currentUserId?: string; // Ajouté pour savoir quelles réactions mettre en surbrillance
    onReact?: (emoji: string) => void;
  }

  let { groupedReactions = {}, isOwn = false, currentUserId, onReact }: Props = $props();
</script>

{#if Object.keys(groupedReactions).length > 0}
  <div class="flex gap-1.5 flex-wrap mt-2 px-1 {isOwn ? 'justify-end' : 'justify-start'}">
    {#each Object.entries(groupedReactions) as [emoji, users] (emoji)}
      <!-- On vérifie si l'utilisateur actuel a réagi avec cet émoji -->
      {@const hasReacted = currentUserId ? users.includes(currentUserId) : false}

      <button
        type="button"
        class="flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-sm transition-all duration-200 border shadow-sm active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50
          {hasReacted
          ? 'bg-amber-500/15 dark:bg-amber-500/20 border-amber-500/30 dark:border-amber-500/20 text-amber-700 dark:text-amber-400 hover:bg-amber-500/25'
          : 'bg-white/60 dark:bg-black/30 border-black/5 dark:border-white/10 hover:bg-white/90 dark:hover:bg-black/50 text-text-muted hover:text-text-main backdrop-blur-md'}"
        onclick={(e) => {
          e.stopPropagation(); // Empêche d'ouvrir les infos du message en cliquant sur la réaction
          onReact?.(emoji);
        }}
        title={users.join(', ')}
        aria-pressed={hasReacted}
        aria-label="{emoji} ({users.length} personnes)"
      >
        <span class="text-[1.1rem] leading-none drop-shadow-sm">{emoji}</span>
        <span class="text-[0.7rem] font-bold">{users.length}</span>
      </button>
    {/each}
  </div>
{/if}
