<script lang="ts">
  /**
   * A test stand-in for `LiveFeedCard`: one button that opens a fixed live through `onOpen`, so a
   * test can open the viewer without the network or the card's list.
   */
  let { onOpen }: { onOpen: (live: { id: string }) => void } = $props();
</script>

<button type="button" data-stub="live-card" onclick={() => onOpen({ id: 'live-1' })}>live</button>
