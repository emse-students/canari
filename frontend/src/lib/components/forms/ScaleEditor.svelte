<script lang="ts">
  import Input from '$lib/components/ui/Input.svelte';
  import Picker from '$lib/components/ui/Picker.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';
  import { m } from '$lib/paraglide/messages';

  /**
   * A LINEAR SCALE'S BOUNDS AND END LABELS - drawn by the question card AND by the add wizard's
   * second step (owner, 2026-11-07), so a scale is set up the same way in both.
   */
  interface Props {
    /** The question, mutated in place: its `scale` is what this edits (`newQuestion` sets one). */
    item: { scale: { min: number; max: number; minLabel?: string; maxLabel?: string } };
  }

  let { item }: Props = $props();

  const scale = $derived(item.scale);

  /** A linear scale starts at 0 or 1. */
  const SCALE_MIN_OPTIONS: PickerOption[] = [0, 1].map((v) => ({
    value: String(v),
    label: String(v),
  }));
  /** ...and ends anywhere from 2 to 10. */
  const SCALE_MAX_OPTIONS: PickerOption[] = Array.from({ length: 9 }, (_, i) => i + 2).map((v) => ({
    value: String(v),
    label: String(v),
  }));

  /** The two scale pickers wear the question's own field box, sized to their content. */
  const scaleTriggerClass =
    'w-auto min-w-[4rem] px-3 py-2.5 sm:px-4 sm:py-3 border-2 border-cn-border sm:border-black/10 dark:sm:border-white/10 rounded-xl sm:rounded-2xl text-sm sm:text-base text-text-main bg-(--cn-surface) outline-none transition-all focus:border-cn-yellow flex items-center justify-between gap-2 text-left';
</script>

<div
  class="space-y-4 rounded-xl border border-black/5 bg-white/30 p-3 sm:space-y-5 sm:rounded-2xl sm:p-5 dark:border-white/10 dark:bg-black/20"
  data-testid="scale-editor"
>
  <div class="flex flex-wrap items-center gap-2 sm:gap-4">
    <span class="text-text-main w-full text-sm font-bold sm:w-auto"
      >{m.form_builder_scale_prefix()}</span
    >
    <Picker
      label={m.form_builder_scale_min_picker()}
      value={String(scale.min)}
      options={SCALE_MIN_OPTIONS}
      onValueChange={(v) => (scale.min = Number(v))}
      triggerClass={scaleTriggerClass}
    />
    <span class="text-text-muted text-xs font-bold uppercase">{m.form_builder_scale_to()}</span>
    <Picker
      label={m.form_builder_scale_max_picker()}
      value={String(scale.max)}
      options={SCALE_MAX_OPTIONS}
      onValueChange={(v) => (scale.max = Number(v))}
      triggerClass={scaleTriggerClass}
    />
  </div>
  <div class="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2 sm:gap-5 sm:pt-2">
    <Input
      label={m.form_builder_scale_min_label({ min: scale.min })}
      bind:value={scale.minLabel}
      placeholder={m.form_builder_scale_min_placeholder()}
      class="[&_input]:px-3 [&_input]:py-2.5 [&_input]:text-sm [&_label]:ml-0"
    />
    <Input
      label={m.form_builder_scale_max_label({ max: scale.max })}
      bind:value={scale.maxLabel}
      placeholder={m.form_builder_scale_max_placeholder()}
      class="[&_input]:px-3 [&_input]:py-2.5 [&_input]:text-sm [&_label]:ml-0"
    />
  </div>
</div>
