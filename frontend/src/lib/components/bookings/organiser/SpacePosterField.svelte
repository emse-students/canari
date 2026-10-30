<script lang="ts">
  import { ImagePlus, Trash2 } from '@lucide/svelte';
  import SpacePoster from '$lib/components/bookings/SpacePoster.svelte';
  import { CONTROL_HINT_CLASS, CONTROL_LABEL_CLASS } from '$lib/components/ui/controlClasses';
  import { POSTER_MIME_TYPES, setSpacePoster, type SpacePoster as Poster } from '$lib/bookings/api';
  import { describeBookingRefusal } from '$lib/bookings/refusals';
  import { MediaService, preparePostMedia } from '$lib/media';
  import { getToken } from '$lib/stores/auth';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * THE SPACE'S POSTER IN THE EDITOR (D35, section General). Saved ON ITS OWN the moment it is
   * picked or removed, as a resource is - never through the settings bar: an image uploaded and then
   * left unsaved would be ciphertext nobody cites.
   *
   * The posts' path, copied: compressed on the device (`preparePostMedia`), encrypted with a key of
   * its own and uploaded `archive` (`encryptAndUpload`), and only the reference goes to the server,
   * which keeps the new one and releases the one it replaces (`booking-poster-media.ts`).
   *
   * In the creation wizard (D52) there is no space yet: `spaceId` is null, the reference is only
   * handed to `onChanged`, and the creation claims it (`POST bookings/spaces`). An image picked and
   * then abandoned with the wizard is left to the idle sweep of `poster-pending` uploads.
   */
  interface Props {
    /** The space the poster is saved on at once, or null when the creation will carry it. */
    spaceId: string | null;
    spaceName: string;
    poster: Poster | null;
    onChanged: (poster: Poster | null) => void;
    /**
     * Whether an upload is under way: the wizard holds its steps meanwhile, so a creation cannot
     * leave before `onChanged` hands it the poster.
     */
    onBusy?: (busy: boolean) => void;
  }

  let { spaceId, spaceName, poster, onChanged, onBusy }: Props = $props();

  let busy = $state(false);
  let error = $state('');

  $effect(() => {
    onBusy?.(busy);
  });

  /** A file dragged over the zone, so it can show it will take it. */
  let over = $state(false);

  /** The input's choice: the click and keyboard route to the same upload as a drop. */
  function picked(event: Event & { currentTarget: HTMLInputElement }) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (file) void upload(file);
  }

  function dropped(event: DragEvent) {
    event.preventDefault();
    over = false;
    const file = event.dataTransfer?.files?.[0];
    if (file) void upload(file);
  }

  async function upload(picked: File) {
    if (busy) return;
    Log.d('BOOKINGS', `poster picked: ${picked.type || 'no type'}, ${picked.size} B`);
    error = '';
    if (!(POSTER_MIME_TYPES as readonly string[]).includes(picked.type)) {
      error = m.bookings_poster_type_error();
      return;
    }
    busy = true;
    try {
      const { file, dims } = await preparePostMedia(picked);
      // The compressor may change the type; the server accepts only these three.
      if (!(POSTER_MIME_TYPES as readonly string[]).includes(file.type)) {
        Log.i('BOOKINGS', `poster compressed to an unaccepted type: ${file.type}`);
        error = m.bookings_poster_type_error();
        return;
      }
      const ref = await new MediaService().encryptAndUpload(
        file,
        await getToken(),
        dims,
        // The class only a poster upload names: the space's save claims it (review of #2045).
        'poster-pending'
      );
      const next: Poster = {
        type: 'image',
        mediaId: ref.mediaId,
        key: ref.key,
        iv: ref.iv,
        mimeType: ref.mimeType,
        size: ref.size,
        ...(ref.width ? { width: ref.width } : {}),
        ...(ref.height ? { height: ref.height } : {}),
      };
      if (spaceId) {
        await setSpacePoster(spaceId, next);
        Log.i('BOOKINGS', `poster set space=${spaceId.slice(0, 8)}`);
      } else {
        Log.i('BOOKINGS', 'poster uploaded for the space being created');
      }
      onChanged(next);
    } catch (e) {
      Log.i('BOOKINGS', `poster not set: ${String(e)}`);
      error = describeBookingRefusal(e, m.bookings_poster_choose());
    } finally {
      busy = false;
    }
  }

  async function remove() {
    if (busy) return;
    busy = true;
    error = '';
    try {
      if (spaceId) {
        await setSpacePoster(spaceId, null);
        Log.i('BOOKINGS', `poster removed space=${spaceId.slice(0, 8)}`);
      } else {
        Log.d('BOOKINGS', 'poster dropped from the space being created');
      }
      onChanged(null);
    } catch (e) {
      Log.i('BOOKINGS', `poster not removed: ${String(e)}`);
      error = describeBookingRefusal(e, m.bookings_poster_remove());
    } finally {
      busy = false;
    }
  }
</script>

<div class="space-y-2">
  <span class={CONTROL_LABEL_CLASS}>{m.bookings_field_poster()}</span>
  <!-- The zone takes a dropped file, a click and the keyboard (the file input inside the label is
       focusable, its focus ring drawn on the zone), whether or not a poster is already set. -->
  <div
    role="presentation"
    ondragover={(e) => {
      e.preventDefault();
      over = true;
    }}
    ondragleave={() => (over = false)}
    ondrop={dropped}
    class="space-y-2"
  >
    {#if poster}
      <SpacePoster {poster} alt={m.bookings_poster_alt({ name: spaceName })} />
    {/if}
    <label
      data-poster-zone
      class="text-text-main focus-within:ring-cn-yellow flex cursor-pointer items-center justify-center gap-2 rounded-2xl border border-dashed text-sm font-semibold transition-colors focus-within:ring-2 {poster
        ? 'bg-control-fill hover:bg-cn-border/60 border-transparent px-4 py-2.5'
        : 'bg-cn-yellow/5 hover:bg-cn-yellow/10 min-h-32 flex-col px-4 py-6 text-center'} {over
        ? 'border-cn-yellow bg-cn-yellow/15'
        : poster
          ? ''
          : 'border-cn-yellow/50'} {busy ? 'cursor-not-allowed opacity-40' : ''}"
    >
      <input
        type="file"
        class="sr-only"
        accept={POSTER_MIME_TYPES.join(',')}
        disabled={busy}
        onchange={picked}
      />
      <ImagePlus size={poster ? 16 : 24} class={poster ? '' : 'text-text-muted'} />
      {busy
        ? m.bookings_poster_saving()
        : poster
          ? m.bookings_poster_replace()
          : m.bookings_poster_choose()}
    </label>
    {#if poster}
      <button
        type="button"
        onclick={remove}
        disabled={busy}
        class="text-text-muted hover:text-red-err inline-flex min-h-10 items-center gap-2 rounded-xl px-2 text-sm font-semibold transition-colors disabled:opacity-40"
      >
        <Trash2 size={16} />
        {m.bookings_poster_remove()}
      </button>
    {/if}
  </div>
  <p class={CONTROL_HINT_CLASS}>
    {spaceId ? m.bookings_poster_hint() : m.bookings_wizard_poster_hint()}
  </p>
  {#if error}
    <p class="text-red-err text-xs font-medium" role="alert">{error}</p>
  {/if}
</div>
