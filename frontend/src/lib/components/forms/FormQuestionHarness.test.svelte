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
  }

  let { item, initial, onChange, optionModifier, optionClosed }: Props = $props();

  // A deep `$state`, as `selections` is on the page, so a matrix row write is seen here. The props
  // are a SEED read once, which `untrack` says out loud.
  let selections = $state<Record<string, any>>(
    untrack(() => ({ [item.id]: structuredClone(initial) }))
  );

  $effect(() => {
    onChange($state.snapshot(selections[item.id]));
  });
</script>

<FormQuestion
  {item}
  index={0}
  bind:value={selections[item.id]}
  disabled={false}
  formId="f1"
  {optionModifier}
  {optionClosed}
/>
