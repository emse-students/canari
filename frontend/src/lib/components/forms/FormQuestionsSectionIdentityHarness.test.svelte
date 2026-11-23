<script lang="ts">
  /** Test-only parent: derives the transmitted fields from live ticks, as the two pages do. */
  import { untrack } from 'svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import FormQuestionsSection from './FormQuestionsSection.svelte';
  import { transmittedFieldsOf } from '$lib/forms/identityDuplicate';

  interface Props {
    initial: any[];
    anonymous?: boolean;
  }
  let { initial, anonymous = false }: Props = $props();
  let items = $state(untrack(() => initial));
  let choices = $state<string[]>(['lastName', 'firstName']);
</script>

<Button aria-label="untick-last-name" onclick={() => (choices = ['firstName'])}>untick</Button>
<FormQuestionsSection
  bind:items
  requiresPayment={false}
  transmittedFields={transmittedFieldsOf(choices, { isPublic: false, anonymous })}
/>
