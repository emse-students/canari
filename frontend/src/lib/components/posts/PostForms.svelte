<script lang="ts">
  import { Check, ClipboardList, ExternalLink } from 'lucide-svelte';

  interface Props {
    formInfos: Array<{ id: string; title: string; submitted: boolean }>;
  }

  let { formInfos }: Props = $props();
</script>

{#if formInfos.length > 0}
  <div class="px-5 py-4 border-b border-cn-border/40 space-y-2">
    {#each formInfos as fi (fi.id)}
      <a
        href="/forms/{fi.id}?redirect=/posts"
        class="flex items-center justify-between p-3 rounded-xl border border-cn-border bg-[var(--cn-surface)] hover:border-cn-yellow/50 transition-all group"
      >
        <div class="flex items-center gap-3">
          <div
            class="p-2 rounded-lg {fi.submitted
              ? 'bg-green-ok/10 text-green-ok'
              : 'bg-cn-yellow/15 text-cn-dark'}"
          >
            {#if fi.submitted}
              <Check size={18} />
            {:else}
              <ClipboardList size={18} />
            {/if}
          </div>
          <div>
            <h3 class="font-bold text-sm text-text-main">{fi.title}</h3>
            <p class="text-xs text-text-muted">
              {fi.submitted ? 'Réponse envoyée' : 'Remplir le formulaire'}
            </p>
          </div>
        </div>
        <ExternalLink
          size={14}
          class="text-text-muted group-hover:text-cn-dark transition-colors"
        />
      </a>
    {/each}
  </div>
{/if}
