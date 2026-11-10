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
   *
   * THE THREE LABELS FIT WITHOUT SCROLLING AT 390 PX AND 360 PX (dev tour, `1.6.9-alpha.4`: "Mon
   * espace" was clipped at the track's right edge at 390): `px-2.5` (10 px) instead of 14, and under
   * 24rem the text drops one scale step (`text-xs`) with `px-2`. The sideways scroll stays the
   * fallback for a 2x text size, never the normal state.
   *
   * What each tab shows is explained by the first-use hint `hint-feed-tabs` (it replaced the (i)
   * button of #2857, owner 2026-11-03): every tab marks itself `posts.tab.<feed>` for it.
   */
  import { untrack } from 'svelte';
  import { scrollFades } from '$lib/actions/scrollFades';
  import { guideAnchor } from '$lib/guidance/guideAnchors.svelte';
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

  /**
   * THE SELECTED PILL IS ONE ELEMENT THAT SLIDES (owner, 2026-10-31), not a background each button
   * wears: it is measured from the active button (`offsetLeft` / `offsetWidth`, in the scroller's own
   * content box, so it also follows a sideways scroll) and moved by `transform` alone. Hidden until
   * the first measure, which is also drawn with no transition, so it never slides in from nowhere.
   * The duration and easing are the motion scale's; reduced motion is the global rule's.
   *
   * THE LABELS ARE ABOVE THE PILL BY AN EXPLICIT STACKING ORDER, NEVER BY DOM ORDER ALONE (iPhone 12,
   * `1.6.9-alpha.4`: the opaque yellow pill hid its own label, while Android drew it). The pill is a
   * plain 2D `translateX` at rest - a `translate3d` made it a permanent compositing layer, and iOS
   * WebKit, in this masked (`scrollFades`) overflow scroller, drew that layer over the later,
   * uncomposited labels; while the pill was a 20 % tint the same overpaint only tinted them. The
   * scroller isolates its own stacking context, the pill is `z-0`, every label `z-1`.
   */
  let pill = $state<{ x: number; w: number } | null>(null);
  let pillAnimated = $state(false);
  /**
   * THE LABEL FOLLOWS THE PILL, NOT THE SELECTION. The ink label (`text-on-accent`) is 1.09:1 on the
   * dark glass, so it may only be drawn once the yellow pill is UNDER it: `settled` is the tab the
   * pill has reached (null while it slides, and before the first measure), and a label turns ink
   * only when the selection and the settled tab agree. The leaving label goes muted at once, the
   * arriving one turns ink at the end of the slide (`transitionend`), so no label is ever ink on glass.
   */
  let settled = $state<PostFeed | null>(null);

  /** Reads the active button's box into `pill`; true when it moved. */
  function measurePill(row: HTMLElement, selected: PostFeed): boolean {
    const tab = row.querySelector<HTMLElement>(`[data-feed-tab="${selected}"]`);
    if (!tab) return false;
    const x = tab.offsetLeft;
    const w = tab.offsetWidth;
    // No width: not laid out yet (hidden, or before the first layout) - nothing to draw.
    if (w === 0) return false;
    if (pill && pill.x === x && pill.w === w) return false;
    pill = { x, w };
    return true;
  }

  $effect(() => {
    const selected = feed;
    const row = tabs;
    if (!row) return;
    // A selection slides, except the very first placement (nothing to slide from).
    const animated = untrack(() => pill) !== null;
    pillAnimated = animated;
    // Untracked: the measure reads and writes `pill`, and this effect must run once per selection.
    const slides = untrack(() => measurePill(row, selected)) && animated;
    // A pill that did not move (or moved without a transition) is already under its label.
    settled = slides ? null : untrack(() => pill) ? selected : null;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            // A re-layout (resize, web font) moves the pill with its tab, never as a slide.
            const before = pillAnimated;
            pillAnimated = false;
            // Placed with no transition (first layout, resize): it is under its label at once.
            if (measurePill(row, feed)) settled = feed;
            else pillAnimated = before;
          });
    observer?.observe(row);
    // Each tab too: a font swap resizes a button without resizing the row.
    row.querySelectorAll('[data-feed-tab]').forEach((tab) => observer?.observe(tab));
    return () => observer?.disconnect();
  });

  // THE SELECTED TAB IS IN VIEW, on arrival, on every selection, and whenever the row's layout
  // changes under it - a resize, or the web font arriving after the first layout was measured with
  // the fallback's widths: at 2x text the row overflows and the tab then called "Tout" sat under the faded edge by the
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
  <div
    class="glass-chrome flex h-11 min-w-0 flex-1 rounded-full p-1 md:pointer-fine:h-9.5"
    data-feed-pill
  >
    <div
      bind:this={tabs}
      class="no-scrollbar relative isolate flex min-w-0 flex-1 gap-1 overflow-x-auto"
      data-feed-tabs
      use:scrollFades
    >
      {#if pill}
        <span
          aria-hidden="true"
          data-feed-tab-pill
          class="bg-accent pointer-events-none absolute inset-y-0 left-0 z-0 rounded-full"
          ontransitionend={(e) => {
            if (e.propertyName === 'transform') settled = feed;
          }}
          ontransitioncancel={() => (settled = null)}
          style:width="{pill.w}px"
          style:transform="translateX({pill.x}px)"
          style:transition={pillAnimated
            ? 'transform var(--motion-slow) var(--motion-ease-out), width var(--motion-slow) var(--motion-ease-out)'
            : 'none'}
        ></span>
      {/if}
      {#each FEED_TABS as tab (tab.feed)}
        <button
          type="button"
          data-feed-tab={tab.feed}
          use:guideAnchor={`posts.tab.${tab.feed}`}
          onclick={() => onFeed(tab.feed)}
          aria-pressed={feed === tab.feed}
          class="tap-target focus-visible:ring-accent-icon relative z-1 flex-1 shrink-0 rounded-full px-2.5 text-sm whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:outline-none max-[24rem]:px-2 max-[24rem]:text-xs {feed ===
          tab.feed
            ? settled === tab.feed
              ? 'text-on-accent font-semibold'
              : 'text-text-muted font-semibold'
            : 'text-text-muted hover:text-text-main font-medium'}"
        >
          {tab.label()}
        </button>
      {/each}
    </div>
  </div>
  <ReelsEntryButton {authToken} />
</div>
