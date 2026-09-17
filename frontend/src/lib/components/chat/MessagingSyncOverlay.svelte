<script lang="ts">
  import { LoaderCircle } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Status line shown under the spinner (e.g. catch-up vs unlock). */
    message?: string;
  }

  let { message = m.chat_sync_overlay_message() }: Props = $props();
</script>

<!--
  OPAQUE, BECAUSE IT BLOCKS. This panel is shown while messaging is unusable, so what is behind it
  is precisely what must not be read or reached; it carried a `/95` and the user reported the
  result - *"Panneau 'Connexion en cours' transparent par dessus /chat, on voit a travers c'est
  moche"*. Five percent is enough to ghost a whole conversation through it, and the ladder in
  `app.css` already says a scrim with the page painted through reads as a rendering fault.

  The rung is `--z-page-blocking`, not a number: it must cover the page's own banners and composer
  at `--z-page-overlay`. The raw `z-50` it replaces is a leftover the 2026-09-09 sweep counted and
  did not reach.
-->
<div
  class="absolute inset-0 z-(--z-page-blocking) flex flex-col items-center justify-center gap-3 bg-[color-mix(in_srgb,var(--cn-surface)_92%,white)] px-6 text-center dark:bg-[color-mix(in_srgb,var(--cn-surface)_88%,black)]"
  role="status"
  aria-live="polite"
  aria-busy="true"
>
  <LoaderCircle size={28} class="shrink-0 animate-spin text-amber-500" strokeWidth={2} />
  <p class="text-text-main text-sm font-medium">{message}</p>
  <p class="text-text-muted max-w-sm text-xs">
    {m.chat_sync_overlay_description()}
  </p>
</div>
