<script lang="ts">
  /** Test-only parent: owns the bound question the way the builder list does, and reports each change. */
  import { untrack } from 'svelte';
  import FormBuilder from './FormBuilder.svelte';

  interface Props {
    initial: Record<string, unknown>;
    onChange: (item: Record<string, unknown>) => void;
    imageUploadFn?: (file: File) => Promise<string>;
  }

  let { initial, onChange, imageUploadFn }: Props = $props();

  let item = $state<Record<string, any>>(untrack(() => structuredClone(initial)));

  $effect(() => {
    onChange($state.snapshot(item));
  });
</script>

<FormBuilder bind:item onRemove={() => {}} {imageUploadFn} />
