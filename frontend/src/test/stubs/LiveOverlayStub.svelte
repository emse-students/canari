<script lang="ts">
  /** A test stand-in for `LiveOverlay`: a marker and the button that ends the live. */
  let { onclose }: { onclose: () => void } = $props();
</script>

<div data-stub="live-overlay">
  <button type="button" data-stub="live-overlay-end" onclick={onclose}>end</button>
</div>
