<script lang="ts">
  /** A test stand-in for `CreatePostForm`: one button that chooses "En direct". */
  let {
    onGoLive,
  }: {
    onGoLive: (t: { associationId: string | null; associationName: string | null }) => void;
  } = $props();
</script>

<button
  type="button"
  data-stub="composer-go-live"
  onclick={() => onGoLive({ associationId: null, associationName: null })}>go live</button
>
