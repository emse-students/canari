<script lang="ts">
  /**
   * THE CANAREELS FILTER AT THE TOP OF THE FEED (user, 2026-10-15): "Tout" or "CanaReels", drawn as
   * the app's fixed segmented control (section-navigation). A VIEW on the feed, not a place - C7
   * keeps reels out of every bar. What the choice does is the feed page's (`selectKind`); the
   * vocabulary is `$lib/posts/feedKindFilter`.
   */
  import { Clapperboard, LayoutList } from '@lucide/svelte';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import type { FeedKindFilter } from '$lib/posts/feedKindFilter';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The filter the feed is drawn under. */
    value: FeedKindFilter;
    /** Called with the filter the reader picked. */
    onSelect: (filter: FeedKindFilter) => void;
  }

  let { value, onSelect }: Props = $props();

  const ITEMS: { key: FeedKindFilter; label: string; icon: typeof LayoutList }[] = [
    { key: 'all', label: m.posts_filter_all(), icon: LayoutList },
    { key: 'reel', label: m.posts_filter_reels(), icon: Clapperboard },
  ];
</script>

<div data-feed-kind-filter>
  <SegmentedControl items={ITEMS} {value} {onSelect} label={m.posts_filter_aria()} />
</div>
