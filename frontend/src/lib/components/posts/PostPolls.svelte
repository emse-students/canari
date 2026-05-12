<script lang="ts">
  import { ChartBar, CircleCheck, Circle, SquareCheck, Square } from 'lucide-svelte';
  import type { Poll } from '$lib/posts/api';
  import { resolveUserDisplayName, getUserDisplayNameSync } from '$lib/utils/users/displayName';
  import { portal } from '$lib/actions/portal';

  interface Props {
    /** Polls attached to the post, or undefined when the post has none. */
    polls: Poll[] | undefined;
    /** Option IDs the current user has selected across all polls. */
    selectedOptions: string[];
    /** Called when the user clicks a poll option to toggle its selection. */
    onToggleOption: (pollId: string, optionId: string, multipleChoice: boolean) => void;
    /** Called when the user clicks the "Voter" button to submit their selection. */
    onSubmitVote: (pollId: string) => void;
  }

  let { polls, selectedOptions, onToggleOption, onSubmitVote }: Props = $props();

  // Tooltip state
  let tooltipOptionId = $state<string | null>(null);
  let voterNames = $state<Record<string, string[]>>({});
  let tooltipPos = $state<{ top: number; right: number } | null>(null);

  function getVoteCount(votes: string[] | number | undefined): number {
    if (Array.isArray(votes)) return votes.length;
    return (votes as number) || 0;
  }

  function getVoterIds(votes: string[] | number | undefined): string[] {
    if (Array.isArray(votes)) return votes;
    return [];
  }

  function getTotalVotes(poll: Poll): number {
    return poll.options.reduce((sum, opt) => sum + getVoteCount(opt.votes), 0);
  }

  function getPercentage(votes: string[] | number | undefined, total: number): number {
    if (total === 0) return 0;
    return Math.round((getVoteCount(votes) / total) * 100);
  }

  async function showVoterTooltip(
    optionId: string,
    votes: string[] | number | undefined,
    anchor?: HTMLElement
  ) {
    const ids = getVoterIds(votes);
    if (ids.length === 0) return;
    tooltipOptionId = optionId;
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      tooltipPos = { top: rect.top, right: window.innerWidth - rect.right };
    }
    if (voterNames[optionId]) return;
    const names = await Promise.all(ids.map((id) => resolveUserDisplayName(id)));
    voterNames = {
      ...voterNames,
      [optionId]: names.map((n, i) => n ?? getUserDisplayNameSync(ids[i], ids[i])),
    };
  }

  function hideTooltip() {
    tooltipOptionId = null;
    tooltipPos = null;
  }

  function toggleTooltip(
    optionId: string,
    votes: string[] | number | undefined,
    anchor?: HTMLElement
  ) {
    if (tooltipOptionId === optionId) {
      hideTooltip();
    } else {
      showVoterTooltip(optionId, votes, anchor);
    }
  }

  function pollCountdown(endsAt: string): string {
    const diff = new Date(endsAt).getTime() - Date.now();
    if (diff <= 0) return 'Terminé';
    const days = Math.floor(diff / 86400000);
    if (days > 0) return `${days} j restant${days > 1 ? 's' : ''}`;
    const hours = Math.floor(diff / 3600000);
    if (hours > 0) return `${hours} h restante${hours > 1 ? 's' : ''}`;
    const mins = Math.floor(diff / 60000);
    return `${mins} min restante${mins > 1 ? 's' : ''}`;
  }

  function hasVoted(poll: Poll): boolean {
    return poll.options.some((opt) => selectedOptions.includes(opt.id));
  }
</script>

{#if polls && polls.length > 0}
  <div class="px-5 py-4 space-y-5">
    {#each polls as poll (poll.id)}
      {@const totalVotes = getTotalVotes(poll)}

      <div
        class="rounded-[1.5rem] border border-black/5 dark:border-white/10 bg-white/60 dark:bg-black/20 backdrop-blur-xl p-5 shadow-sm"
      >
        <!-- En-tête du sondage -->
        <div class="flex items-start gap-3 mb-5">
          <div
            class="p-2 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5"
          >
            <ChartBar size={18} strokeWidth={2.5} />
          </div>
          <div class="flex-1 min-w-0">
            <h4 class="font-extrabold text-[1.05rem] text-text-main leading-snug">
              {poll.question}
            </h4>
            <div class="flex flex-wrap items-center gap-2 mt-1.5">
              {#if poll.multipleChoice}
                <span class="text-[0.65rem] font-bold text-text-muted uppercase tracking-wider opacity-80">
                  Choix multiples autorisés
                </span>
              {/if}
              {#if poll.endsAt}
                <span class="text-[0.65rem] font-bold text-amber-600 dark:text-amber-400 opacity-90">
                  ⏱ {pollCountdown(poll.endsAt)}
                </span>
              {/if}
              {#if hasVoted(poll)}
                <span class="inline-flex items-center gap-1 text-[0.65rem] font-bold text-emerald-600 dark:text-emerald-400">
                  ✓ Vous avez voté
                </span>
              {/if}
            </div>
          </div>
        </div>

        <!-- Options du sondage -->
        <div class="space-y-2.5">
          {#each poll.options as option (option.id)}
            {@const isSelected = selectedOptions.includes(option.id)}
            {@const percentage = getPercentage(option.votes, totalVotes)}
            {@const voteCount = getVoteCount(option.votes)}
            {@const voterIds = getVoterIds(option.votes)}

            <button
              type="button"
              class="relative w-full text-left p-4 rounded-2xl border-2 transition-all duration-300 group overflow-hidden outline-none focus-visible:ring-4 focus-visible:ring-amber-500/30
                {isSelected
                ? 'border-amber-500 bg-amber-500/5'
                : 'border-black/5 dark:border-white/5 bg-white/50 dark:bg-black/40 hover:border-amber-500/40 hover:bg-white/80 dark:hover:bg-black/60'}"
              onclick={() => onToggleOption(poll.id, option.id, poll.multipleChoice)}
              aria-pressed={isSelected}
            >
              <!-- Barre de progression visuelle des votes en arrière-plan -->
              {#if totalVotes > 0}
                <div
                  class="absolute inset-y-0 left-0 bg-black/5 dark:bg-white/5 transition-all duration-1000 ease-out z-0 {isSelected
                    ? 'bg-amber-500/10 dark:bg-amber-500/15'
                    : ''}"
                  style="width: {percentage}%;"
                ></div>
              {/if}

              <!-- Contenu de l'option -->
              <div class="relative z-10 flex justify-between items-center gap-4">
                <div class="flex items-center gap-3 flex-1 min-w-0">
                  <!-- Icône de sélection (Unique vs Multiple) -->
                  <div
                    class="shrink-0 transition-colors {isSelected
                      ? 'text-amber-500'
                      : 'text-text-muted group-hover:text-amber-500'}"
                  >
                    {#if poll.multipleChoice}
                      {#if isSelected}
                        <SquareCheck size={20} strokeWidth={2.5} class="text-amber-500" />
                      {:else}
                        <Square
                          size={20}
                          strokeWidth={2}
                          class="opacity-40 group-hover:opacity-100 transition-opacity"
                        />
                      {/if}
                    {:else if isSelected}
                      <CircleCheck size={20} strokeWidth={2.5} class="text-amber-500" />
                    {:else}
                      <Circle
                        size={20}
                        strokeWidth={2}
                        class="opacity-40 group-hover:opacity-100 transition-opacity"
                      />
                    {/if}
                  </div>

                  <!-- Libellé de l'option -->
                  <span class="font-bold text-[0.95rem] text-text-main truncate">
                    {option.label}
                  </span>
                </div>

                <!-- Compteurs (Pourcentage & Votes absolus) -->
                <div class="flex items-center gap-2.5 shrink-0">
                  {#if totalVotes > 0}
                    <span
                      class="text-xs font-extrabold text-text-main/60 min-w-[2.5rem] text-right"
                    >
                      {percentage}%
                    </span>
                  {/if}
                  <!-- Vote count badge — hover/tap to see voter names -->
                  <div
                    role="button"
                    tabindex="0"
                    class="text-[0.7rem] font-bold text-text-muted bg-black/5 dark:bg-white/10 px-2 py-1 rounded-lg select-none"
                    class:cursor-pointer={voterIds.length > 0}
                    class:cursor-default={voterIds.length === 0}
                    aria-label="{voteCount} vote(s)"
                    onmouseenter={(e) =>
                      voterIds.length > 0 &&
                      showVoterTooltip(option.id, option.votes, e.currentTarget as HTMLElement)}
                    onmouseleave={hideTooltip}
                    onclick={(e) => {
                      e.stopPropagation();
                      toggleTooltip(option.id, option.votes, e.currentTarget as HTMLElement);
                    }}
                    onkeydown={(e) =>
                      e.key === 'Enter' &&
                      toggleTooltip(option.id, option.votes, e.currentTarget as HTMLElement)}
                  >
                    {voteCount}
                  </div>
                </div>
              </div>
            </button>
          {/each}
        </div>

        <!-- Pied du sondage (Total + Bouton de validation) -->
        <div class="mt-5 flex items-center justify-between">
          <span class="text-xs font-semibold text-text-muted">
            {totalVotes} vote{totalVotes > 1 ? 's' : ''} au total
          </span>
          {#if !poll.endsAt || new Date(poll.endsAt).getTime() > Date.now()}
            <button
              type="button"
              class="px-5 py-2.5 rounded-xl bg-amber-500 text-[#151B2C] font-extrabold text-sm transition-all shadow-md shadow-amber-500/20 hover:bg-amber-400 hover:shadow-lg hover:shadow-amber-500/30 active:scale-95 active:shadow-md disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-md disabled:active:scale-100 disabled:shadow-none outline-none focus-visible:ring-4 focus-visible:ring-amber-500/50"
              disabled={selectedOptions.length === 0}
              onclick={() => onSubmitVote(poll.id)}
            >
              {hasVoted(poll) ? 'Modifier mon vote' : 'Voter'}
            </button>
          {:else}
            <span class="text-xs font-bold text-text-muted opacity-60">Sondage terminé</span>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}

<!-- Fixed-position tooltip portal — renders above overflow-hidden containers -->
{#if tooltipOptionId && tooltipPos}
  {@const names = voterNames[tooltipOptionId]}
  <div
    use:portal
    class="fixed z-[9999] min-w-[10rem] max-w-[16rem] rounded-xl bg-[#1a2236] text-white text-[0.72rem] font-medium shadow-xl px-3 py-2 pointer-events-none -translate-y-full -mt-1.5"
    style="top: {tooltipPos.top}px; right: {tooltipPos.right}px;"
    role="tooltip"
  >
    <p class="font-bold text-white/60 uppercase tracking-wide text-[0.6rem] mb-1">Votants</p>
    {#if names}
      <ul class="space-y-0.5">
        {#each names as name (name)}
          <li class="truncate">{name}</li>
        {/each}
      </ul>
    {:else}
      <p class="opacity-60 italic">Chargement…</p>
    {/if}
  </div>
{/if}
