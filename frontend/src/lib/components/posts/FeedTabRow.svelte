<script lang="ts">
  /**
   * THE FEED'S ONE ROW (user, 2026-10-16 - two stacked bars read as clutter on the phone): the three
   * tabs, and the CanaReels entry (`ReelsEntryButton`) at its right end.
   *
   * ONE BUTTON, THREE TIMES, IS ONE BUTTON: the pill is written once, so a change to its state
   * colours, padding or aria is made once. When the row is too narrow (390 px with 2x text) the TABS
   * scroll sideways, faded at the edge that has more (`scrollFades`); the icon never wraps, shrinks
   * or leaves the row. The scroller's vertical padding keeps the pills' 44 px touch target inside
   * it, since a horizontal scroller clips both axes. What a tab tap does is the feed page's.
   */
  import { scrollFades } from '$lib/actions/scrollFades';
  import ReelsEntryButton from './ReelsEntryButton.svelte';
  import type { PostFeed } from '$lib/posts/api';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The tab on screen. */
    feed: PostFeed;
    /** Called with the tab a reader tapped. */
    onFeed: (feed: PostFeed) => void;
    /** Forwarded to the reel viewer the CanaReels entry opens. */
    authToken: string;
  }

  let { feed, onFeed, authToken }: Props = $props();

  /** The feed's three modes, in the order they are drawn. */
  const FEED_TABS: { feed: PostFeed; label: () => string }[] = [
    { feed: 'associations', label: m.posts_tab_associations },
    { feed: 'followed', label: m.posts_tab_followed },
    { feed: 'all', label: m.posts_tab_all },
  ];
</script>

<div class="flex items-center gap-2" data-feed-tab-row>
  <div
    class="no-scrollbar -my-1.5 flex min-w-0 flex-1 gap-2 overflow-x-auto py-1.5"
    data-feed-tabs
    use:scrollFades
  >
    {#each FEED_TABS as tab (tab.feed)}
      <button
        type="button"
        onclick={() => onFeed(tab.feed)}
        aria-pressed={feed === tab.feed}
        class="tap-target shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium whitespace-nowrap transition-colors {feed ===
        tab.feed
          ? 'text-text-main border-amber-500/40 bg-amber-500/15'
          : 'border-cn-border text-text-muted hover:text-text-main'}"
      >
        {tab.label()}
      </button>
    {/each}
  </div>
  <ReelsEntryButton {authToken} />
</div>
