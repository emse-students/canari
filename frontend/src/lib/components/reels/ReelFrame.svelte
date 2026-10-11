<script lang="ts">
  /**
   * THE ONE FRAME of CanaReels (docs/wiki/frontend/modules/reel-editor.md): the camera, the review, the
   * editor and the viewer all put their picture in this box, so what is captured, edited and published
   * is the same rectangle (user, 2026-10-11).
   *
   * The frame of aspect `ratio` is shown WHOLE in the screen (never cropped). When the screen has its
   * shape it runs edge to edge with square corners; otherwise it is centred with `--radius-2xl`
   * corners and the rest of the screen is the blurred backdrop of the same picture. The stage is kept
   * at the largest height seen (`stableStageSize`), so a keyboard shrinking the layout viewport never
   * moves or resizes the frame. The parent's controls are siblings of this component, not children:
   * a child sits INSIDE the frame and is clipped to it.
   */
  import type { Snippet } from 'svelte';
  import {
    REEL_FRAME_RATIO,
    containFrame,
    stableStageSize,
    type StageSize,
  } from '$lib/reels/reelFrame';
  import ReelBackdrop from './ReelBackdrop.svelte';

  interface Props {
    /** The frame's width / height; defaults to the canonical reel frame. */
    ratio?: number;
    /** What fills the frame: a video or image at `absolute inset-0 h-full w-full`. */
    children: Snippet;
    /** The frame element, for a caller that has to read its box. */
    frameEl?: HTMLElement | null;
  }

  let { ratio = REEL_FRAME_RATIO, children, frameEl = $bindable(null) }: Props = $props();

  let boxWidth = $state(0);
  let boxHeight = $state(0);
  /** Latched, not reactive: each measure is folded into the previous kept size (it only grows). */
  let keptStage: StageSize = { width: 0, height: 0 };
  const stage = $derived.by(() => {
    keptStage = stableStageSize(keptStage, { width: boxWidth, height: boxHeight });
    return keptStage;
  });
  const box = $derived(containFrame(stage, ratio));
</script>

<div
  class="bg-cn-scrim absolute inset-0 overflow-hidden"
  bind:clientWidth={boxWidth}
  bind:clientHeight={boxHeight}
  data-reel-stage
>
  <ReelBackdrop host={frameEl} />
  <div
    bind:this={frameEl}
    class="absolute overflow-hidden bg-black {box.fillsStage ? '' : 'rounded-2xl'}"
    style={`left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px`}
    data-reel-frame
    data-reel-frame-fills={box.fillsStage}
  >
    {@render children()}
  </div>
</div>
