<script lang="ts">
  import Picker from '$lib/components/ui/Picker.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * THE FORMAT OF A SHORT TEXT QUESTION (owner, 2026-11-21, G-VALID): free text, a number, a phone
   * number or an e-mail. A number takes an optional minimum and maximum and, off by default, decimals.
   * The save and the fill page both judge with the one shared rule (`answerFormat.ts`), so what is
   * set here is what is enforced. Drawn under a short text question only.
   */
  interface Props {
    /** The question, mutated in place (a `$state` proxy held by the card). */
    item: {
      id?: string;
      format?: string;
      min?: number | string | null;
      max?: number | string | null;
      allowDecimals?: boolean;
    };
  }

  let { item }: Props = $props();

  const options = $derived<PickerOption[]>([
    { value: 'text', label: m.form_format_text() },
    { value: 'number', label: m.form_format_number() },
    { value: 'phone', label: m.form_format_phone() },
    { value: 'email', label: m.form_format_email() },
  ]);

  function setFormat(format: string) {
    item.format = format === 'text' ? undefined : format;
    Log.d('ShortTextFormatEditor', `question ${item.id}: format ${format}`);
  }
</script>

<div class="space-y-3" data-testid="short-text-format-editor">
  <div class="flex flex-wrap items-center gap-2">
    <span class="text-text-muted text-xs font-bold">{m.form_builder_format_label()}</span>
    <Picker
      label={m.form_builder_format_label()}
      variant="field"
      value={item.format ?? 'text'}
      {options}
      onValueChange={setFormat}
    />
  </div>
  {#if item.format === 'number'}
    <div class="grid grid-cols-2 gap-3">
      <Input
        type="number"
        label={m.form_builder_format_min()}
        bind:value={item.min as number | string | undefined}
        data-testid="format-min"
      />
      <Input
        type="number"
        label={m.form_builder_format_max()}
        bind:value={item.max as number | string | undefined}
        data-testid="format-max"
      />
    </div>
    <Toggle
      label={m.form_builder_format_decimals()}
      bind:checked={
        () => item.allowDecimals === true,
        (on) => {
          item.allowDecimals = on;
        }
      }
    />
  {/if}
</div>
