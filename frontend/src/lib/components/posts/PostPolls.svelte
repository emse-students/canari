<script lang="ts">
  import { ChartBar, CircleCheck, Circle, SquareCheck, Square } from '@lucide/svelte';
  import type { Poll } from '$lib/posts/api';
  import { resolveUserDisplayName, getUserDisplayNameSync } from '$lib/utils/users/displayName';
  import { portal } from '$lib/actions/portal';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Polls attached to the post, or undefined when the post has none. */
    polls: Poll[] | undefined;
    /** Option IDs the current user has selected across all polls. */
    selectedOptions: string[];
    /** Called when the user clicks a poll option. Single-choice: also submits immediately. */
    onVoteClick: (pollId: string, optionId: string, multipleChoice: boolean) => void;
    /** Called when the user clicks the "Voter" button (multiple-choice polls only). */
    onSubmitVote: (pollId: string) => void;
  }

  let { polls, selectedOptions, onVoteClick, onSubmitVote }: Props = $props();

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
    if (diff <= 0) return m.post_poll_ended_label();
    const days = Math.floor(diff / 86400000);
    if (days > 0) return m.post_poll_days_remaining({ count: days });
    const hours = Math.floor(diff / 3600000);
    if (hours > 0) return m.post_poll_hours_remaining({ count: hours });
    const mins = Math.floor(diff / 60000);
    return m.post_poll_minutes_remaining({ count: mins });
  }

  function hasVoted(poll: Poll): boolean {
    return poll.options.some((opt) => selectedOptions.includes(opt.id));
  }
</script>

{#if polls && polls.length > 0}
  <div class="space-y-5 px-5 py-4">
    {#each polls as poll (poll.id)}
      {@const totalVotes = getTotalVotes(poll)}

      <div
        class="rounded-[1.5rem] border border-black/5 bg-white/60 p-5 shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-black/20"
      >
        <!-- Poll header. -->
        <div class="mb-5 flex items-start gap-3">
          <div
            class="mt-0.5 shrink-0 rounded-xl bg-amber-500/10 p-2 text-amber-600 dark:text-amber-400"
          >
            <ChartBar size={18} strokeWidth={2.5} />
          </div>
          <div class="min-w-0 flex-1">
            <h4 class="text-text-main text-[1.05rem] leading-snug font-extrabold">
              {poll.question}
            </h4>
            <div class="mt-1.5 flex flex-wrap items-center gap-2">
              {#if poll.multipleChoice}
                <span
                  class="text-text-muted text-[0.65rem] font-bold tracking-wider uppercase opacity-80"
                >
                  {m.post_poll_multiple_choice_label()}
                </span>
              {/if}
              {#if poll.endsAt}
                <span
                  class="text-[0.65rem] font-bold text-amber-600 opacity-90 dark:text-amber-400"
                >
                  ⏱ {pollCountdown(poll.endsAt)}
                </span>
              {/if}
              {#if hasVoted(poll)}
                <span
                  class="inline-flex items-center gap-1 text-[0.65rem] font-bold text-emerald-600 dark:text-emerald-400"
                >
                  ✓ {m.post_poll_you_voted_label()}
                </span>
              {/if}
            </div>
          </div>
        </div>

        <!-- Poll options. -->
        <div class="space-y-2.5">
          {#each poll.options as option (option.id)}
            {@const isSelected = selectedOptions.includes(option.id)}
            {@const percentage = getPercentage(option.votes, totalVotes)}
            {@const voteCount = getVoteCount(option.votes)}
            {@const voterIds = getVoterIds(option.votes)}

            <button
              type="button"
              class="group relative w-full overflow-hidden rounded-2xl border-2 p-4 text-left transition-all duration-300 outline-none focus-visible:ring-4 focus-visible:ring-amber-500/30
                {isSelected
                ? 'border-amber-500 bg-amber-500/5'
                : 'border-black/5 bg-white/50 hover:border-amber-500/40 hover:bg-white/80 dark:border-white/5 dark:bg-black/40 dark:hover:bg-black/60'}"
              onclick={() => onVoteClick(poll.id, option.id, poll.multipleChoice)}
              aria-pressed={isSelected}
            >
              <!-- Visual vote progress bar in the background. -->
              {#if totalVotes > 0}
                <div
                  class="absolute inset-y-0 left-0 z-0 bg-black/5 transition-all duration-1000 ease-out dark:bg-white/5 {isSelected
                    ? 'bg-amber-500/10 dark:bg-amber-500/15'
                    : ''}"
                  style="width: {percentage}%;"
                ></div>
              {/if}

              <!-- Option content. -->
              <div class="relative z-10 flex items-center justify-between gap-4">
                <div class="flex min-w-0 flex-1 items-center gap-3">
                  <!-- Selection icon (single vs multiple choice). -->
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
                          class="opacity-40 transition-opacity group-hover:opacity-100"
                        />
                      {/if}
                    {:else if isSelected}
                      <CircleCheck size={20} strokeWidth={2.5} class="text-amber-500" />
                    {:else}
                      <Circle
                        size={20}
                        strokeWidth={2}
                        class="opacity-40 transition-opacity group-hover:opacity-100"
                      />
                    {/if}
                  </div>

                  <!-- Option label. -->
                  <span class="text-text-main truncate text-[0.95rem] font-bold">
                    {option.label}
                  </span>
                </div>

                <!-- Compteurs (Pourcentage & Votes absolus) -->
                <div class="flex shrink-0 items-center gap-2.5">
                  {#if totalVotes > 0}
                    <span
                      class="text-text-main/60 min-w-[2.5rem] text-right text-xs font-extrabold"
                    >
                      {percentage}%
                    </span>
                  {/if}
                  <!-- Vote count badge - hover/tap to see voter names -->
                  <div
                    role="button"
                    tabindex="0"
                    class="text-text-muted rounded-lg bg-black/5 px-2 py-1 text-[0.7rem] font-bold select-none dark:bg-white/10"
                    class:cursor-pointer={voterIds.length > 0}
                    class:cursor-default={voterIds.length === 0}
                    aria-label={m.post_poll_vote_count_label({ count: voteCount })}
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

        <!-- Poll footer (total votes + submit button for multi-choice). -->
        <div class="mt-5 flex items-center justify-between">
          <span class="text-text-muted text-xs font-semibold">
            {m.post_poll_total_votes_label({ count: totalVotes })}
          </span>
          {#if poll.endsAt && new Date(poll.endsAt).getTime() <= Date.now()}
            <span class="text-text-muted text-xs font-bold opacity-60"
              >{m.post_poll_ended_full_label()}</span
            >
          {:else if poll.multipleChoice}
            <button
              type="button"
              class="text-cn-ink rounded-xl bg-amber-500 px-5 py-2.5 text-sm font-extrabold shadow-md shadow-amber-500/20 transition-all outline-none hover:bg-amber-400 hover:shadow-lg hover:shadow-amber-500/30 focus-visible:ring-4 focus-visible:ring-amber-500/50 active:scale-95 active:shadow-md disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none disabled:hover:shadow-md disabled:active:scale-100"
              disabled={selectedOptions.length === 0}
              onclick={() => onSubmitVote(poll.id)}
            >
              {m.post_sondage_voter()}
            </button>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}

<!-- Fixed-position tooltip portal - renders above overflow-hidden containers -->
{#if tooltipOptionId && tooltipPos}
  {@const names = voterNames[tooltipOptionId]}
  <div
    use:portal
    class="bg-cn-tooltip pointer-events-none fixed z-[9999] -mt-1.5 max-w-[16rem] min-w-[10rem] -translate-y-full rounded-xl px-3 py-2 text-[0.72rem] font-medium text-white shadow-xl"
    style="top: {tooltipPos.top}px; right: {tooltipPos.right}px;"
    role="tooltip"
  >
    <p class="mb-1 text-[0.6rem] font-bold tracking-wide text-white/60 uppercase">
      {m.post_poll_voters_label()}
    </p>
    {#if names}
      <ul class="space-y-0.5">
        {#each names as name (name)}
          <li class="truncate">{name}</li>
        {/each}
      </ul>
    {:else}
      <p class="italic opacity-60">{m.common_loading_label()}</p>
    {/if}
  </div>
{/if}
