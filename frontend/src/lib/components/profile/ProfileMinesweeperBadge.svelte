<script lang="ts">
  import { Trophy } from '@lucide/svelte';
  import { fetchMinesweeperUserStanding, formatDurationMs } from '$lib/minesweeper/api';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Profile owner whose standing to show (hidden when they have no verified score). */
    userId: string;
  }

  let { userId }: Props = $props();

  let rank = $state<number | null>(null);
  let personalBestMs = $state<number | null>(null);

  $effect(() => {
    const id = userId;
    rank = null;
    personalBestMs = null;
    if (!id) return;
    let cancelled = false;
    void (async () => {
      try {
        const standing = await fetchMinesweeperUserStanding(id);
        if (cancelled) return;
        if (standing.rank != null && standing.personalBestMs != null) {
          rank = standing.rank;
          personalBestMs = standing.personalBestMs;
        }
      } catch {
        // Badge is optional — swallow network errors.
      }
    })();
    return () => {
      cancelled = true;
    };
  });
</script>

{#if rank != null && personalBestMs != null}
  <div
    class="mt-2 inline-flex items-center gap-1.5 rounded-full border border-cn-yellow/25 bg-cn-yellow/10 px-2.5 py-0.5 text-[0.7rem] font-bold text-cn-dark"
    title={m.minesweeper_profile_badge_title()}
  >
    <Trophy size={12} strokeWidth={2.5} class="shrink-0 text-cn-yellow" />
    <span>
      {m.minesweeper_profile_badge({
        rank: String(rank),
        time: formatDurationMs(personalBestMs),
      })}
    </span>
  </div>
{/if}
