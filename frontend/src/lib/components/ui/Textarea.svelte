<script lang="ts">
  interface Props {
    id?: string;
    value?: string;
    placeholder?: string;
    label?: string;
    disabled?: boolean;
    required?: boolean;
    rows?: number;
    class?: string;
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
