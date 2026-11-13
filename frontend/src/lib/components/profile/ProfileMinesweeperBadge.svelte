<script lang="ts">
  import { resolve } from '$app/paths';
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

<!-- ONE SMALL BADGE, "🏆 Démineur #16", LINKING TO THE GAMES PAGE (owner, 2026-11-10); the time is
     only its tooltip. -->
{#if rank != null && personalBestMs != null}
  <a
    href={resolve('/games')}
    class="border-accent/25 bg-accent/10 text-cn-dark text-2xs focus-visible:ring-accent-icon mt-2 inline-flex items-center rounded-full border px-2.5 py-0.5 font-bold outline-none focus-visible:ring-2"
    title={m.minesweeper_profile_badge_title({ time: formatDurationMs(personalBestMs) })}
    data-testid="minesweeper-badge"
  >
    {m.minesweeper_profile_badge({ rank: String(rank) })}
  </a>
{/if}
