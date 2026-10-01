<script lang="ts">
  import { X } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { videoPrepareProgressLabel } from '$lib/video/videoPrepareMessages';

  /**
   * The line shown while a video is re-encoded on the device (`prepareVideoForUpload`): how far it
   * is, as a bar and a percentage, and the one control that stops it. Shared by the post composer,
   * the post editor and the chat composer, so a member meets the same thing everywhere a video
   * waits - a 90 s clip takes 10 to 30 s on the bench phones, which is too long to show nothing.
   */
  interface Props {
    /** Share done, 0 to 1. */
    fraction: number;
    /** Aborts the preparation. */
    oncancel: () => void;
  }

  let { fraction, oncancel }: Props = $props();

  const percent = $derived(Math.max(0, Math.min(100, Math.round(fraction * 100))));
</script>

<div
  class="bg-cn-bg text-cn-dark mb-2 flex items-center gap-3 rounded-lg px-3 py-2"
  data-testid="video-preparation"
>
  <div class="min-w-0 flex-1">
    <p class="text-sm font-semibold" aria-live="polite">{videoPrepareProgressLabel(fraction)}</p>
    <div
      class="bg-cn-border mt-1.5 h-1.5 overflow-hidden rounded-full"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <div class="bg-cn-yellow h-full rounded-full" style:width="{percent}%"></div>
    </div>
  </div>
  <button
    type="button"
    onclick={oncancel}
    aria-label={m.video_prepare_cancel()}
    title={m.video_prepare_cancel()}
    class="ui-icon-button text-cn-dark shrink-0"
  >
    <X size={18} strokeWidth={2.5} />
  </button>
</div>
