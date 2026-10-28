<script lang="ts">
  /** A page that crashes once it is mounted - the way a page's `$effect` throws in production. */
  $effect(() => {
    throw new Error('page effect threw');
  });
</script>

<p data-testid="page">page</p>
