<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchMinesweeperStats,
    formatDurationMs,
    type MinesweeperStats,
  } from '$lib/minesweeper/api';
  import { m } from '$lib/paraglide/messages';
  import { exactDate } from '$lib/utils/time';
  import { Log } from '$lib/utils/Log';

  /**
   * The "Stats" tab of the Games page: the caller's own RANKED record (played, won, lost, win rate,
   * rank, best / average / median time, the latest wins as a sparkline and a dated list). It carries
   * everything the game's old leaderboard sheet showed, now that the page is the one leaderboard.
   * Loads on mount, so the tab costs nothing until it is opened.
   */
  let stats = $state<MinesweeperStats | null>(null);
  let loading = $state(true);
  let failed = $state(false);

  onMount(async () => {
    try {
      stats = await fetchMinesweeperStats();
    } catch (err) {
      Log.d('games', `stats load failed: ${String(err)}`);
      stats = null;
      failed = true;
    } finally {
      loading = false;
    }
  });

  /** The visible date of a win; nothing for a date the server did not send, never "Invalid Date". */
  function dateOf(iso: string): string {
    return Number.isNaN(new Date(iso).getTime()) ? '' : exactDate(iso);
  }

  /** The bars of the sparkline: oldest win first, each as a share of the slowest shown. */
  const sparkBars = $derived.by(() => {
    const wins = [...(stats?.recent ?? [])].reverse();
    const slowest = Math.max(1, ...wins.map((w) => w.durationMs));
    const fastest = Math.min(...wins.map((w) => w.durationMs));
    return wins.map((w) => ({
      scoreId: w.scoreId,
      percent: Math.max(8, Math.round((w.durationMs / slowest) * 100)),
      best: w.durationMs === fastest,
      label: formatDurationMs(w.durationMs),
    }));
  });
</script>

{#if loading}
  <p class="text-text-muted text-sm">…</p>
{:else if failed}
  <p class="text-red-err text-sm font-semibold" role="alert">{m.minesweeper_stats_failed()}</p>
{:else if stats}
  {@const cards = [
    { label: m.minesweeper_stats_played(), value: String(stats.played) },
    { label: m.minesweeper_stats_won(), value: String(stats.won) },
    {
      label: m.minesweeper_stats_win_rate(),
      value: stats.winRate === null ? '-' : `${Math.round(stats.winRate * 100)} %`,
    },
    {
      label: m.minesweeper_stats_rank(),
      value: stats.rank === null ? '-' : m.minesweeper_rank({ rank: String(stats.rank) }),
    },
    {
      label: m.minesweeper_stats_best(),
      value: stats.bestMs === null ? '-' : formatDurationMs(stats.bestMs),
    },
    {
      label: m.minesweeper_stats_average(),
      value: stats.averageMs === null ? '-' : formatDurationMs(stats.averageMs),
    },
    {
      label: m.minesweeper_stats_median(),
      value: stats.medianMs === null ? '-' : formatDurationMs(stats.medianMs),
    },
    { label: m.minesweeper_stats_lost(), value: String(stats.lost) },
  ]}
  <dl class="grid grid-cols-2 gap-2" data-testid="games-stats">
    {#each cards as card (card.label)}
      <div class="bg-cn-surface border-cn-border rounded-lg border px-3 py-2.5">
        <dt class="text-text-muted text-xs">{card.label}</dt>
        <dd class="text-text-main font-mono text-lg font-bold tabular-nums">{card.value}</dd>
      </div>
    {/each}
  </dl>

  {#if stats.recent.length === 0}
    <p class="text-text-muted mt-4 text-sm">{m.minesweeper_stats_empty()}</p>
  {:else}
    <h3 class="text-text-muted text-2xs mt-4 mb-1.5 font-bold">{m.minesweeper_stats_recent()}</h3>
    <div
      role="img"
      aria-label={m.minesweeper_stats_chart()}
      class="bg-cn-surface border-cn-border flex h-20 items-end gap-1 rounded-lg border px-3 py-2"
    >
      {#each sparkBars as bar (bar.scoreId)}
        <span
          title={bar.label}
          class="min-w-0 flex-1 rounded-sm {bar.best ? 'bg-accent' : 'bg-accent/40'}"
          style="height: {bar.percent}%;"
        ></span>
      {/each}
    </div>
    <ul class="mt-2 space-y-1.5">
      {#each stats.recent as win (win.scoreId)}
        <li
          class="bg-cn-surface border-cn-border flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
        >
          <span class="text-text-muted truncate text-xs">{dateOf(win.verifiedAt)}</span>
          <span class="text-text-main font-mono text-sm font-semibold">
            {formatDurationMs(win.durationMs)}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
  <p class="text-text-muted mt-4 text-xs">{m.minesweeper_stats_note()}</p>
{/if}
