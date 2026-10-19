<script lang="ts">
  /**
   * THE LIVE CARD AT THE TOP OF THE FEED (decision L5, D4): every open live this reader may watch,
   * one row each - who broadcasts, and the LIVE badge - and a tap opens the viewer.
   *
   * It asks `GET /api/lives` whenever `refreshKey` changes, which the feed bumps when it asks for its
   * own first page (a tab load, a pull-to-refresh, a retry, a reconnect): the feed's mechanism, no
   * timer of its own. With nothing on air it draws nothing at all.
   */
  import { Radio } from '@lucide/svelte';
  import LiveBadge from './LiveBadge.svelte';
  import LiveIdentity from './LiveIdentity.svelte';
  import { loadOpenLivesForFeed } from '$lib/live/openLives';
  import type { LiveListItem } from '$lib/live/types';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Bumped by the feed each time it asks for its first page. */
    refreshKey: number;
    /** The reader, whose own live is not listed. */
    viewerId: string | null;
    /** Opens the viewer on that live. */
    onOpen: (live: LiveListItem) => void;
    /** The list loader; the server's unless a test hands its own. */
    load?: typeof loadOpenLivesForFeed;
  }

  let { refreshKey, viewerId, onOpen, load = loadOpenLivesForFeed }: Props = $props();

  let lives = $state<LiveListItem[]>([]);
  const names: Record<string, string> = $state({});

  $effect(() => {
    void refreshKey;
    const reader = viewerId;
    let current = true;
    void load(reader).then((outcome) => {
      if (!current) return;
      if (outcome.kind === 'answered') lives = outcome.lives;
      else if (outcome.kind === 'hidden') lives = [];
    });
    return () => {
      current = false;
    };
  });
</script>

{#if lives.length > 0}
  <section
    class="border-cn-border bg-cn-surface mb-5 rounded-lg border p-3"
    aria-labelledby="live-feed-card-title"
    data-live-feed-card
  >
    <h2 id="live-feed-card-title" class="text-text-main flex items-center gap-2 text-sm font-bold">
      <Radio size={16} class="text-red-err" aria-hidden="true" />
      {m.live_card_title()}
    </h2>
    <ul class="mt-2 flex flex-col gap-1">
      {#each lives as live (live.id)}
        <li>
          <button
            type="button"
            class="text-text-main hover:bg-control-fill flex min-h-11 w-full touch-manipulation items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            aria-label={m.live_card_is_live({ name: names[live.id] ?? '' })}
            onclick={() => onOpen(live)}
            data-live-open={live.id}
          >
            <span class="min-w-0 flex-1">
              <LiveIdentity {live} size="sm" onName={(n) => (names[live.id] = n)} />
            </span>
            <LiveBadge />
          </button>
        </li>
      {/each}
    </ul>
  </section>
{/if}
