<script lang="ts">
  /** Stands in for `PostAuthorAvatar`. */
  let { post }: { post?: { id?: string } } = $props();
</script>

<span data-avatar-stub={post?.id}></span>
