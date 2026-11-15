<script lang="ts">
  /** Stands in for `LinkPreviewCard`: says which URL it was handed and whether it is the hero. */
  let { url, hero = false }: { url: string; hero?: boolean } = $props();
</script>

<div data-link-stub data-url={url} data-hero={hero ? 'true' : 'false'}></div>
