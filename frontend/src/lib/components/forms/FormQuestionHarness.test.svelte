<script lang="ts">
  /** Test-only parent: owns the bound answer the way the fill page does, and reports each change. */
  import { untrack } from 'svelte';
  import type { FormItem, FormOption } from '$lib/forms/api';
  import FormQuestion from './FormQuestion.svelte';

  interface Props {
    item: FormItem;
    initial: unknown;
    onChange: (value: unknown) => void;
    optionModifier?: (item: FormItem, opt: FormOption) => number;
    optionClosed?: (opt: FormOption) => boolean;
    onUploadingChange?: (uploading: boolean) => void;
    /** Told the text typed beside Autre and the free comment, as the page holds them. */
    onNotes?: (notes: { other: unknown; comment: unknown }) => void;
  }

  let { item, initial, onChange, optionModifier, optionClosed, onUploadingChange, onNotes }: Props =
    $props();

  // A deep `$state`, as `selections` is on the page, so a matrix row write is seen here. The props
  // are a SEED read once, which `untrack` says out loud.
  let selections = $state<Record<string, any>>(
    untrack(() => ({ [item.id]: structuredClone(initial) }))
  );

  $effect(() => {
    onChange($state.snapshot(selections[item.id]));
  });
  $effect(() => {
    onNotes?.({ other: selections['other'], comment: selections['comment'] });
  });
</script>

<FormQuestion
  {item}
  index={0}
  bind:value={selections[item.id]}
  bind:other={selections['other']}
  bind:comment={selections['comment']}
  disabled={false}
  formId="f1"
  {optionModifier}
  {optionClosed}
  {onUploadingChange}
/>
