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
    class="w-full px-4 py-3 border-2 border-cn-border rounded-2xl text-base text-text-main bg-[var(--cn-surface)] outline-none transition-all placeholder:text-text-muted/50 focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)] disabled:opacity-50 disabled:bg-cn-border/20 resize-y"
    {oninput}
    {...rest}
  ></textarea>
</div>
