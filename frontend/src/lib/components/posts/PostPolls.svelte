<script lang="ts">
  import { ChartBar, CircleCheck, Circle, SquareCheck, Square } from 'lucide-svelte';
  import type { Poll } from '$lib/posts/api';

  interface Props {
    polls: Poll[] | undefined;
    selectedOptions: string[];
    onToggleOption: (pollId: string, optionId: string, multipleChoice: boolean) => void;
    onSubmitVote: (pollId: string) => void;
  }

  let { polls, selectedOptions, onToggleOption, onSubmitVote }: Props = $props();

  // Fonction pour calculer le total des votes d'un sondage
  function getTotalVotes(poll: Poll): number {
    return poll.options.reduce((sum, opt) => sum + (opt.votes || 0), 0);
  }

  // Fonction pour calculer le pourcentage d'une option
  function getPercentage(votes: number, total: number): number {
    if (total === 0) return 0;
    return Math.round((votes / total) * 100);
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
          <h4 class="font-extrabold text-[1.05rem] text-text-main leading-snug">
            {poll.question}
            {#if poll.multipleChoice}
              <span
                class="block text-[0.65rem] font-bold text-text-muted uppercase tracking-wider mt-1.5 opacity-80"
              >
                Choix multiples autorisés
              </span>
            {/if}
          </h4>
        </div>

        <!-- Options du sondage -->
        <div class="space-y-2.5">
          {#each poll.options as option (option.id)}
            {@const isSelected = selectedOptions.includes(option.id)}
            {@const percentage = getPercentage(option.votes || 0, totalVotes)}

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
                  <span
                    class="text-[0.7rem] font-bold text-text-muted bg-black/5 dark:bg-white/10 px-2 py-1 rounded-lg"
                    title="{option.votes || 0} vote(s)"
                  >
                    {option.votes || 0}
                  </span>
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
          <button
            type="button"
            class="px-5 py-2.5 rounded-xl bg-amber-500 text-[#151B2C] font-extrabold text-sm transition-all shadow-md shadow-amber-500/20 hover:bg-amber-400 hover:shadow-lg hover:shadow-amber-500/30 active:scale-95 active:shadow-md disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:shadow-md disabled:active:scale-100 disabled:shadow-none outline-none focus-visible:ring-4 focus-visible:ring-amber-500/50"
            disabled={selectedOptions.length === 0}
            onclick={() => onSubmitVote(poll.id)}
          >
            Voter
          </button>
        </div>
      </div>
    {/each}
  </div>
{/if}
