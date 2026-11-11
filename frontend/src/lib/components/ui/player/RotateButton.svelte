<script lang="ts">
  import { Smartphone } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { viewportOrientation } from '$lib/mobile/screenOrientation.svelte';
  import CameraControlButton from '../CameraControlButton.svelte';

  /**
   * THE ROTATE BUTTON of the camera screens (owner, 2026-11-09; screen-orientation.md): landscape
   * from portrait - even with the phone's rotation lock on - and portrait from landscape.
   *
   * It is the SAME control as its siblings, flip and flash (`CameraControlButton`): the first cut
   * drew the video kit's 28px chip and, turned, a bordered circle (owner, 2026-11-11).
   *
   * The caller draws it only where the build can turn the screen (`useScreenOrientation().canRotate`,
   * the native app) and hands it the hook's `rotate`. The glyph is a phone lying the way the press
   * will turn it.
   */
  interface Props {
    onrotate: () => void;
    /** Off while the orientation is frozen (a take, a live on air). */
    disabled?: boolean;
    class?: string;
  }

  let { onrotate, disabled = false, class: klass = '' }: Props = $props();

  const landscape = $derived(viewportOrientation.landscape);
  const label = $derived(landscape ? m.screen_rotate_portrait() : m.screen_rotate_landscape());
</script>

<CameraControlButton
  {label}
  onclick={onrotate}
  {disabled}
  class={klass}
  data-rotate-button={landscape ? 'to-portrait' : 'to-landscape'}
>
  <Smartphone
    size={22}
    strokeWidth={2.25}
    class="transition-transform duration-200 motion-reduce:transition-none {landscape
      ? ''
      : 'rotate-90'}"
  />
</CameraControlButton>
