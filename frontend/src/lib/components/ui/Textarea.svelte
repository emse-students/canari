<script lang="ts">
  interface Props {
    /** HTML id attribute; auto-generated if omitted. */
    id?: string;
    /** Bindable current value of the textarea. */
    value?: string;
    /** Placeholder text shown when the textarea is empty. */
    placeholder?: string;
    /** Label text rendered above the textarea. */
    label?: string;
    /** Whether the textarea is disabled. */
    disabled?: boolean;
    /** Whether the textarea is required; appends a red asterisk to the label. */
    required?: boolean;
    /** Number of visible text rows. */
    rows?: number;
    /** Additional CSS classes forwarded to the wrapper div. */
    class?: string;
    /** Called on every input event. */
    oninput?: (e: Event & { currentTarget: HTMLTextAreaElement }) => void;
    [key: string]: any;
  }

  let {
    id,
    value = $bindable(),
    placeholder = '',
    label,
    disabled = false,
    required = false,
    rows = 4,
    class: className = '',
    oninput,
    ...rest
  }: Props = $props();

  const generatedId = `textarea-${Math.random().toString(36).slice(2)}`;
  const uniqueId = $derived(id || generatedId);
</script>

<div class={className}>
  {#if label}
    <label for={uniqueId} class="block text-sm font-bold text-text-main mb-2 ml-1">
      {label}
      {#if required}<span class="text-red-500">*</span>{/if}
    </label>
  {/if}
  <textarea
    id={uniqueId}
    {placeholder}
    bind:value
    {disabled}
    {required}
    {rows}
    class="ui-textarea"
    {oninput}
    {...rest}
  ></textarea>
</div>
