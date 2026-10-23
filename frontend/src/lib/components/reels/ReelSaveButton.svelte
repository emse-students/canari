<script lang="ts">
  /**
   * Saves a reel - any reel being watched, since 2026-10-09 (user), and the member's own before its
   * deletion (C6): into the phone's gallery on the phone
   * apps, as a download elsewhere (`saveReel`).
   *
   * A REFUSED GALLERY ACCESS NAMES ITS REMEDY AND OFFERS IT: the toast says the access is in the
   * phone's settings, and the button becomes the way there (`openAppSettings`) - a message that
   * names a remedy the screen does not offer leaves the member to find it alone.
   */
  import { Download, LoaderCircle, Settings } from '@lucide/svelte';
  import { saveReel, type SaveableReel } from '$lib/reels/saveReel';
  import { openAppSettings } from '$lib/reels/gallery';
  import { showToast } from '$lib/stores/toast.svelte';
  import { m } from '$lib/paraglide/messages';

  /** `rail`: drawn as the reel rail's plain icon (no disc), the settings remedy as an icon too. */
  let { reel, rail = false }: { reel: SaveableReel; rail?: boolean } = $props();

  let saving = $state(false);
  let denied = $state(false);

  async function save() {
    saving = true;
    try {
      const outcome = await saveReel(reel);
      console.debug(`[reel-save] ${reel.id}: ${outcome}`);
      if (outcome === 'saved') showToast(m.reels_save_done(), 'info');
      if (outcome === 'denied') {
        denied = true;
        showToast(m.reels_save_denied(), 'warning');
      }
    } catch (err) {
      console.error(`[reel-save] ${reel.id} could not be saved`, err);
      showToast(m.reels_save_error(), 'error');
    } finally {
      saving = false;
    }
  }

  async function settings() {
    try {
      await openAppSettings();
      // Back from the settings, the next press asks again.
      denied = false;
    } catch (err) {
      console.error('[reel-save] the settings page did not open', err);
      showToast(m.reels_save_error(), 'error');
    }
  }
</script>

{#if denied}
  <button
    type="button"
    class={rail
      ? 'ui-icon-button rounded-full text-white outline-none focus-visible:ring-2 focus-visible:ring-amber-500'
      : 'inline-flex items-center gap-2 rounded-full bg-black/50 px-3 py-2 text-xs font-semibold text-white outline-none hover:bg-black/70 focus-visible:ring-2 focus-visible:ring-amber-500'}
    aria-label={rail ? m.reels_open_settings() : undefined}
    title={rail ? m.reels_open_settings() : undefined}
    onclick={settings}
    data-reel-open-settings
  >
    <Settings
      size={rail ? 26 : 16}
      strokeWidth={rail ? 2 : 2.5}
      class={rail ? 'drop-shadow-md' : ''}
    />
    {#if !rail}{m.reels_open_settings()}{/if}
  </button>
{:else}
  <button
    type="button"
    class="ui-icon-button rounded-full text-white outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-60 {rail
      ? ''
      : 'bg-black/40 hover:bg-black/60'}"
    aria-label={m.reels_save()}
    title={m.reels_save()}
    disabled={saving}
    onclick={save}
    data-reel-save
  >
    {#if saving}
      <LoaderCircle size={rail ? 26 : 22} strokeWidth={rail ? 2 : 2.5} class="animate-spin" />
    {:else}
      <Download
        size={rail ? 26 : 22}
        strokeWidth={rail ? 2 : 2.5}
        class={rail ? 'drop-shadow-md' : ''}
      />
    {/if}
  </button>
{/if}
