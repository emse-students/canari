<script lang="ts">
  import { onMount } from 'svelte';
  import { Gamepad2 } from '@lucide/svelte';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import MinesweeperModal from '$lib/components/settings/MinesweeperModal.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';
  import {
    fetchMinesweeperLeaderboard,
    fetchMinesweeperMe,
    fetchMinesweeperPromos,
    formatDurationMs,
    type LeaderboardEntry,
    type MinesweeperPromo,
    type MinesweeperStanding,
  } from '$lib/minesweeper/api';
  import { currentUserId } from '$lib/stores/user';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * THE GAMES PAGE (owner, 2026-11-10; docs/wiki/frontend/modules/minesweeper.md): "Jouer", the
   * reader's own record, and the Minesweeper ranking - overall, or one promo's. Open to every
   * signed-in account; the 5 taps on the settings title still open the game itself.
   *
   * A promo ranking holds only accounts WITH a cursus (the server joins `users.promo`), and the page
   * opens its promo tab on the reader's own promo. The moderation of scores stays in the game's own
   * sheet: this page only reads.
   */
  const PAGE = 25;

  type Tab = 'general' | 'promo';

  let playing = $state(false);
  let tab = $state<Tab>('general');
  let standing = $state<MinesweeperStanding | null>(null);
  let promos = $state<MinesweeperPromo[]>([]);
  let myPromo = $state<number | null>(null);
  let promo = $state<number | null>(null);
  let entries = $state<LeaderboardEntry[]>([]);
  let total = $state(0);
  let loading = $state(true);
  let loadingMore = $state(false);
  let failed = $state(false);
  /** Moves on with every fresh load, so an answer for a tab or promo left behind is dropped. */
  let generation = 0;

  const me = $derived(currentUserId());
  const promoOptions = $derived<PickerOption[]>(
    promos.map((p) => ({
      value: String(p.promo),
      label: m.games_promo_option({ promo: String(p.promo), players: String(p.players) }),
    }))
  );

  /** Loads the first page of the board the reader is looking at. */
  async function loadBoard() {
    const mine = ++generation;
    loading = true;
    failed = false;
    try {
      const scope = tab === 'promo' ? (promo ?? undefined) : undefined;
      if (tab === 'promo' && scope === undefined) {
        entries = [];
        total = 0;
        return;
      }
      const page = await fetchMinesweeperLeaderboard(PAGE, 0, scope);
      if (mine !== generation) return;
      entries = page.entries;
      total = page.total;
    } catch (e) {
      if (mine !== generation) return;
      Log.d('games', `ranking load failed: ${String(e)}`);
      failed = true;
      entries = [];
      total = 0;
    } finally {
      if (mine === generation) loading = false;
    }
  }

  async function loadMore() {
    if (loadingMore) return;
    const mine = generation;
    loadingMore = true;
    try {
      const scope = tab === 'promo' ? (promo ?? undefined) : undefined;
      const page = await fetchMinesweeperLeaderboard(PAGE, entries.length, scope);
      if (mine !== generation) return;
      entries = [...entries, ...page.entries];
      total = page.total;
    } catch (e) {
      Log.d('games', `next page failed: ${String(e)}`);
    } finally {
      loadingMore = false;
    }
  }

  function selectTab(next: Tab) {
    if (next === tab) return;
    Log.d('games', `ranking tab ${next}`);
    tab = next;
    void loadBoard();
  }

  function selectPromo(value: string) {
    promo = Number(value);
    Log.d('games', `ranking promo ${promo}`);
    void loadBoard();
  }

  onMount(async () => {
    // The record, the promos and the overall board are three independent reads: one failing blanks
    // only its own part.
    const [best, list] = await Promise.allSettled([fetchMinesweeperMe(), fetchMinesweeperPromos()]);
    if (best.status === 'fulfilled') standing = best.value;
    else Log.d('games', `own record failed: ${String(best.reason)}`);
    if (list.status === 'fulfilled') {
      promos = list.value.promos;
      myPromo = list.value.mine;
      // Opens on the reader's own promo when it has a ranking, else the newest one.
      promo = promos.some((p) => p.promo === myPromo) ? myPromo : (promos[0]?.promo ?? null);
    } else {
      Log.d('games', `promos failed: ${String(list.reason)}`);
    }
    await loadBoard();
  });

  /** A record only from a verified time: the server answers nulls for a player with none. */
  const hasBest = $derived(standing?.personalBestMs != null && standing?.rank != null);
</script>

<PageContainer width="reading">
  <PageHeader title={m.games_page_title()} subtitle={m.games_page_subtitle()} />

  <div class="space-y-5">
    <section
      class="border-cn-border bg-cn-surface flex items-center justify-between gap-3 rounded-2xl border p-4"
    >
      <div class="flex min-w-0 items-center gap-3">
        <span class="text-text-muted shrink-0"><Gamepad2 size={22} /></span>
        <div class="min-w-0">
          <h2 class="text-text-main truncate text-base font-bold">{m.minesweeper_title()}</h2>
          <p class="text-text-muted text-sm" data-testid="games-best">
            {#if hasBest}
              {m.games_best_value({
                time: formatDurationMs(standing!.personalBestMs!),
                rank: String(standing!.rank),
              })}
            {:else}
              {m.games_best_none()}
            {/if}
          </p>
        </div>
      </div>
      <Button onclick={() => (playing = true)} class="shrink-0">{m.games_play()}</Button>
    </section>

    <section class="space-y-3">
      <SegmentedControl
        tone="yellow"
        label={m.games_tabs_label()}
        items={[
          { key: 'general', label: m.games_tab_general() },
          { key: 'promo', label: m.games_tab_promo() },
        ]}
        value={tab}
        onSelect={selectTab}
      />

      {#if tab === 'promo' && promos.length > 0}
        <Select
          id="games-promo"
          label={m.games_promo_label()}
          value={promo === null ? '' : String(promo)}
          options={promoOptions}
          onValueChange={selectPromo}
        />
      {/if}

      {#if loading}
        <p class="text-text-muted text-sm">…</p>
      {:else if failed}
        <p class="text-red-err text-sm" role="alert">{m.games_load_error()}</p>
      {:else if tab === 'promo' && promos.length === 0}
        <p class="text-text-muted text-sm">{m.games_promo_none()}</p>
      {:else if entries.length === 0}
        <p class="text-text-muted text-sm">
          {tab === 'promo' ? m.games_promo_empty() : m.minesweeper_empty_leaderboard()}
        </p>
      {:else}
        <ol class="space-y-1.5" data-testid="games-ranking">
          {#each entries as entry (entry.userId)}
            <li
              class="border-cn-border bg-cn-surface flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 {entry.userId ===
              me
                ? 'ring-accent/40 ring-2'
                : ''}"
            >
              <span class="flex min-w-0 items-center gap-2.5">
                <span class="text-text-muted w-8 shrink-0 font-mono text-sm font-bold">
                  #{entry.rank}
                </span>
                <span class="text-text-main truncate text-sm font-semibold">
                  {entry.displayName}
                </span>
              </span>
              <span class="text-text-main shrink-0 font-mono text-sm font-semibold">
                {formatDurationMs(entry.durationMs)}
              </span>
            </li>
          {/each}
        </ol>
        {#if entries.length < total}
          <div class="flex justify-center">
            <Button variant="secondary" onclick={() => void loadMore()} loading={loadingMore}>
              {m.minesweeper_load_more()}
            </Button>
          </div>
        {/if}
      {/if}
    </section>
  </div>
</PageContainer>

{#if playing}
  <MinesweeperModal
    open={true}
    onClose={() => {
      playing = false;
      // A ranked win changes the record and the board: read both again on the way back.
      void fetchMinesweeperMe()
        .then((s) => (standing = s))
        .catch((e) => Log.d('games', `record refresh failed: ${String(e)}`));
      void loadBoard();
    }}
  />
{/if}
