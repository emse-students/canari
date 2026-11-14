<script lang="ts">
  /**
   * THE SCENE BAR OF A DESKTOP LIVE (owner, 2026-11-14): five ready-made scenes, one click each, in
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
    Video,
  } from '@lucide/svelte';
  import type { Component } from 'svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
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
  }

  let { studio, showHint = false }: Props = $props();

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
  const SHAPES: readonly OverlayShape[] = ['round', 'rect'];
  const SHAPE_LABEL: Record<OverlayShape, () => string> = {
    round: m.live_scene_overlay_round,
    rect: m.live_scene_overlay_rect,
  };

  function choose(scene: LiveScene) {
    console.debug(`[LIVE-SCREEN] scene ${scene} clicked`);
    void studio.selectScene(scene);
  }

  /**
   * A scene is a `ui/Button` (controls.md): the chosen one wears the fill, the others the quiet
   * filled secondary - the bar's ONE fill, which says which scene is on air.
   */
  function variantOf(chosen: boolean): 'primary' | 'soft' {
    return chosen ? 'primary' : 'soft';
  }
</script>

<div class="flex flex-col gap-2" data-live-scene-bar>
  <div class="flex flex-wrap gap-1.5" role="radiogroup" aria-label={m.live_scene_bar_label()}>
    {#each LIVE_SCENES as scene (scene)}
      {@const Icon = SCENE_ICON[scene]}
      <Button
        variant={variantOf(studio.scene === scene)}
        size="compact"
        role="radio"
        aria-checked={studio.scene === scene}
        disabled={studio.choosingScreen}
        onclick={() => choose(scene)}
        data-live-scene={scene}
      >
        <Icon size={16} strokeWidth={2.25} />
        {SCENE_LABEL[scene]()}
      </Button>
    {/each}
  </div>
  {#if studio.scene === 'screen-camera'}
    <!-- The overlay's size and shape: two small fixed sets, so `ui/SegmentedControl` in its
         over-a-video look - the scene above keeps the ONE fill of the bar (controls.md). -->
    <div class="flex flex-wrap items-center gap-3" data-live-overlay-options>
      <div data-live-overlay-sizes>
        <SegmentedControl
          variant="overlay"
          label={m.live_scene_overlay_size_label()}
          items={SIZES.map((size) => ({ key: size, label: SIZE_LABEL[size]() }))}
          value={studio.overlay.size}
          onSelect={(size) => studio.setOverlay({ size })}
        />
      </div>
      <div data-live-overlay-shapes>
        <SegmentedControl
          variant="overlay"
          label={m.live_scene_overlay_shape_label()}
          items={SHAPES.map((shape) => ({
            key: shape,
            label: SHAPE_LABEL[shape](),
            icon: shape === 'round' ? Circle : RectangleHorizontal,
          }))}
          value={studio.overlay.shape}
          onSelect={(shape) => studio.setOverlay({ shape })}
        />
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
