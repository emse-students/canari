<script lang="ts">
  interface Props {
    /** The picture, and also what paints the remainder. One URL, drawn twice. */
    src: string;
    alt: string;
    /** Extra classes for the `<img>`, on top of the contain/fill pair this component owns. */
    imgClass?: string;
    /** Extra classes for the box. The caller owns its SHAPE; this component owns what is inside. */
    class?: string;
    loading?: 'lazy' | 'eager';
  }

  let { src, alt, imgClass = '', class: boxClass = '', loading = 'lazy' }: Props = $props();
</script>

<!--
  SHOW THE WHOLE PICTURE, AND FILL WHAT THE BOX HAS LEFT OVER WITH THE PICTURE ITSELF.

  Wherever a box's shape is imposed by something other than the picture - a modal, a card, a preview
  slot - `object-cover` absorbs the difference by cutting. An A4 poster (ratio 0.707, which is what
  an association actually posts) lost 44% of itself that way in a 680px column, starting with the
  band at the bottom carrying the date and the place: *"on manque de l'information"* (user,
  2026-09-10). `object-contain` shows all of it and leaves a remainder instead.

  The remainder is the SAME picture, blurred hard and scaled past the edges so the blur's own
  transparent fringe never reaches the box, then veiled with `--cn-surface` so the bands sit in the
  theme instead of shouting over it. **Deliberately not a dominant-colour extraction**: no canvas,
  no pixel read, no worker, no second fetch - and the bands still come from the picture's own
  colours by construction, with the theme holding them.

  THE BOX'S HEIGHT COMES FROM ONE OF TWO PLACES, AND THE CALLER SAYS WHICH. Either the caller
  reserves the shape and the picture fills it (`imgClass="h-full"`, what a feed does so the layout
  does not jump while the bytes arrive), or the caller states only a ceiling and the CONTAINED
  picture sets the height itself (`imgClass="max-h-[60svh]"`, what a modal does, having no
  dimensions to reserve from). The `<img>` stays in flow for exactly that reason - an absolutely
  positioned one would collapse the second case to nothing.
-->
<div class="relative overflow-hidden {boxClass}">
  <div
    class="absolute inset-0 scale-125 bg-cover bg-center blur-2xl saturate-150"
    style="background-image: url({src})"
    aria-hidden="true"
  ></div>
  <div class="bg-cn-surface/35 absolute inset-0" aria-hidden="true"></div>
  <img {src} {alt} {loading} decoding="async" class="relative w-full object-contain {imgClass}" />
</div>
