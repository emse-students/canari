<script lang="ts">
  import { Check, ExternalLink } from 'lucide-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import type { EventButton } from '$lib/posts/api';

  interface Props {
    eventButtons: EventButton[] | undefined;
    currentUserId: string;
    btnFormInfos: Record<string, { formId: string; title: string; submitted: boolean }>;
    onRegisterEvent: (buttonId: string) => void;
  }

  let { eventButtons, currentUserId, btnFormInfos, onRegisterEvent }: Props = $props();

  function formatCurrency(amountCents: number | undefined, currency = 'eur') {
    if (amountCents === undefined) return '';
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amountCents / 100);
  }
</script>

{#if eventButtons && eventButtons.length > 0}
  <div class="px-5 py-4 space-y-3 border-b border-cn-border/40">
    {#each eventButtons as btn (btn.id)}
      {@const isRegistered = btn.registrants.includes(currentUserId)}
      {@const isFull = Boolean(btn.capacity && btn.registrants.length >= btn.capacity)}
      {@const btnInfo = btnFormInfos[btn.id]}

      <div class="flex flex-col gap-2">
        {#if btn.formId}
          {#if btnInfo?.submitted}
            <div class="flex items-center gap-2 text-green-ok font-semibold text-sm">
              <Check size={16} />
              <span>{btn.label} — Inscrit</span>
              <a
                href="/forms/{btn.formId}?redirect=/posts"
                class="ml-2 text-xs text-text-muted underline hover:text-cn-dark transition-colors"
              >
                Voir ma réponse
              </a>
            </div>
          {:else}
            <a
              href={isFull ? undefined : `/forms/${btn.formId}?redirect=/posts`}
              class="inline-flex items-center gap-2 rounded-xl border border-cn-border bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover transition-all {isFull
                ? 'opacity-60 pointer-events-none'
                : ''}"
            >
              {isFull ? 'Complet' : btn.label}
              {#if btn.requiresPayment && !isFull}
                <span class="opacity-80">({formatCurrency(btn.amountCents, btn.currency)})</span>
              {/if}
              <ExternalLink size={14} class="opacity-60" />
            </a>
          {/if}
        {:else}
          <div class="flex flex-col items-start gap-2">
            <Button
              variant={isRegistered ? 'ghost' : 'primary'}
              disabled={isRegistered || (isFull && !isRegistered)}
              onclick={() => onRegisterEvent(btn.id)}
              class="w-full sm:w-auto !text-sm !py-2"
            >
              {#if isRegistered}
                <Check size={14} class="mr-1" /> Inscrit
              {:else}
                {btn.label}
              {/if}
              {#if btn.requiresPayment && !isRegistered}
                <span class="ml-1 opacity-80"
                  >({formatCurrency(btn.amountCents, btn.currency)})</span
                >
              {/if}
            </Button>
            {#if isFull && !isRegistered}
              <span class="text-xs text-red-err font-bold">Complet</span>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}
