<script lang="ts">
  /** Stands in for `Avatar` in the reel overlay tests: whose picture would be drawn, nothing fetched. */
  let { userId }: { userId: string } = $props();
</script>

<span data-avatar-stub={userId}></span>
