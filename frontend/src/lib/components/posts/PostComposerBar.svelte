<script lang="ts">
  import type { Snippet } from 'svelte';
  import {
    Camera,
    ChartColumn,
    ClipboardList,
    Clock,
    Images,
    Paperclip,
    ALargeSmall,
    Video,
    X,
  } from '@lucide/svelte';
  import MarkdownComposerToolbar from '$lib/components/shared/MarkdownComposerToolbar.svelte';
  import { Log } from '$lib/utils/Log';
  import { getLocale } from '$lib/paraglide/runtime';
  import { m } from '$lib/paraglide/messages';

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
   * WHY FOUR FILE INPUTS AND NOT ONE. A single input accepting images, video, audio, PDF, Office and
   * zip together is what made Android open its generic file browser ("Recents", Audio, Documents)
   * instead of the photo picker: the accept list decides which chooser the OS can offer. So photos
   * and videos have their own input, documents theirs, and the two capture inputs carry `capture` -
   * which the Android app's WebView (wry's `RustWebChromeClient.onShowFileChooser`) turns into the
   * system camera for `image/*` and the video recorder for `video/*`, as a phone browser does.
   * Capture means nothing to a mouse, so those two chips are not drawn for a fine pointer.
   */
  interface Props {
    /** Files picked through any of the inputs, in the order picked. Always an ADDITION. */
    onFiles: (files: File[]) => void;
    /** Applies a Markdown format to the editor this bar belongs to. */
    onFormat: (type: string) => void;
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
  }

  let {
    onFiles,
    onFormat,
    pollActive,
    onTogglePoll,
    formActive,
    onToggleForm,
    scheduledAt = $bindable(''),
    status = '',
    action,
  }: Props = $props();

  let formatting = $state(false);

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

<div class="flex flex-col gap-2">
  <div class="flex min-h-9 items-center">
    {#if formatting}
      <MarkdownComposerToolbar row {onFormat} class="w-full" />
    {:else}
      <div class="no-scrollbar -my-1 flex w-full items-center gap-2 overflow-x-auto px-0.5 py-1">
        <label class="{chipClass} {idleChip}">
          <Images size={16} strokeWidth={2.25} class="text-emerald-600 dark:text-emerald-400" />
          {m.post_composer_photo_video()}
          <input
            type="file"
            accept="image/*,video/*"
            multiple
            class="sr-only"
            onchange={(e) => takeFiles(e, 'gallery')}
          />
        </label>
        <label class="{chipClass} {idleChip} pointer-fine:hidden">
          <Camera size={16} strokeWidth={2.25} class="text-sky-600 dark:text-sky-400" />
          {m.post_composer_camera()}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            class="sr-only"
            onchange={(e) => takeFiles(e, 'camera')}
          />
        </label>
        <label class="{chipClass} {idleChip} pointer-fine:hidden">
          <Video size={16} strokeWidth={2.25} class="text-rose-600 dark:text-rose-400" />
          {m.post_composer_record_video()}
          <input
            type="file"
            accept="video/*"
            capture="environment"
            class="sr-only"
            onchange={(e) => takeFiles(e, 'video capture')}
          />
        </label>
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
        <label class="{chipClass} {idleChip}">
          <Paperclip size={16} strokeWidth={2.25} class="text-text-muted" />
          {m.post_composer_file()}
          <input
            type="file"
            accept={DOCUMENT_ACCEPT}
            multiple
            class="sr-only"
            onchange={(e) => takeFiles(e, 'documents')}
          />
        </label>
        <!-- The date input COVERS the chip, transparent: a tap anywhere on it opens the platform's
             own date-and-time picker, and the chip only draws what was chosen. -->
        <span class="{chipClass} {scheduledAt ? activeChip : idleChip}">
          <Clock size={16} strokeWidth={2.25} class="text-text-muted" />
          {scheduledLabel}
          <input
            type="datetime-local"
            bind:value={scheduledAt}
            min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
            aria-label={m.post_create_schedule_publication_label()}
            class="absolute inset-0 cursor-pointer opacity-0"
          />
        </span>
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
    <span class="text-text-muted text-2xs min-w-0 flex-1 truncate font-semibold">{status}</span>
    {@render action()}
  </div>
</div>
