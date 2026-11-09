<script lang="ts">
  import type { Snippet } from 'svelte';
  import {
    Camera,
    ChartColumn,
    ClipboardList,
    Clock,
    Images,
    Paperclip,
    Radio,
    ALargeSmall,
    X,
  } from '@lucide/svelte';
  import CameraOverlay from '$lib/components/reels/CameraOverlay.svelte';
  import type { ComposerReelState } from '$lib/posts/composerReelState';
  import MarkdownComposerToolbar from '$lib/components/shared/MarkdownComposerToolbar.svelte';
  import DateTimeField from '$lib/components/ui/DateTimeField.svelte';
  import { toDatetimeLocalValue } from '$lib/utils/dates';
  import { Log } from '$lib/utils/Log';
  import { currentAttachRuntime, opensNatively } from '$lib/utils/chat/attachSources';
  import { pickNatively } from '$lib/utils/chat/nativeAttachPicker';
  import { showToast } from '$lib/stores/toast.svelte';
  import { getLocale } from '$lib/paraglide/runtime';
  import { m } from '$lib/paraglide/messages';
  import { POST_ATTACHMENTS_MAX, attachmentsFull } from '$lib/posts/attachmentCap';

  /**
   * The bottom bar of the post composer and of the post editor: what can be attached, how the text
   * is formatted, and the action that sends it.
   *
   * WHY IT IS SHAPED LIKE THIS (user, 2026-09-29, comparing with Facebook's composer on the Mi 9T).
   * The composer used to put eight Markdown buttons on two rows ABOVE an empty text field, four
   * unlabelled icons under it, and "Publier" above those - so the action was met before anything was
   * attached, and nobody could guess the clipboard was a form. Here the attachments are LABELLED
   * chips, the action is last and under the thumb, and Markdown - which stays (user) - is one "Aa"
   * away: it swaps the chip row for the formatting row instead of adding a third row, because in a
   * composer pinned above the keyboard every row is taken from the text.
   *
   * WHY TWO FILE INPUTS AND NOT ONE. A single input accepting images, video, audio, PDF, Office and
   * zip together is what made Android open its generic file browser ("Recents", Audio, Documents)
   * instead of the photo picker: the accept list decides which chooser the OS can offer. So photos
   * and videos have their own input and documents theirs.
   *
   * THERE IS NO CAPTURE INPUT (user, 2026-10-11, D-camera: *"je ne veux pas d'acces a la camera
   * native"*). The ONE camera chip opens Canari's own camera as an overlay (`CameraOverlay`). A photo
   * taken there comes back as a file through `onFiles`, attached - and retained - as any picked post
   * media. A VIDEO filmed there from a NEW post (`reel` set) is a CanaReel, as from the tab (user,
   * 2026-10-19: one camera, one behaviour): the reel publish step takes it, says it is deleted after
   * 30 days, and can hand it back here as an ordinary post. The post EDITOR passes no `reel`, so its
   * camera attaches videos too: an existing post is never turned into a reel - and neither is a new
   * post asking for what a reel cannot carry (a schedule, a poll, a form, a linked event: the
   * composer then passes no `reel` either). A mouse has no camera
   * chip: `pointer-fine:hidden`.
   *
   * IN THE iOS APP "Photo/video" OPENS THE NATIVE PHOTO LIBRARY, as the chat's "Phototheque" does
   * (`opensNatively`): an input accepting images or videos is answered by WebKit's sheet, whose
   * "Prendre une photo ou une video" is the SYSTEM camera - the one D-camera removed (PR #1859
   * review, 2026-10-15). The documents input stays an input: its accept list holds no image or video,
   * so WebKit opens the document picker directly.
   */
  interface Props {
    /** Files picked through any of the inputs, in the order picked. Always an ADDITION. */
    onFiles: (files: File[]) => void;
    /** Applies a Markdown format to the editor this bar belongs to. */
    onFormat: (type: string) => void;
    /**
     * How many attachments the post holds or is about to hold (kept and pending alike). At the
     * cap (`POST_ATTACHMENTS_MAX`) the attach chips are disabled; `onFiles`' owner also trims what
     * a drop or a paste brings, since those never pass through a chip.
     */
    attachmentCount?: number;
    pollActive: boolean;
    onTogglePoll: () => void;
    formActive: boolean;
    onToggleForm: () => void;
    /** `datetime-local` value, `''` for "publish now". */
    scheduledAt?: string;
    /** Short status next to the formatting toggle (e.g. the draft was just saved). */
    status?: string;
    /** The primary action(s), drawn at the right of the last row. */
    action: Snippet;
    /**
     * Opens the broadcaster's screen (WP-L5). Absent, no "Live" chip is drawn: the composer passes
     * it only when `LIVE_ENABLED` is on and the chosen identity may broadcast (never anonymous).
     */
    onLive?: () => void;
    /**
     * Set by the NEW-post composer only: a video filmed with the camera becomes a CanaReel starting
     * from `start` (text, identity, "Entre étudiants"), and `onpublished` closes the composer behind
     * it. Absent (the post editor), every take is attached.
     */
    reel?: {
      start: ComposerReelState;
      onpublished: (identity: string) => void;
    };
  }

  let {
    onFiles,
    onFormat,
    attachmentCount = 0,
    pollActive,
    onTogglePoll,
    formActive,
    onToggleForm,
    scheduledAt = $bindable(''),
    status = '',
    action,
    onLive,
    reel,
  }: Props = $props();

  let formatting = $state(false);
  /** The chip row's last drawn height (px): the floor of the slot while the formatting row replaces it. */
  let chipRowHeight = $state(0);
  /** The post holds the most attachments it may: nothing more can be added. */
  const full = $derived(attachmentsFull(attachmentCount));
  /** The line beside the formatting toggle: the attachment counter, then the status, one message. */
  const statusLine = $derived.by(() => {
    if (attachmentCount === 0) return status;
    const counter = m.post_attachments_counter({
      count: attachmentCount,
      max: POST_ATTACHMENTS_MAX,
    });
    return status ? m.post_attachments_counter_with_status({ counter, status }) : counter;
  });
  const fullChip = 'pointer-events-none opacity-50';
  /** The in-app camera is open over the composer. */
  let cameraOpen = $state(false);
  /** The photo library is the native picker (the iOS app), never a file input. */
  const nativeLibrary = opensNatively(currentAttachRuntime(false), 'library');

  /** The iOS app's photo library: PHPicker, its picks handed over like an input's. */
  function pickLibraryNatively() {
    Log.d('POST_COMPOSER', 'photo library: the native picker');
    pickNatively('library')
      .then((files) => {
        Log.d('POST_COMPOSER', `${files.length} file(s) picked via the native library`);
        if (files.length > 0) onFiles(files);
      })
      .catch((error: unknown) => {
        console.error(`[POST_COMPOSER] the native library picker failed: ${String(error)}`);
        showToast(m.chat_attach_picker_failed());
      });
  }

  /** Formatted for the chip, in the reader's locale; the input keeps its own value. */
  const scheduledLabel = $derived.by(() => {
    if (!scheduledAt) return m.post_create_schedule_button_label();
    const d = new Date(scheduledAt);
    return d.toLocaleString(getLocale() === 'en' ? 'en-US' : 'fr-FR', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  });

  /**
   * Hands what an input picked to the caller, then EMPTIES the input.
   *
   * An `<input type="file">` reports its whole selection on every change, so a caller that appends
   * would duplicate a previous pick - unless the input is reset after each one, which is also what
   * lets the same photo be picked twice. Every input here is reset, so every pick is an addition.
   */
  function takeFiles(event: Event, via: string) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    Log.d('POST_COMPOSER', `${files.length} file(s) picked via ${via}`);
    if (files.length > 0) onFiles(files);
  }

  /*
   * THE RING IS FOR A KEYBOARD, NEVER FOR A TAP. It was `focus-within`, and a file input keeps focus
   * after its chooser closes - so the chip last tapped wore a ring for good, clipped flat at top and
   * bottom by the scrolling row (Mi 9T, 2026-09-29: *"le halo autour de Photo/video n'est pas tres
   * bien rendu"*). `:focus-visible` is what a browser sets for keyboard focus only; a label has no
   * focus of its own, so it asks its input with `has-`. The row carries `py-1` so a ring that IS
   * drawn has room.
   */
  const chipClass =
    'relative flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-amber-500/50 active:scale-95';
  const idleChip = 'border-cn-border text-text-main hover:bg-black/5 dark:hover:bg-white/10';
  const activeChip = 'border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-400';

  const DOCUMENT_ACCEPT =
    'audio/*,.pdf,.doc,.docx,.odt,.xls,.xlsx,.ods,.ppt,.pptx,.odp,.txt,.rtf,.zip,.epub';
</script>

{#if cameraOpen}
  <CameraOverlay
    destination={reel ? 'post' : 'post-edit'}
    oncapture={(file) => {
      Log.d('POST_COMPOSER', `camera take handed over (${file.type}, ${file.size} bytes)`);
      onFiles([file]);
    }}
    onclose={() => (cameraOpen = false)}
    composerStart={reel?.start}
    onpublished={reel?.onpublished}
  />
{/if}

<div class="flex flex-col gap-2">
  <!--
    THE SWAP IS A SAME-SIZE CONTENT CHANGE. The chips wrap onto two rows on an Android phone and three
    on an iPhone 12 (measured, 2026-11-06: the text area jumped 148 pt taller under a selection the
    moment "Aa" was tapped, when the formatting row was a single row of icons). The formatting actions
    are now labelled chips of the same class, wrapping the same way, so they fill the room the
    attachments leave; the chip row's last height is also remembered (bound while it is drawn) and
    held as the slot's floor, for the few points two wrappings can differ by.
  -->
  <div
    class="flex min-h-9 items-stretch"
    style:min-height={formatting && chipRowHeight > 0 ? `${chipRowHeight}px` : undefined}
  >
    {#if formatting}
      <MarkdownComposerToolbar
        chipClass="{chipClass} {idleChip}"
        {onFormat}
        class="w-full content-start"
      />
    {:else}
      <div
        data-chip-row
        bind:clientHeight={chipRowHeight}
        class="flex w-full flex-wrap items-center gap-2"
      >
        {#if nativeLibrary}
          <button
            type="button"
            class="{chipClass} {idleChip} {full ? fullChip : ''}"
            data-post-library
            disabled={full}
            onclick={pickLibraryNatively}
          >
            <Images size={16} strokeWidth={2.25} class="text-emerald-600 dark:text-emerald-400" />
            {m.post_composer_photo_video()}
          </button>
        {:else}
          <label class="{chipClass} {idleChip} {full ? fullChip : ''}">
            <Images size={16} strokeWidth={2.25} class="text-emerald-600 dark:text-emerald-400" />
            {m.post_composer_photo_video()}
            <input
              type="file"
              accept="image/*,video/*"
              multiple
              disabled={full}
              class="sr-only"
              onchange={(e) => takeFiles(e, 'gallery')}
            />
          </label>
        {/if}
        <button
          type="button"
          class="{chipClass} {idleChip} pointer-fine:hidden {full ? fullChip : ''}"
          data-post-camera
          disabled={full}
          onclick={() => {
            Log.d('POST_COMPOSER', 'in-app camera opened');
            cameraOpen = true;
          }}
        >
          <Camera size={16} strokeWidth={2.25} class="text-sky-600 dark:text-sky-400" />
          {m.post_composer_camera()}
        </button>
        {#if onLive}
          <button
            type="button"
            class="{chipClass} {idleChip}"
            data-post-live
            onclick={() => {
              Log.d('POST_COMPOSER', 'live screen opened');
              onLive();
            }}
          >
            <Radio size={16} strokeWidth={2.25} class="text-red-600 dark:text-red-400" />
            {m.live_composer_chip()}
          </button>
        {/if}
        <button
          type="button"
          class="{chipClass} {pollActive ? activeChip : idleChip}"
          aria-pressed={pollActive}
          onclick={onTogglePoll}
        >
          <ChartColumn size={16} strokeWidth={2.25} class="text-amber-600 dark:text-amber-400" />
          {m.post_poll_section_title()}
        </button>
        <button
          type="button"
          class="{chipClass} {formActive ? activeChip : idleChip}"
          aria-pressed={formActive}
          onclick={onToggleForm}
        >
          <ClipboardList
            size={16}
            strokeWidth={2.25}
            class="text-violet-600 dark:text-violet-400"
          />
          {m.post_form_fallback_title()}
        </button>
        <label class="{chipClass} {idleChip} {full ? fullChip : ''}">
          <Paperclip size={16} strokeWidth={2.25} class="text-text-muted" />
          {m.post_composer_file()}
          <input
            type="file"
            accept={DOCUMENT_ACCEPT}
            multiple
            disabled={full}
            class="sr-only"
            onchange={(e) => takeFiles(e, 'documents')}
          />
        </label>
        <!-- The app's own date field, drawn AS the chip: the native input that used to cover it
             opened Android's date dialog and then a separate clock dialog. -->
        <DateTimeField
          value={scheduledAt}
          onValueChange={(v) => (scheduledAt = v)}
          label={m.post_create_schedule_publication_label()}
          min={toDatetimeLocalValue(new Date(Date.now() + 60000).toISOString())}
          triggerClass="{chipClass} {scheduledAt ? activeChip : idleChip}"
        >
          {#snippet trigger()}
            <Clock size={16} strokeWidth={2.25} class="text-text-muted" />
            {scheduledLabel}
          {/snippet}
        </DateTimeField>
        {#if scheduledAt}
          <button
            type="button"
            class="ui-icon-button text-text-muted shrink-0 rounded-full hover:text-red-500"
            aria-label={m.post_create_cancel_schedule_label()}
            onclick={() => (scheduledAt = '')}
          >
            <X size={16} strokeWidth={2.5} />
          </button>
        {/if}
      </div>
    {/if}
  </div>

  <div class="flex items-center gap-2">
    <button
      type="button"
      class="ui-icon-button shrink-0 rounded-full transition-colors {formatting
        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
        : 'text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/10'}"
      aria-pressed={formatting}
      aria-label={m.post_composer_formatting()}
      title={m.post_composer_formatting()}
      onmousedown={(e) => e.preventDefault()}
      onclick={() => (formatting = !formatting)}
    >
      <ALargeSmall size={20} strokeWidth={2.25} />
    </button>
    <span
      class="text-2xs min-w-0 flex-1 truncate font-semibold {full
        ? 'text-amber-700 dark:text-amber-400'
        : 'text-text-muted'}"
      data-attachment-counter={attachmentCount > 0 ? '' : undefined}>{statusLine}</span
    >
    {@render action()}
  </div>
</div>
