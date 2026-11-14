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
   * A choice is a `ui/Button` (controls.md): the chosen one wears the fill, the others the quiet
   * filled secondary - each group is a radio group, so ONE fill per group says which is on.
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
    <div class="flex flex-wrap items-center gap-1.5" data-live-overlay-options>
      <div class="flex gap-1" role="radiogroup" aria-label={m.live_scene_overlay_size_label()}>
        {#each SIZES as size (size)}
          <Button
            variant={variantOf(studio.overlay.size === size)}
            size="compact"
            role="radio"
            aria-checked={studio.overlay.size === size}
            onclick={() => studio.setOverlay({ size })}
            data-live-overlay-size={size}
          >
            {SIZE_LABEL[size]()}
          </Button>
        {/each}
      </div>
      <div class="flex gap-1" role="radiogroup" aria-label={m.live_scene_overlay_shape_label()}>
        {#each SHAPES as shape (shape)}
          <Button
            variant={variantOf(studio.overlay.shape === shape)}
            size="compact"
            role="radio"
            aria-checked={studio.overlay.shape === shape}
            onclick={() => studio.setOverlay({ shape })}
            data-live-overlay-shape={shape}
          >
            {#if shape === 'round'}
              <Circle size={14} strokeWidth={2.25} />
            {:else}
              <RectangleHorizontal size={14} strokeWidth={2.25} />
            {/if}
            {SHAPE_LABEL[shape]()}
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
