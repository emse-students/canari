<script lang="ts">
  /**
   * THE SCENE BAR OF A DESKTOP LIVE (owner, 2026-11-14): five ready-made scenes, one click each, as ONE icon-only row, in
   * the pre-live sheet and over the picture while on air - and, for "screen + camera", the overlay's
   * size and shape. Every decision is the studio's (`liveStudio.svelte.ts`); a click here only calls
   * it, FROM the click, because a scene that needs the screen opens the browser's picker, which only
   * a click may do.
   */
  import {
    Circle,
    CirclePause,
    Columns2,
    Monitor,
    PictureInPicture2,
    RectangleHorizontal,
    Square,
    Video,
  } from '@lucide/svelte';
  import type { Component } from 'svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { rovingTarget } from '$lib/components/ui/rovingFocus';
  import { m } from '$lib/paraglide/messages';
  import type { LiveStudio } from '$lib/live/liveStudio.svelte';
  import {
    LIVE_SCENES,
    type LiveScene,
    type OverlayShape,
    type OverlaySize,
  } from '$lib/live/liveScenes';

  interface Props {
    studio: LiveStudio;
    /** The privacy and sound sentence: in the pre-live sheet, never over the picture on air. */
    showHint?: boolean;
    /** Over the picture on air: the rows sit at the right edge, clear of the chat at the left. */
    onAir?: boolean;
  }

  let { studio, showHint = false, onAir = false }: Props = $props();

  const SCENE_LABEL: Record<LiveScene, () => string> = {
    camera: m.live_scene_camera,
    screen: m.live_scene_screen,
    'screen-camera': m.live_scene_screen_camera,
    'side-by-side': m.live_scene_side_by_side,
    pause: m.live_scene_pause,
  };
  const SCENE_ICON: Record<LiveScene, Component<{ size?: number; strokeWidth?: number }>> = {
    camera: Video,
    screen: Monitor,
    'screen-camera': PictureInPicture2,
    'side-by-side': Columns2,
    pause: CirclePause,
  };
  const SIZES: readonly OverlaySize[] = ['small', 'medium', 'large'];
  const SIZE_LABEL: Record<OverlaySize, () => string> = {
    small: m.live_scene_overlay_small,
    medium: m.live_scene_overlay_medium,
    large: m.live_scene_overlay_large,
  };
  /** The icon's pixel size says the camera's: a small, a medium and a large square. */
  const SIZE_ICON: Record<OverlaySize, number> = { small: 12, medium: 16, large: 20 };
  const SHAPES: readonly OverlayShape[] = ['round', 'rect'];
  const SHAPE_LABEL: Record<OverlayShape, () => string> = {
    round: m.live_scene_overlay_round,
    rect: m.live_scene_overlay_rect,
  };

  function choose(scene: LiveScene) {
    console.debug(`[LIVE-SCREEN] scene ${scene} clicked`);
    void studio.selectScene(scene);
  }

  let sceneGroup = $state<HTMLDivElement | null>(null);

  /**
   * The scene radios are ONE tab stop (the chosen scene) and the arrows move between them
   * (`rovingTarget`, the keys `SegmentedControl` answers). The arrows move FOCUS only - Enter or
   * Space selects, as the segmented control's `manual` activation: a scene changes what the viewers
   * see, and a screen scene opens the browser's picker, so passing over one must not choose it.
   */
  function onSceneKeydown(event: KeyboardEvent, index: number) {
    const next = rovingTarget(event.key, index, LIVE_SCENES.length);
    if (next < 0) return;
    event.preventDefault();
    sceneGroup?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  }

  /**
   * A scene is a `ui/Button` (controls.md): the chosen one wears the fill, the others the quiet
   * filled secondary - the bar's ONE fill, which says which scene is on air.
   */
  function variantOf(chosen: boolean): 'primary' | 'soft' {
    return chosen ? 'primary' : 'soft';
  }
</script>

<div
  class="flex max-w-full flex-col gap-2 {onAir ? 'items-end' : 'items-start'}"
  data-live-scene-bar
>
  <!-- ONE icon-only row (owner, 2026-11-16: no labels spread about, nothing wrapping or overlapping
       the chat): the name of a scene is its `aria-label` and its tooltip, the chosen one wears the
       fill, and "Je reviens" is set apart by a rule at the end of the row. -->
  <div
    bind:this={sceneGroup}
    class="flex items-center gap-1 rounded-full bg-black/45 p-1 backdrop-blur-sm"
    role="radiogroup"
    aria-label={m.live_scene_bar_label()}
  >
    {#each LIVE_SCENES as scene, index (scene)}
      {@const Icon = SCENE_ICON[scene]}
      {#if scene === 'pause'}
        <span class="mx-0.5 h-5 w-px shrink-0 bg-white/30" aria-hidden="true"></span>
      {/if}
      <Button
        variant={variantOf(studio.scene === scene)}
        size="compact"
        icon
        class="rounded-full"
        role="radio"
        aria-checked={studio.scene === scene}
        aria-label={SCENE_LABEL[scene]()}
        title={SCENE_LABEL[scene]()}
        tabindex={studio.scene === scene ? 0 : -1}
        disabled={studio.choosingScreen}
        onclick={() => choose(scene)}
        onkeydown={(event: KeyboardEvent) => onSceneKeydown(event, index)}
        data-live-scene={scene}
      >
        <Icon size={18} strokeWidth={2.25} />
      </Button>
    {/each}
  </div>
  {#if studio.scene === 'screen-camera'}
    <!-- The overlay's size and shape: two small fixed sets, icon-only like the row above (the
         names are aria-labels and tooltips), in ONE line that never wraps. -->
    <div
      class="flex items-center gap-1 rounded-full bg-black/45 p-1 backdrop-blur-sm"
      data-live-overlay-options
    >
      <div
        class="flex items-center gap-1"
        role="radiogroup"
        aria-label={m.live_scene_overlay_size_label()}
        data-live-overlay-sizes
      >
        {#each SIZES as size (size)}
          <Button
            variant={variantOf(studio.overlay.size === size)}
            size="compact"
            icon
            class="rounded-full"
            role="radio"
            aria-checked={studio.overlay.size === size}
            aria-label={SIZE_LABEL[size]()}
            title={SIZE_LABEL[size]()}
            onclick={() => studio.setOverlay({ size })}
            data-live-overlay-size={size}
          >
            <Square size={SIZE_ICON[size]} strokeWidth={2.25} />
          </Button>
        {/each}
      </div>
      <span class="mx-0.5 h-5 w-px shrink-0 bg-white/30" aria-hidden="true"></span>
      <div
        class="flex items-center gap-1"
        role="radiogroup"
        aria-label={m.live_scene_overlay_shape_label()}
        data-live-overlay-shapes
      >
        {#each SHAPES as shape (shape)}
          {@const ShapeIcon = shape === 'round' ? Circle : RectangleHorizontal}
          <Button
            variant={variantOf(studio.overlay.shape === shape)}
            size="compact"
            icon
            class="rounded-full"
            role="radio"
            aria-checked={studio.overlay.shape === shape}
            aria-label={SHAPE_LABEL[shape]()}
            title={SHAPE_LABEL[shape]()}
            onclick={() => studio.setOverlay({ shape })}
            data-live-overlay-shape={shape}
          >
            <ShapeIcon size={16} strokeWidth={2.25} />
          </Button>
        {/each}
      </div>
    </div>
  {/if}
  {#if studio.screenEnded}
    <p class="text-sm text-white/90" role="status" data-live-screen-ended>
      {m.live_scene_screen_ended()}
    </p>
  {:else if showHint}
    <p class="max-w-md text-xs text-white/80" data-live-scene-hint>{m.live_scene_screen_hint()}</p>
  {/if}
</div>
