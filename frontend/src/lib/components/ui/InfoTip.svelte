<script lang="ts">
  import { Info } from '@lucide/svelte';
  import FloatingSurface from './FloatingSurface.svelte';
  import { opensAsSheet } from './floatingSurface';
  import { Log } from '$lib/utils/Log';

  /**
   * AN "i" THAT EXPLAINS A CONTROL: a 44px button beside it, opening the explanation in a popover
   * (a sheet on a phone). A tap, a click, Enter or Space opens it; a tap outside or Escape closes
   * it and gives focus back. Not a hover tooltip: a hover reaches neither a touch screen nor the
   * keyboard, and the text is a sentence to read, not a name.
   */
  interface Props {
    /** The button's accessible name, and the sheet's title: the question the text answers. */
    label: string;
    /** The explanation. */
    text: string;
  }

  let { label, text }: Props = $props();

  let open = $state(false);
  let asSheet = $state(false);
  let anchor = $state<HTMLButtonElement | null>(null);

  function toggle() {
    if (open) {
      open = false;
      return;
    }
    asSheet = opensAsSheet();
    open = true;
    Log.d('InfoTip', `open "${label}" as ${asSheet ? 'sheet' : 'popover'}`);
  }
</script>

<button
  bind:this={anchor}
  type="button"
  onclick={toggle}
  aria-label={label}
  aria-expanded={open}
  aria-haspopup="dialog"
  data-testid="info-tip"
  class="ui-icon-button text-text-muted hover:text-text-main shrink-0 rounded-full transition-colors hover:bg-black/5 dark:hover:bg-white/10"
>
  <Info size={16} aria-hidden="true" />
</button>

<FloatingSurface
  {open}
  {asSheet}
  {anchor}
  {label}
  popoverWidth="content"
  onClose={(refocus) => {
    open = false;
    if (refocus) anchor?.focus();
  }}
>
  <p class="text-text-main max-w-72 px-3 py-2 text-sm" data-testid="info-tip-text">{text}</p>
</FloatingSurface>
