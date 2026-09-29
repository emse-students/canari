<script lang="ts">
  import { CONTROL_HINT_CLASS, CONTROL_LABEL_CLASS } from './controlClasses';
  import Picker from './Picker.svelte';
  import type { PickerOption } from './picker';

  /**
   * A labelled choice that looks exactly like `Input.svelte`, because it shares its class string
   * rather than a copy of it.
   *
   * Options are `{ value, label }`: the VALUE is what goes on the wire and the LABEL is what a
   * person reads. Keeping them separate is what lets a screen offer "Avec alcool" while sending an
   * opaque key, instead of showing the key.
   *
   * It draws the app's own `Picker`, no longer a native `<select>`: on Android a select opens the
   * SYSTEM's dialog, which the user asked the app never to leave for (2026-09-29).
   */
  interface Props {
    /** HTML id; auto-generated when omitted, so the label always points somewhere. */
    id?: string;
    /** Label above the control. */
    label?: string;
    /** Hint below the control. */
    hint?: string;
    /** Currently selected value. */
    value: string;
    /** Selectable options, in display order. */
    options: PickerOption[];
    /** Whether the control is disabled. */
    disabled?: boolean;
    /** Appends a red asterisk to the label. */
    required?: boolean;
    /** Classes forwarded to the wrapper. */
    class?: string;
    /** Called with the new value on every change. */
    onValueChange: (value: string) => void;
  }

  let {
    id,
    label,
    hint,
    value,
    options,
    disabled = false,
    required = false,
    class: className = '',
    onValueChange,
  }: Props = $props();

  const generatedId = `select-${Math.random().toString(36).slice(2)}`;
  const uniqueId = $derived(id || generatedId);
</script>

<div class={className}>
  {#if label}
    <label for={uniqueId} class={CONTROL_LABEL_CLASS}>
      {label}
      {#if required}<span class="text-red-500">*</span>{/if}
    </label>
  {/if}
  <Picker
    id={uniqueId}
    {value}
    {options}
    {disabled}
    {onValueChange}
    label={label ?? ''}
    variant="field"
    density="default"
  />
  {#if hint}
    <p class={CONTROL_HINT_CLASS}>{hint}</p>
  {/if}
</div>
