<script lang="ts">
  interface Props {
    /** The picture to blur: an image URL, or a data URL of one decoded video frame. */
    src: string;
  }

  let { src }: Props = $props();
</script>

<!--
  THE REMAINDER OF A CONTAINED PICTURE (the one copy; `LetterboxedImage` and a video box use it).

  The same picture, blurred hard and scaled past the edges so the blur's own transparent fringe never
  reaches the box, then veiled with `--cn-surface` so the bands sit in the theme instead of shouting
  over it. Deliberately not a dominant-colour extraction: no pixel read, no worker, no second fetch.
  The parent is `relative overflow-hidden`; this fills it and sits under whatever follows.
-->
<div
  class="absolute inset-0 scale-125 bg-cover bg-center blur-2xl saturate-150"
  style="background-image: url({src})"
  aria-hidden="true"
></div>
<div class="bg-cn-surface/35 absolute inset-0" aria-hidden="true"></div>
