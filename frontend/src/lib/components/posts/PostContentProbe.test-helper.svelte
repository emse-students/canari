<script lang="ts">
  /** Stands in for `PostContent`: says whether it was asked to show the whole text. */
  let { fullContent = false }: { fullContent?: boolean } = $props();
</script>

<div data-content-probe data-full={fullContent ? 'true' : 'false'}></div>
