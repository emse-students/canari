<script lang="ts">
  import { goto } from '$app/navigation';
  import MentionDropdown from './MentionDropdown.svelte';
  import { useMentionAutocomplete } from '$lib/composables/useMentionAutocomplete.svelte';
  import {
    getMentionChipFromEventTarget,
    getPlainTextSelection,
    composerMarkdownPreviewEnabled,
    needsMentionChipRender,
    removeMentionChipBeforeCursor,
    renderPlainTextToMentionEditor,
    serializeMentionEditor,
    setPlainTextSelection,
    shouldRerenderComposerDom,
  } from '$lib/utils/mentions/mentionEditor';

  interface Props {
    value?: string;
    placeholder?: string;
    disabled?: boolean;
    singleLine?: boolean;
    /** Discord-style live markdown (* / _ italic_, __underline__, **bold**, escapes, muted delimiters). */
    markdownPreview?: boolean;
    maxlength?: number;
    minHeight?: string;
    class?: string;
    editorClass?: string;
    onchange?: (text: string) => void;
    onkeydown?: (e: KeyboardEvent) => void;
    onpaste?: (e: ClipboardEvent) => void;
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
    onchange,
    onkeydown,
    onpaste,
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

  const mention = useMentionAutocomplete({
    getText: () => value,
    setText: (text, moveCursorTo) => syncFromPlainText(text, moveCursorTo),
    getCursor: () => (editorEl ? getPlainTextSelection(editorEl).start : 0),
    setCursor: (pos) => {
      if (editorEl) setPlainTextSelection(editorEl, pos, pos);
    },
    focus: () => editorEl?.focus(),
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
  });

  function handleEditorInput() {
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

  /** @public — Force-clears the editor immediately without waiting for reactive prop propagation. */
  export function clearEditor() {
    if (!editorEl) return;
    pendingInternalSync = 0;
    value = '';
    lastRenderedValue = '';
    renderPlainTextToMentionEditor(editorEl, '');
    mention.handleEditorInput('', 0);
  }
</script>

<div class="mention-composer relative min-w-0 max-w-full w-full {className}">
  <MentionDropdown
    open={mention.open}
    suggestions={mention.suggestions}
    selectedIdx={mention.selectedIdx}
    onSelect={mention.select}
  />

  {#if !value && placeholder}
    <div
      class="mention-composer-placeholder pointer-events-none absolute inset-0 block whitespace-pre-wrap text-text-muted/60 select-none {editorClass}"
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
    class="mention-composer-editor chat-composer-editor chat-scrollbar w-full outline-none {singleLine
      ? 'mention-composer-editor--single'
      : ''} {editorClass}"
    style:min-height={minHeight}
    oninput={handleEditorInput}
    onclick={handleEditorClick}
    onkeydown={handleEditorKeydown}
    {onpaste}
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

  :global(.mention-composer-editor :is(.md-composer-muted, .md-composer-italic, .md-composer-underline, .md-composer-bold, .md-composer-bold-italic, .md-composer-strike, .md-composer-code, .mention-editor-chip)) {
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

  :global(.md-composer-code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.92em;
    background: rgb(0 0 0 / 0.06);
    border-radius: 0.25rem;
    padding: 0 0.15rem;
  }

  :global(:is(.dark) .md-composer-code) {
    background: rgb(255 255 255 / 0.08);
  }
</style>
