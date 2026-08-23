<script lang="ts">
  import { CONTROL_LABEL_CLASS, controlClass } from './controlClasses';

  interface Props {
    /** HTML id attribute; auto-generated if omitted. */
    id?: string;
    /** Input type (e.g. "text", "email", "password"). */
    type?: string;
    /** Bindable current value of the input. */
    value?: string | number;
    /** Placeholder text shown when the input is empty. */
    placeholder?: string;
    /** Label text rendered above the input. */
    label?: string;
    /** Whether the input is disabled. */
    disabled?: boolean;
    /** Whether the input is required; appends a red asterisk to the label. */
    required?: boolean;
    /** Additional CSS classes forwarded to the wrapper div. */
    class?: string;
    /** Error message displayed below the input; also sets aria-invalid. */
    error?: string;
    /** Marks the input as invalid without an error message. */
    invalid?: boolean;
    /** Called on every input event. */
    oninput?: (e: Event & { currentTarget: HTMLInputElement }) => void;
    /** Called on every keydown event. */
    onkeydown?: (e: KeyboardEvent) => void;
    [key: string]: any;
  }

  let {
    id,
    type = 'text',
    value = $bindable(),
    placeholder = '',
    label,
    disabled = false,
    required = false,
    error,
    invalid = false,
    class: className = '',
    oninput,
    onkeydown,
    ...rest
  }: Props = $props();

  const isInvalid = $derived(invalid || !!error);

  const generatedId = `input-${Math.random().toString(36).slice(2)}`;
  const uniqueId = $derived(id || generatedId);
</script>

<div class={className}>
  {#if label}
    <label for={uniqueId} class={CONTROL_LABEL_CLASS}>
      {label}
      {#if required}<span class="text-red-500">*</span>{/if}
    </label>
  {/if}
  <input
    id={uniqueId}
    {type}
    {placeholder}
    bind:value
    {disabled}
    {required}
    aria-invalid={isInvalid || undefined}
    aria-errormessage={error ? `${uniqueId}-error` : undefined}
    class={controlClass(isInvalid)}
    {oninput}
    {onkeydown}
    {...rest}
  />
  {#if error}
    <p id="{uniqueId}-error" role="alert" class="text-red-err mt-1.5 ml-1 text-xs font-medium">
      {error}
    </p>
  {/if}
</div>
