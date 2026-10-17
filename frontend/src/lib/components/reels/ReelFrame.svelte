<script lang="ts">
  /**
   * THE ONE FRAME of CanaReels (docs/wiki/frontend/modules/reel-editor.md): the camera, the review, the
   * editor and the viewer all put their picture in this box, so what is captured, edited and published
   * is the same rectangle (user, 2026-10-11).
   *
   * The frame of aspect `ratio` is shown WHOLE in the screen (never cropped). When the screen has its
   * shape it runs edge to edge with square corners; otherwise it is centred with `--radius-2xl`
   * corners and the rest of the screen is the blurred backdrop of the same picture. Within 2 % of its
   * shape the frame IS the stage (cover on purpose, no sliver of backdrop). The stage FOLLOWS the
   * measured box (the camera records what is visible) except while `latch` is set - the editor's text
   * field is open - when it keeps the largest height seen (`stageStep`), so the keyboard shrinking the
   * layout viewport never moves or resizes the frame. The parent's controls are siblings of this component, not children:
   * a child sits INSIDE the frame and is clipped to it.
   */
  import type { Snippet } from 'svelte';
  import {
    REEL_FRAME_RATIO,
    containFrame,
    frameReachesBottom,
    stageStep,
    type StageState,
  } from '$lib/reels/reelFrame';
  import ReelBackdrop from './ReelBackdrop.svelte';

  interface Props {
    /** The frame's width / height; defaults to the canonical reel frame. */
    ratio?: number;
    /** What fills the frame: a video or image at `absolute inset-0 h-full w-full`. */
    children: Snippet;
    /** The frame element, for a caller that has to read its box. */
    frameEl?: HTMLElement | null;
    /** Hold the stage at the largest height seen (the keyboard may shrink the box). */
    latch?: boolean;
    /**
     * Whether the frame reaches the stage bottom (`frameReachesBottom`), for a caller whose overlay
     * owes the bottom safe-area inset only there. Written by the frame.
     */
    reachesBottom?: boolean;
  }

  let {
    ratio = REEL_FRAME_RATIO,
    children,
    frameEl = $bindable(null),
    latch = false,
    reachesBottom = $bindable(false),
  }: Props = $props();

  let boxWidth = $state(0);
  let boxHeight = $state(0);
  /** Not reactive: each measure is folded into the previous state (`stageStep`). */
  let stageState: StageState = { kept: { width: 0, height: 0 }, holding: false };
  const stage = $derived.by(() => {
    const next = stageStep(stageState, { width: boxWidth, height: boxHeight }, latch);
    if (next.holding !== stageState.holding || next.kept.height !== stageState.kept.height) {
      console.debug(
        `[reel-frame] stage ${next.kept.width}x${next.kept.height} latch=${latch} holding=${next.holding}`
      );
    }
    stageState = next;
    return next.kept;
  });
  const box = $derived(containFrame(stage, ratio));

  $effect(() => {
    reachesBottom = frameReachesBottom(stage, box);
  });

  $effect(() => {
    console.debug(`[reel-frame] ratio ${ratio.toFixed(3)} fillsStage=${box.fillsStage}`);
  });
</script>

<div
  class="bg-cn-scrim absolute inset-0 overflow-hidden"
  bind:clientWidth={boxWidth}
  bind:clientHeight={boxHeight}
  data-reel-stage
>
  <ReelBackdrop host={frameEl} active={!box.fillsStage && box.width > 0} />
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
