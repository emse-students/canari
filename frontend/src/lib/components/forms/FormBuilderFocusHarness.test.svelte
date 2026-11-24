<script lang="ts">
  /** Test-only parent: owns `expanded` like the builder list, and lets a test flip it. */
  import FormBuilder from './FormBuilder.svelte';

  let { selectTitleOnOpen = false }: { selectTitleOnOpen?: boolean } = $props();
  let item = $state<Record<string, any>>({
    id: 'q',
    label: 'Ton plat',
    type: 'short_text',
    required: false,
    options: [],
  });
  let expanded = $state(false);

  export function setExpanded(next: boolean) {
    expanded = next;
  }
</script>

<FormBuilder
  bind:item
  onRemove={() => {}}
  {expanded}
  {selectTitleOnOpen}
  onExpand={() => (expanded = true)}
  onCollapse={() => (expanded = false)}
/>
