<script lang="ts">
  import MentionComposerInput from '$lib/components/shared/MentionComposerInput.svelte';
  import MarkdownComposerToolbar from '$lib/components/shared/MarkdownComposerToolbar.svelte';
  import { applyComposerMarkdownFormat } from '$lib/utils/markdown/composerMarkdownFormat';

  interface Props {
    value?: string;
    placeholder?: string;
    disabled?: boolean;
    singleLine?: boolean;
    maxlength?: number;
    minHeight?: string;
    /** Wrapper around toolbar + editor. */
    class?: string;
    toolbarClass?: string;
    editorClass?: string;
    showToolbar?: boolean;
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
    maxlength,
    minHeight = '120px',
    class: className = 'w-full min-w-0',
    toolbarClass = '',
    editorClass = '',
    showToolbar = true,
    onchange,
    onkeydown,
    onpaste,
    onfocus,
    onblur,
  }: Props = $props();

  let composerEl = $state<MentionComposerInput | null>(null);

  async function handleFormat(type: string) {
    await applyComposerMarkdownFormat(
      type,
      () => value,
      (text) => {
        value = text;
        onchange?.(text);
      },
      composerEl
    );
  }
</script>

<div class="flex flex-col min-w-0 {className}">
  {#if showToolbar}
    <MarkdownComposerToolbar onFormat={handleFormat} class={toolbarClass} />
  {/if}
  <MentionComposerInput
    bind:this={composerEl}
    bind:value
    markdownPreview
    {placeholder}
    {disabled}
    {singleLine}
    {maxlength}
    {minHeight}
    class="w-full min-w-0"
    {editorClass}
    {onchange}
    {onkeydown}
    {onpaste}
    {onfocus}
    {onblur}
  />
</div>
