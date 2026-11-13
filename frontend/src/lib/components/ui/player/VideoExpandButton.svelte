<script lang="ts">
  import { Maximize2 } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import VideoChipButton from './VideoChipButton.svelte';

  /**
   * OPENS THE FULL-SCREEN VIEWER (owner, 2026-11-09). A tap on a feed or chat video used to open it;
   * the tap now toggles the sound, so the viewer is this chip's, in the corner opposite the speaker.
   */
  interface Props {
    onclick: () => void;
    /** The accessible name; defaults to the generic "open in full screen". */
    label?: string;
    class?: string;
  }

  let { onclick, label = m.video_expand_label(), class: klass = '' }: Props = $props();
</script>

<VideoChipButton {label} {onclick} class={klass}>
  <Maximize2 size={14} strokeWidth={2.5} class="drop-shadow" />
</VideoChipButton>
