<script lang="ts">
  /** Stands in for `VideoPlayer` in the reel tests: the element, without the engine's playback. */
  let { src, class: klass = '' }: { src: string; class?: string } = $props();
</script>

<div class={klass} data-video-player-stub={src}></div>
