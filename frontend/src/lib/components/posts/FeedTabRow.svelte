<script lang="ts">
  /**
   * THE FEED'S ONE ROW (user, 2026-10-16 - two stacked bars read as clutter on the phone): the three
   * tabs, and the CanaReels entry (`ReelsEntryButton`) at its right end.
   *
   * ONE BUTTON, THREE TIMES, IS ONE BUTTON: the pill is written once, so a change to its state
   * colours, padding or aria is made once. When the row is too narrow (390 px with 2x text) the TABS
   * scroll sideways, faded at the edge that has more (`scrollFades`), the selected one scrolled into
   * full view (`centredTabScrollLeft`); the icon never wraps, shrinks
   * or leaves the row. The scroller's vertical padding keeps the pills' 44 px touch target inside
   * it, since a horizontal scroller clips both axes. What a tab tap does is the feed page's.
   */
  import { scrollFades } from '$lib/actions/scrollFades';
  import ReelsEntryButton from './ReelsEntryButton.svelte';
  import type { PostFeed } from '$lib/posts/api';
  import { centredTabScrollLeft } from '$lib/posts/feedTabScroll';
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

  let tabs = $state<HTMLElement | null>(null);

  // THE SELECTED TAB IS IN VIEW, on arrival, on every selection, and whenever the row's layout
  // changes under it - a resize, or the web font arriving after the first layout was measured with
  // the fallback's widths: at 2x text the row overflows and "Tout" sat under the faded edge by the
  // CanaReels icon (`centredTabScrollLeft`).
  $effect(() => {
    const selected = feed;
    const row = tabs;
    if (!row) return;
    revealTab(row, selected);
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => revealTab(row, feed));
    if (!observer) console.debug('[feed-tabs] no ResizeObserver - revealed on selection only');
    observer?.observe(row);
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) revealTab(row, feed);
    });
    return () => {
      live = false;
      observer?.disconnect();
    };
  });

  /** Scrolls `row` so the tab of `selected` is in full view, when the row overflows at all. */
  function revealTab(row: HTMLElement, selected: PostFeed) {
    const maxScroll = row.scrollWidth - row.clientWidth;
    if (maxScroll <= 0) return;
    const tab = row.querySelector<HTMLElement>(`[data-feed-tab="${selected}"]`);
    if (!tab) {
      console.error(`[feed-tabs] no tab drawn for the selected feed ${selected}`);
      return;
    }
    const next = centredTabScrollLeft(
      row.getBoundingClientRect(),
      tab.getBoundingClientRect(),
      row.scrollLeft,
      maxScroll
    );
    if (next === row.scrollLeft) return;
    console.debug(`[feed-tabs] the row scrolls to ${next} px to show ${selected}`);
    row.scrollLeft = next;
  }
</script>

<!-- ONE FLOATING GLASS PILL, A SEGMENTED CONTROL (owner, 2026-10-31: the row sat on a grey band in the
     middle of nowhere, margins unequal). The recipe is the conversation chrome's `.glass-chrome`,
     not a new one; the CanaReels entry is the matching round glass button. The row owns no
     background and no horizontal inset: the feed column's own gutters are the row's, so both sides
     match the cards. Glass at EVERY width, unlike the phone-only conversation header, because the
     row floats over cards that scroll under it on desktop too. -->
<div class="flex items-center gap-2" data-feed-tab-row>
  <div class="glass-chrome flex h-11 min-w-0 flex-1 rounded-full p-1" data-feed-pill>
    <div
      bind:this={tabs}
      class="no-scrollbar flex min-w-0 flex-1 gap-1 overflow-x-auto"
      data-feed-tabs
      use:scrollFades
    >
      {#each FEED_TABS as tab (tab.feed)}
        <button
          type="button"
          data-feed-tab={tab.feed}
          onclick={() => onFeed(tab.feed)}
          aria-pressed={feed === tab.feed}
          class="tap-target flex-1 shrink-0 rounded-full border px-3.5 text-sm whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:outline-none {feed ===
          tab.feed
            ? 'text-text-main border-amber-500/40 bg-amber-500/20 font-semibold'
            : 'text-text-muted hover:text-text-main border-transparent font-medium'}"
        >
          {tab.label()}
        </button>
      {/each}
    </div>
  </div>
  <ReelsEntryButton {authToken} />
</div>
