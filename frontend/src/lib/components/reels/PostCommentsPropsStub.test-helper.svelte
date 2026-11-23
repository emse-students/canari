<script lang="ts">
  /** Stands in for `PostComments` and exposes the two flags a host must pass it. */
  let { canLike = true, readOnly = false }: { canLike?: boolean; readOnly?: boolean } = $props();
</script>

<div data-comments-stub data-can-like={canLike} data-read-only={readOnly}></div>
