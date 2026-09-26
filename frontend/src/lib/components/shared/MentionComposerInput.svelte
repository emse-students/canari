<script lang="ts">
  import { goto } from '$app/navigation';
  import MentionDropdown from './MentionDropdown.svelte';
  import { useMentionAutocomplete } from '$lib/composables/useMentionAutocomplete.svelte';
  import {
    COMPOSER_EMPTY_LINE_FILLER,
    getMentionChipFromEventTarget,
    EMOJI_IMAGE_SELECTOR,
    getPlainTextSelection,
    composerMarkdownPreviewEnabled,
    needsEmojiRender,
    needsMentionChipRender,
    removeMentionChipBeforeCursor,
    removeNewlineFillerBeforeCursor,
    stepOverFillerBesideCaret,
    renderPlainTextToMentionEditor,
    serializeMentionEditor,
    setPlainTextSelection,
    shouldRerenderComposerDom,
  } from '$lib/utils/mentions/mentionEditor';
  import {
    filesFromTransfer,
    carriesUninsertableMarkup,
    localFileAddressesFromTransfer,
  } from '$lib/utils/composerTransfer';
  import { showToast } from '$lib/stores/toast.svelte';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    value?: string;
    placeholder?: string;
    disabled?: boolean;
    singleLine?: boolean;
    /** Live markdown preview (* / _ italic_, __underline__, **bold**, escapes, muted delimiters). */
    markdownPreview?: boolean;
    maxlength?: number;
    minHeight?: string;
    class?: string;
    editorClass?: string;
    /** When set, only users whose IDs are in this list appear in @mention suggestions. */
    allowedUserIds?: string[];
    onchange?: (text: string) => void;
    onkeydown?: (e: KeyboardEvent) => void;
    onpaste?: (e: ClipboardEvent) => void;
    /**
     * Files a reader pasted or dropped ONTO the editor, handed to whoever owns the attachments.
     *
     * The editor never inserts them: its body is Markdown and could not hold them (see
     * `handleEditorPaste`). A caller that omits this still gets the refusal - the files are simply
     * not attached anywhere, which is the honest outcome for a composer that has no attachments.
     */
    onmedia?: (files: File[]) => void;
    onfocus?: () => void;
    onblur?: () => void;
  }

  let {
    value = $bindable(''),
    placeholder = '',
    disabled = false,
    singleLine = false,
    markdownPreview = false,
    maxlength,
    minHeight = '44px',
    class: className = '',
    editorClass = '',
    allowedUserIds,
    onchange,
    onkeydown,
    onpaste,
    onmedia,
    onfocus,
    onblur,
  }: Props = $props();

  let editorEl = $state<HTMLDivElement | null>(null);
  let lastRenderedValue = $state('');
  let isComposing = $state(false);
  /** Suppresses input handlers while we replace editor HTML (prevents duplicate characters). */
  let isApplyingDom = false;
  /** Skips one external `value` sync after we update the editor locally (avoids stale parent props). */
  let pendingInternalSync = 0;
  /**
   * Tracks whether the editor contains text, updated directly from the DOM in input handlers.
   * Used for placeholder visibility - more reliable than reactive `value` on some environments.
   */
  let editorHasContent = $state(false);

  const mention = useMentionAutocomplete({
    getText: () => value,
    setText: (text, moveCursorTo) => syncFromPlainText(text, moveCursorTo),
    getCursor: () => (editorEl ? getPlainTextSelection(editorEl).start : 0),
    setCursor: (pos) => {
      if (editorEl) setPlainTextSelection(editorEl, pos, pos);
    },
    focus: () => editorEl?.focus(),
    get allowedUserIds() {
      return allowedUserIds;
    },
  });

  const renderOptions = $derived({ markdownPreview });

  function clampText(text: string): string {
    if (maxlength === undefined || text.length <= maxlength) return text;
    return text.slice(0, maxlength);
  }

  function applyDomFromPlainText(text: string, cursor?: number) {
    if (!editorEl) return;
    isApplyingDom = true;
    pendingInternalSync++;
    renderPlainTextToMentionEditor(editorEl, text, {
      markdownPreview: composerMarkdownPreviewEnabled(text, renderOptions),
    });
    lastRenderedValue = text;
    const pos = cursor ?? getPlainTextSelection(editorEl).start;
    setPlainTextSelection(editorEl, pos, pos);
    queueMicrotask(() => {
      if (!editorEl) return;
      setPlainTextSelection(editorEl, pos, pos);
      isApplyingDom = false;
    });
  }

  function syncFromPlainText(text: string, moveCursorTo?: number) {
    text = clampText(text);
    if (moveCursorTo !== undefined && maxlength !== undefined) {
      moveCursorTo = Math.min(moveCursorTo, maxlength);
    }
    editorHasContent = text.length > 0;
    value = text;
    lastRenderedValue = text;
    onchange?.(text);
    if (editorEl) {
      applyDomFromPlainText(text, moveCursorTo);
    }
  }

  function emitEditorChange() {
    if (!editorEl || isComposing || isApplyingDom) return;
    const text = clampText(serializeMentionEditor(editorEl));
    let { start } = getPlainTextSelection(editorEl);
    if (maxlength !== undefined) start = Math.min(start, maxlength);

    const needsMentions = needsMentionChipRender(editorEl, text);
    const needsDom =
      needsMentions ||
      needsEmojiRender(editorEl) ||
      shouldRerenderComposerDom(text, lastRenderedValue, renderOptions);

    if (needsDom) {
      applyDomFromPlainText(text, start);
    }

    if (text !== value) {
      pendingInternalSync++;
      value = text;
      lastRenderedValue = text;
      onchange?.(text);
    } else if (!needsDom) {
      lastRenderedValue = text;
    }

    mention.handleEditorInput(text, start);
  }

  $effect(() => {
    if (!editorEl) return;
    if (pendingInternalSync > 0) {
      pendingInternalSync--;
      // Only skip if the DOM is already up-to-date (internal update already applied).
      // If value changed externally (e.g. parent clearing the field after send),
      // proceed with the DOM update even if the counter wasn't fully drained.
      if (value === lastRenderedValue) return;
    }
    if (value === lastRenderedValue) return;

    const domText = serializeMentionEditor(editorEl);
    if (value === domText) {
      lastRenderedValue = value;
      return;
    }

    renderPlainTextToMentionEditor(editorEl, value, {
      markdownPreview: composerMarkdownPreviewEnabled(value, renderOptions),
    });
    lastRenderedValue = value;
    editorHasContent = value.length > 0;
  });

  function handleEditorInput() {
    // Update placeholder state immediately from DOM, before emitEditorChange processing.
    // An editor holding only an emoji picture has an empty `textContent`, and the placeholder would
    // then sit on top of it.
    editorHasContent =
      (editorEl?.textContent ?? '') !== '' || !!editorEl?.querySelector(EMOJI_IMAGE_SELECTOR);
    if (isApplyingDom) return;
    emitEditorChange();
  }

  function handleEditorClick(e: MouseEvent) {
    const userId = getMentionChipFromEventTarget(e.target);
    if (userId) {
      e.preventDefault();
      e.stopPropagation();
      void goto(`/profile/${userId}`);
    }
  }

  function handleEditorKeydown(e: KeyboardEvent) {
    if (e.key === 'Backspace' && removeMentionChipBeforeCursor(editorEl!)) {
      e.preventDefault();
      emitEditorChange();
      return;
    }
    if (e.key === 'Backspace' && editorEl && removeNewlineFillerBeforeCursor(editorEl)) {
      e.preventDefault();
      emitEditorChange();
      return;
    }
    // NOT prevented: only the invisible filler is stepped over here, and the arrow's own default
    // then moves the caret the one visible position the user asked for. Word and line jumps
    // (Ctrl, Alt, Meta) are left to the browser.
    if (
      (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
      editorEl &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey
    ) {
      stepOverFillerBesideCaret(
        editorEl,
        e.key === 'ArrowLeft' ? 'backward' : 'forward',
        e.shiftKey
      );
    }
    // `markdownPreview` (not `composerMarkdownPreviewEnabled(...)`, a check on the CURRENT text,
    // removed 2026-09-16) is what tells apart the two callers of this component: a free-text
    // field (`MarkdownComposerField`, no `onkeydown` of its own) owns Enter itself and always
    // wants a newline, while `ChatComposer` passes `markdownPreview` false specifically so Enter
    // reaches ITS `onkeydown` and decides send-vs-newline there. Gating the free-text case on
    // "does the text look like markdown right now" left PLAIN text - the common case - falling
    // through to the browser's own broken default (see `insertNewlineAtCursor`'s docblock): typing
    // "hello", Enter, "world" produced "helloworld" with the line break silently gone, same defect
    // as the one this file already fixed for formatted text, just unguarded for everything else.
    if (e.key === 'Enter' && !singleLine && markdownPreview && editorEl && !e.isComposing) {
      e.preventDefault();
      insertNewlineAtCursor();
      return;
    }
    if (mention.handleKeydown(e)) return;
    onkeydown?.(e);
  }

  /** @public */
  export function focusEditor() {
    editorEl?.focus();
  }

  /** @public */
  export function getSelectionRange(): { start: number; end: number } {
    if (!editorEl) return { start: 0, end: 0 };
    return getPlainTextSelection(editorEl);
  }

  /** @public */
  export function setSelectionRange(start: number, end: number = start) {
    if (editorEl) setPlainTextSelection(editorEl, start, end);
  }

  /** @public */
  export function getEditorElement(): HTMLDivElement | null {
    return editorEl;
  }

  /**
   * @public - Inserts a real line break at the caret, by hand, rather than leaving it to the
   * browser's own default `Enter` handling OR to `syncFromPlainText` (an EXTERNAL sync, meant
   * for a `bind:value` caller like `MarkdownComposerField` - see below for why a one-way
   * `value`/`onchange` caller cannot use it the same way).
   *
   * WHY NOT LEAVE IT TO THE BROWSER. Measured 2026-09-16: an unprevented plain `Enter` splits the
   * contenteditable into a new BLOCK (`hello<div>world</div>`), which `serializeMentionEditor`
   * reads back as `"helloworld"` - the boundary silently dropped, not merely un-styled.
   * `Shift+Enter`'s own browser default inserts a `<br>` instead, which DOES round-trip - but that
   * is an accident of what the default handler does for ONE key combination, not a guarantee a
   * second caller may rely on. This reproduces that same `<br>` shape by hand.
   *
   * WHY NOT `syncFromPlainText`, WHICH ALREADY DOES EXACTLY THIS FOR THE MARKDOWN-PREVIEW CASE
   * ABOVE. That caller is only ever reached under `MarkdownComposerField`'s `bind:value` - a
   * two-way binding, where the parent's variable and this component's `value` are the same
   * underlying source, so writing `value` here IS the whole update. `ChatComposer` binds one-way
   * (`value={messageText}` + `onchange`): the write here still fires `onchange`, but the parent
   * then hands the SAME text back down as a fresh `value` PROP a tick later, which is a second,
   * independent trip through this component's own `value`-changed effect - one this component
   * cannot tell apart from a real external edit. Measured: the caret `syncFromPlainText` had just
   * placed was gone by the time that second trip re-rendered, and a character typed immediately
   * after landed where the caret would have been withOUT the newline, before the line break
   * "caught up" from behind it (`"helloworld\n"` instead of `"hello\nworld"`).
   *
   * Mutating the DOM directly and firing a real `input` event sidesteps the whole question: it is
   * the exact path every ordinary keystroke already takes (`oninput` -> `emitEditorChange`), which
   * has no such race under either binding mode, because nothing but a real edit ever reaches it.
   */
  export function insertNewlineAtCursor() {
    if (!editorEl) return;
    const { start, end } = getPlainTextSelection(editorEl);
    setPlainTextSelection(editorEl, start, end);
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const br = document.createElement('br');
    range.insertNode(br);
    range.setStartAfter(br);
    range.collapse(true);
    // A caret placed right after a `<br>` with nothing MEANINGFUL following it anchors to the
    // PARENT element at a child-index offset rather than inside a text node - and typing then
    // lands BEFORE the `<br>` in Chrome, not after (measured 2026-09-16: pressing Enter at the
    // end of the text, the ordinary case, produces exactly this). "Nothing meaningful" is not
    // "no sibling": splitting a text node at its own end - exactly what just happened above -
    // leaves an EMPTY text node as that sibling, which anchors no better than none at all, by
    // the same measurement. `\u200B` is this codebase's own existing filler convention
    // (`stripComposerDomFillers`, already called by every `serializeMentionEditor` read) rather
    // than a new one: a non-empty placeholder gives the caret a real anchor, and the character
    // never reaches a sent message.
    const after = br.nextSibling;
    if (!(after instanceof Text) || after.data === '') {
      const zwsp = after instanceof Text ? after : document.createTextNode('');
      if (!(after instanceof Text)) br.after(zwsp);
      zwsp.data = COMPOSER_EMPTY_LINE_FILLER;
      range.setStart(zwsp, 1);
      range.collapse(true);
    }
    sel.removeAllRanges();
    sel.addRange(range);
    editorEl.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }

  /**
   * Inserts PLAIN TEXT at the caret, by the same route an ordinary keystroke takes.
   *
   * Same shape and same reasons as `insertNewlineAtCursor` above - a direct DOM mutation followed
   * by a real `input` event, rather than a write to `value`, because a one-way (`value` +
   * `onchange`) caller cannot take the `syncFromPlainText` path without losing the caret. Read that
   * function's docblock; this one adds only the line splitting.
   *
   * Newlines become `<br>`, which is the ONE break `serializeMentionEditor` reads back - a block
   * element would have its boundary silently dropped. A single-line composer flattens them to
   * spaces instead of silently swallowing the text after the first one.
   */
  function insertPlainTextAtCursor(text: string) {
    if (!editorEl || !text) return;
    const { start, end } = getPlainTextSelection(editorEl);
    setPlainTextSelection(editorEl, start, end);
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();

    const normalised = text.replace(/\r\n?/g, '\n');
    const lines = singleLine ? [normalised.replace(/\n+/g, ' ')] : normalised.split('\n');

    const fragment = document.createDocumentFragment();
    lines.forEach((line, i) => {
      if (i > 0) fragment.appendChild(document.createElement('br'));
      if (line) fragment.appendChild(document.createTextNode(line));
    });
    // A caret after a trailing `<br>` anchors to the parent at a child index and types BEFORE it -
    // the measurement is in `insertNewlineAtCursor`, and the filler convention is the same one.
    if (fragment.lastChild instanceof HTMLBRElement) {
      fragment.appendChild(document.createTextNode(COMPOSER_EMPTY_LINE_FILLER));
    }

    const last = fragment.lastChild;
    range.insertNode(fragment);
    if (last) {
      range.setStartAfter(last);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    editorEl.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }

  /**
   * A PASTE PUTS TEXT IN THE BODY AND FILES IN THE ATTACHMENTS, AND NOTHING ELSE EVER.
   *
   * The browser's own default for a `contenteditable` is to insert the clipboard's `text/html`.
   * That is how an `<img>` reached a body made of Markdown: it rendered, `serializeMentionEditor`
   * walked through it on save, and the reader was shown something the document could not hold
   * (user, 2026-09-18: *"ce qui n'est evidemment pas sauvegarde ... du coup ca ne devrait meme pas
   * etre possible"*). With a foreign origin it is not even a disappointment - pasting a picture out
   * of a Messenger tab produced `blob:https://www.messenger.com/...` and a security error the
   * reader could do nothing with, because that blob is readable only by the page that made it.
   *
   * So the default is refused UNCONDITIONALLY, before anything is examined. What replaces it is
   * decided from the clipboard: real files go to `onmedia` exactly as the media button's own picker
   * would deliver them, and everything else is inserted as `text/plain`. Rich text pasted from a
   * document therefore keeps its words and loses its styling, which is what a Markdown body can
   * represent - the alternative was keeping markup on screen that the next save deletes.
   *
   * A caller's own `onpaste` still runs first and still wins: `ChatComposer` had this handler
   * written twice over, and the one kept is the one on the element that owns the caret.
   */
  function handleEditorPaste(event: ClipboardEvent) {
    onpaste?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();

    const files = filesFromTransfer(event.clipboardData);
    if (files.length > 0) {
      if (!onmedia) {
        Log.d('COMPOSER', `paste carried ${files.length} file(s); this composer takes none`);
        return;
      }
      onmedia(files);
      return;
    }

    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text) {
      insertPlainTextAtCursor(text);
      return;
    }
    if (carriesUninsertableMarkup(event.clipboardData)) {
      Log.d('COMPOSER', 'paste carried markup with no file and no text - nothing inserted');
    }
  }

  /**
   * Claims the drag, because a `contenteditable` is a drop target by default and the default is
   * exactly the defect: letting the browser handle it is how an image lands in the body.
   */
  function handleEditorDragOver(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  /**
   * A DROP IS A PASTE WITH A CURSOR: same rule, same two destinations.
   *
   * `stopPropagation` because an outer drop zone may be listening for the same files - `ChatComposer`
   * wraps this editor in one - and two handlers attaching the same drop is one attachment too many.
   */
  function handleEditorDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();

    const files = filesFromTransfer(event.dataTransfer);
    if (files.length > 0) {
      if (!onmedia) {
        Log.d('COMPOSER', `drop carried ${files.length} file(s); this composer takes none`);
        return;
      }
      onmedia(files);
      return;
    }

    // A FILE THE ENGINE WITHHELD IS NOT TEXT. Firefox given a file by Nemo receives only its address
    // and path; inserting that pasted the file's name into the message (reported 2026-09-25).
    const refused = localFileAddressesFromTransfer(event.dataTransfer);
    if (refused.length > 0) {
      console.warn(
        `[COMPOSER] drop announced ${refused.length} local file(s) but handed over none - the file manager did not give the browser the file`
      );
      showToast(m.composer_drop_file_unreadable());
      return;
    }

    const text = event.dataTransfer?.getData('text/plain') ?? '';
    if (text) {
      insertPlainTextAtCursor(text);
      return;
    }
    if (carriesUninsertableMarkup(event.dataTransfer)) {
      Log.d('COMPOSER', 'drop carried markup with no file and no text - nothing inserted');
    }
  }

  /**
   * @public - Flushes any active IME composition into the value before sending.
   * Must be called right before onSend() to prevent the last uncomposed word from being lost.
   */
  export function commitComposition() {
    if (!editorEl || isApplyingDom) return;
    if (!isComposing) return;
    const text = clampText(serializeMentionEditor(editorEl));
    isComposing = false;
    if (text !== value) {
      value = text;
      lastRenderedValue = text;
      editorHasContent = text.length > 0;
      onchange?.(text);
    }
  }

  /** @public - Force-clears the editor immediately without waiting for reactive prop propagation. */
  export function clearEditor() {
    if (!editorEl) return;
    pendingInternalSync = 0;
    editorHasContent = false;
    value = '';
    lastRenderedValue = '';
    renderPlainTextToMentionEditor(editorEl, '');
    mention.handleEditorInput('', 0);
  }
</script>

<div class="mention-composer relative w-full max-w-full min-w-0 {className}">
  <MentionDropdown
    open={mention.open}
    suggestions={mention.suggestions}
    selectedIdx={mention.selectedIdx}
    onSelect={mention.select}
  />

  {#if !editorHasContent && placeholder}
    <div
      class="mention-composer-placeholder text-text-muted/60 pointer-events-none absolute inset-0 block truncate select-none {editorClass}"
      aria-hidden="true"
    >
      {placeholder}
    </div>
  {/if}

  <div
    bind:this={editorEl}
    contenteditable={disabled ? 'false' : 'true'}
    role="textbox"
    aria-multiline={singleLine ? 'false' : 'true'}
    tabindex={disabled ? -1 : 0}
    data-placeholder={placeholder}
    class="mention-composer-editor chat-composer-editor w-full outline-none {singleLine
      ? 'mention-composer-editor--single'
      : ''} {editorClass}"
    style:min-height={minHeight}
    oninput={handleEditorInput}
    onclick={handleEditorClick}
    onkeydown={handleEditorKeydown}
    onpaste={handleEditorPaste}
    ondragover={handleEditorDragOver}
    ondrop={handleEditorDrop}
    {onfocus}
    {onblur}
    oncompositionstart={() => (isComposing = true)}
    oncompositionend={() => {
      isComposing = false;
      emitEditorChange();
    }}
  ></div>
</div>

<style>
  :global(.mention-composer-placeholder) {
    z-index: 0;
  }

  :global(.mention-composer-editor) {
    position: relative;
    z-index: 1;
    display: block;
    width: 100%;
    max-width: 100%;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: anywhere;
    overflow-x: hidden;
  }

  :global(.mention-composer-editor--single) {
    max-height: 8rem;
    overflow-y: auto;
  }

  :global(
    .mention-composer-editor
      :is(
        .md-composer-muted,
        .md-composer-italic,
        .md-composer-underline,
        .md-composer-bold,
        .md-composer-bold-italic,
        .md-composer-strike,
        .md-composer-code,
        .md-composer-fenced-code,
        .md-composer-h1,
        .md-composer-h2,
        .md-composer-h3,
        .mention-editor-chip
      )
  ) {
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  :global(.mention-editor-chip) {
    display: inline;
    font-weight: 600;
    color: rgb(217 119 6);
    background: rgb(245 158 11 / 0.12);
    border-radius: 9999px;
    padding: 0 0.25rem;
    cursor: pointer;
    user-select: none;
    vertical-align: baseline;
    line-height: inherit;
  }

  :global(:is(.dark) .mention-editor-chip) {
    color: rgb(251 191 36);
    background: rgb(245 158 11 / 0.15);
  }

  :global(.mention-editor-chip:hover) {
    background: rgb(245 158 11 / 0.22);
  }

  :global(.md-composer-muted) {
    color: rgb(120 130 150 / 0.55);
  }

  :global(:is(.dark) .md-composer-muted) {
    color: rgb(180 190 210 / 0.4);
  }

  :global(.md-composer-italic) {
    font-style: italic;
  }

  :global(.md-composer-underline) {
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  :global(.md-composer-bold) {
    font-weight: 700;
  }

  :global(.md-composer-bold-italic) {
    font-style: italic;
    font-weight: 700;
  }

  :global(.md-composer-strike) {
    text-decoration: line-through;
    opacity: 0.85;
  }

  :global(.md-composer-code),
  :global(.md-composer-fenced-code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.92em;
  }

  :global(.md-composer-fenced-code) {
    display: block;
    width: 100%;
    white-space: pre-wrap;
  }

  :global(.md-composer-h1),
  :global(.md-composer-h2),
  :global(.md-composer-h3) {
    display: block;
    width: 100%;
    line-height: 1.3;
    font-weight: 800;
    letter-spacing: -0.02em;
  }

  :global(.md-composer-h1) {
    font-size: 1.45em;
    margin: 0.15em 0 0.05em;
  }

  :global(.md-composer-h2) {
    font-size: 1.25em;
    font-weight: 700;
    margin: 0.1em 0 0.05em;
  }

  :global(.md-composer-h3) {
    font-size: 1.1em;
    font-weight: 700;
    margin: 0.05em 0;
  }
</style>
