<script lang="ts">
  /** A test stand-in for `LiveViewer`: a marker naming the live it was opened on. */
  let { live }: { live: { id: string } } = $props();
</script>

<div data-stub="live-viewer">{live.id}</div>
