<script lang="ts">
  import { goto } from '$app/navigation';
  import MentionDropdown from './MentionDropdown.svelte';
  import { useMentionAutocomplete } from '$lib/composables/useMentionAutocomplete.svelte';
  import {
    getMentionChipFromEventTarget,
    getPlainTextSelection,
    needsMentionChipRender,
    removeMentionChipBeforeCursor,
    renderPlainTextToMentionEditor,
    serializeMentionEditor,
    setPlainTextSelection,
  } from '$lib/utils/mentions/mentionEditor';

  interface Props {
    value?: string;
    placeholder?: string;
    disabled?: boolean;
    singleLine?: boolean;
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

  function syncFromPlainText(text: string, moveCursorTo?: number) {
    pendingInternalSync++;
    value = text;
    lastRenderedValue = text;
    onchange?.(text);
    if (editorEl) {
      renderPlainTextToMentionEditor(editorEl, text);
      if (moveCursorTo !== undefined) {
        setPlainTextSelection(editorEl, moveCursorTo, moveCursorTo);
      }
    }
  }

  function emitEditorChange() {
    if (!editorEl || isComposing) return;
    let text = serializeMentionEditor(editorEl);
    let { start } = getPlainTextSelection(editorEl);

    if (needsMentionChipRender(editorEl, text)) {
      pendingInternalSync++;
      renderPlainTextToMentionEditor(editorEl, text);
      lastRenderedValue = text;
      setPlainTextSelection(editorEl, start, start);
    }

    if (text !== value) {
      pendingInternalSync++;
      value = text;
      lastRenderedValue = text;
      onchange?.(text);
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

    renderPlainTextToMentionEditor(editorEl, value);
    lastRenderedValue = value;
  });

  function handleEditorInput() {
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
</script>

<div class="mention-composer relative {className}">
  <MentionDropdown
    open={mention.open}
    suggestions={mention.suggestions}
    selectedIdx={mention.selectedIdx}
    onSelect={mention.select}
  />

  {#if !value && placeholder}
    <div
      class="mention-composer-placeholder pointer-events-none absolute inset-0 px-[inherit] py-[inherit] text-text-muted/60 select-none"
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
  :global(.mention-composer-editor) {
    position: relative;
    z-index: 1;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: anywhere;
  }

  :global(.mention-composer-editor--single) {
    white-space: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
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
</style>
