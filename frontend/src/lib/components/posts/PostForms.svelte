<script lang="ts">
  import FormCard from './FormCard.svelte';

  interface Props {
    /** Forms attached to the post, each with its submission status for the current user. */
    formInfos: Array<{ id: string; title: string; submitted: boolean; opensAt?: string | null }>;
  }

  let { formInfos }: Props = $props();
</script>

{#if formInfos.length > 0}
  <div class="space-y-3 px-5 py-3">
    {#each formInfos as fi (fi.id)}
      <FormCard
        formId={fi.id}
        href="/forms/{fi.id}?redirect=/posts"
        title={fi.title}
        submitted={fi.submitted}
        opensAt={fi.opensAt}
      />
    {/each}
  </div>
{/if}
