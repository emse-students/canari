<script lang="ts">
  import { Smartphone } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { viewportOrientation } from '$lib/mobile/screenOrientation.svelte';
  import VideoChipButton from './VideoChipButton.svelte';

  /**
   * THE ROTATE BUTTON of the video and camera screens (owner, 2026-11-09; screen-orientation.md):
   * landscape from portrait - even with the phone's rotation lock on - and portrait from landscape.
   * The kit's round chip, so it reads as the speaker and the expand chip do.
   *
   * The caller draws it only where the build can turn the screen (`useScreenOrientation().canRotate`,
   * the native app) and hands it the hook's `rotate`. The glyph is a phone lying the way the press
   * will turn it.
   */
  interface Props {
    onrotate: () => void;
    /** Off while the orientation is frozen (a take, a live on air). */
    disabled?: boolean;
    /** Drawn as its own glass chip; off inside a glass bar (VideoChipButton). */
    glass?: boolean;
    class?: string;
  }

  let { onrotate, disabled = false, glass = true, class: klass = '' }: Props = $props();

  const landscape = $derived(viewportOrientation.landscape);
  const label = $derived(landscape ? m.screen_rotate_portrait() : m.screen_rotate_landscape());
</script>

<VideoChipButton
  {label}
  title={label}
  onclick={onrotate}
  {disabled}
  {glass}
  class={klass}
  data-rotate-button={landscape ? 'to-portrait' : 'to-landscape'}
>
  <Smartphone
    size={glass ? 16 : 20}
    strokeWidth={2.25}
    class="drop-shadow transition-transform duration-200 motion-reduce:transition-none {landscape
      ? ''
      : 'rotate-90'}"
  />
</VideoChipButton>
