<script lang="ts">
  import { onMount } from 'svelte';
  import { Ban, Gamepad2, Trash2, Undo2 } from '@lucide/svelte';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import MinesweeperStats from '$lib/components/games/MinesweeperStats.svelte';
  import MinesweeperModal from '$lib/components/settings/MinesweeperModal.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';
  import {
    banMinesweeperUser,
    fetchMinesweeperBans,
    fetchMinesweeperLeaderboard,
    fetchMinesweeperMe,
    fetchMinesweeperPromos,
    formatDurationMs,
    removeMinesweeperScore,
    unbanMinesweeperUser,
    type LeaderboardEntry,
    type MinesweeperBan,
    type MinesweeperPromo,
    type MinesweeperStanding,
  } from '$lib/minesweeper/api';
  import { currentUserId } from '$lib/stores/user';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';
  import { exactDate } from '$lib/utils/time';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { globalAdminState } from '$lib/stores/userState.svelte';

  /**
   * THE GAMES PAGE (owner, 2026-11-10; docs/wiki/frontend/modules/minesweeper.md): "Jouer", the
   * reader's own record, and the Minesweeper ranking - overall, one promo's, or the reader's own
   * Stats. Open to every signed-in account; the 5 taps on the settings title still open the game.
   * THE ONE LEADERBOARD (owner, 2026-11-13): the game's own sheet is gone, so the date of each
   * record and the moderation (a global admin removes a score or bans a player) live here.
   *
   * A promo ranking holds only accounts WITH a cursus (the server joins `users.promo`), and the page
   * opens its promo tab on the reader's own promo.
   */
  const PAGE = 25;

  type Tab = 'general' | 'promo' | 'stats';

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
  /** The buttons are drawn for a global admin only - the 403 behind them is the real gate. */
  const isAdmin = $derived(globalAdminState());
  let bans = $state<MinesweeperBan[]>([]);
  /** An admin action failed - said on the tab, never swallowed. */
  let moderationFailed = $state(false);
  const promoOptions = $derived<PickerOption[]>(
    promos.map((p) => ({
      value: String(p.promo),
      label: m.games_promo_option({ promo: String(p.promo), players: String(p.players) }),
    }))
  );

  /** The visible date of a record; nothing for a date the server did not send. */
  function dateOf(iso: string): string {
    return Number.isNaN(new Date(iso).getTime()) ? '' : exactDate(iso);
  }

  async function loadBans() {
    try {
      bans = await fetchMinesweeperBans();
    } catch (e) {
      Log.d('games', `could not load the bans: ${String(e)}`);
      bans = [];
    }
  }

  /** Runs one admin action, then reads the board and the bans again; a failure is logged and shown. */
  async function moderate(action: () => Promise<void>) {
    moderationFailed = false;
    try {
      await action();
    } catch (e) {
      Log.d('games', `moderation action failed: ${String(e)}`);
      moderationFailed = true;
    }
    await loadBoard();
  }

  async function removeScore(entry: LeaderboardEntry) {
    const confirmed = await showConfirm(
      m.minesweeper_admin_confirm_remove({
        name: entry.displayName,
        time: formatDurationMs(entry.durationMs),
      }),
      { danger: true, confirmLabel: m.minesweeper_admin_confirm_remove_label() }
    );
    if (confirmed) await moderate(() => removeMinesweeperScore(entry.scoreId));
  }

  async function banPlayer(entry: LeaderboardEntry) {
    const confirmed = await showConfirm(
      m.minesweeper_admin_confirm_ban({ name: entry.displayName }),
      { danger: true, confirmLabel: m.minesweeper_admin_confirm_ban_label() }
    );
    if (confirmed) await moderate(() => banMinesweeperUser(entry.userId));
  }

  async function unbanPlayer(ban: MinesweeperBan) {
    const confirmed = await showConfirm(
      m.minesweeper_admin_confirm_unban({ name: ban.displayName }),
      { confirmLabel: m.minesweeper_admin_unban() }
    );
    if (confirmed) await moderate(() => unbanMinesweeperUser(ban.userId));
  }

  /** Loads the first page of the board the reader is looking at. */
  async function loadBoard() {
    if (tab === 'stats') return;
    if (isAdmin) void loadBans();
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
      // Offset paging over a moving board can repeat a player: a keyed each would throw on it.
      const seen = new Set(entries.map((e) => e.userId));
      entries = [...entries, ...page.entries.filter((e) => !seen.has(e.userId))];
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
          { key: 'stats', label: m.minesweeper_tab_stats() },
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

      {#if tab === 'stats'}
        <MinesweeperStats />
      {:else if loading}
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
                <span class="min-w-0">
                  <span class="text-text-main block truncate text-sm font-semibold">
                    {entry.displayName}
                  </span>
                  {#if dateOf(entry.verifiedAt)}
                    <span class="text-text-muted block truncate text-xs" data-testid="games-date">
                      {dateOf(entry.verifiedAt)}
                    </span>
                  {/if}
                </span>
              </span>
              <span class="flex shrink-0 items-center gap-1">
                <span class="text-text-main font-mono text-sm font-semibold">
                  {formatDurationMs(entry.durationMs)}
                </span>
                {#if isAdmin}
                  <Button
                    icon
                    size="compact"
                    variant="ghost"
                    aria-label={m.minesweeper_admin_remove_score()}
                    title={m.minesweeper_admin_remove_score()}
                    onclick={() => void removeScore(entry)}
                  >
                    <Trash2 size={14} strokeWidth={2.25} />
                  </Button>
                  <Button
                    icon
                    size="compact"
                    variant="ghost"
                    aria-label={m.minesweeper_admin_ban()}
                    title={m.minesweeper_admin_ban()}
                    onclick={() => void banPlayer(entry)}
                  >
                    <Ban size={14} strokeWidth={2.25} />
                  </Button>
                {/if}
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

      {#if isAdmin && tab !== 'stats'}
        {#if moderationFailed}
          <p class="text-red-err text-xs font-semibold" role="alert">
            {m.minesweeper_admin_failed()}
          </p>
        {/if}
        {#if bans.length > 0}
          <h3 class="text-text-muted text-2xs mt-4 font-bold">
            {m.minesweeper_admin_bans_title()}
          </h3>
          <ul class="space-y-1.5">
            {#each bans as ban (ban.userId)}
              <li
                class="border-cn-border bg-cn-surface flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
              >
                <span class="min-w-0">
                  <span class="text-text-main block truncate text-sm font-semibold">
                    {ban.displayName}
                  </span>
                  {#if ban.reason}
                    <span class="text-text-muted block truncate text-xs">{ban.reason}</span>
                  {/if}
                </span>
                <Button
                  icon
                  size="compact"
                  variant="ghost"
                  aria-label={m.minesweeper_admin_unban()}
                  title={m.minesweeper_admin_unban()}
                  onclick={() => void unbanPlayer(ban)}
                >
                  <Undo2 size={14} strokeWidth={2.25} />
                </Button>
              </li>
            {/each}
          </ul>
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
