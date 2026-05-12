<script lang="ts">
  import { CheckCircle2, ExternalLink, CalendarPlus, Ticket, CreditCard, XCircle, ArrowRight } from 'lucide-svelte';
  import type { EventButton } from '$lib/posts/api';

  interface Props {
    /** Event registration buttons attached to the post, or undefined when the post has none. */
    eventButtons: EventButton[] | undefined;
    /** ID of the authenticated user, used to determine registration status per button. */
    currentUserId: string;
    /** Submission state for buttons that have an associated form, keyed by button ID. */
    btnFormInfos: Record<string, { formId: string; title: string; submitted: boolean }>;
    /** Called when the user clicks a direct-registration button. Receives the button ID. */
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
  <div class="px-5 py-4 space-y-3">
    {#each eventButtons as btn (btn.id)}
      {@const isRegistered = btn.registrants.includes(currentUserId)}
      {@const isFull = Boolean(btn.capacity && btn.registrants.length >= btn.capacity)}
      {@const btnInfo = btnFormInfos[btn.id]}

      <div class="relative overflow-hidden rounded-2xl border border-black/5 dark:border-white/10 bg-white/60 dark:bg-black/20 backdrop-blur-xl shadow-sm p-4 transition-all hover:shadow-md">

        <!-- Rendu si l'inscription passe par un Formulaire externe/interne -->
        {#if btn.formId}
          {#if btnInfo?.submitted}
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div class="flex items-center gap-2.5 text-emerald-600 dark:text-emerald-400 font-bold">
                <div class="p-1.5 rounded-full bg-emerald-500/10">
                  <CheckCircle2 size={18} strokeWidth={2.5} />
                </div>
                <span class="text-[0.95rem]">{btn.label} — Inscription validée</span>
              </div>
              <a
                href="/forms/{btn.formId}?redirect=/posts"
                class="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-bold rounded-xl bg-black/5 dark:bg-white/10 text-text-main hover:bg-black/10 dark:hover:bg-white/20 transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 w-full sm:w-auto"
              >
                Voir ma réponse <ArrowRight size={14} />
              </a>
            </div>
          {:else}
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div class="flex flex-col gap-0.5">
                <span class="font-bold text-[0.95rem] text-text-main flex items-center gap-2">
                  <Ticket size={16} class="text-text-muted" strokeWidth={2.5} />
                  {btn.label}
                </span>
                {#if btn.requiresPayment && !isFull}
                  <span class="text-xs font-bold text-amber-600 dark:text-amber-500 flex items-center gap-1 mt-0.5">
                    <CreditCard size={14} strokeWidth={2.5} /> {formatCurrency(btn.amountCents, btn.currency)}
                  </span>
                {/if}
              </div>

              {#if isFull}
                <div class="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-red-500/10 text-red-600 dark:text-red-400 font-bold text-sm w-full sm:w-auto">
                  <XCircle size={16} strokeWidth={2.5} /> Complet
                </div>
              {:else}
                <a
                  href="/forms/{btn.formId}?redirect=/posts"
                  class="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-amber-500 text-[#151B2C] font-extrabold text-sm hover:bg-amber-400 active:scale-95 transition-all shadow-md shadow-amber-500/20 outline-none focus-visible:ring-4 focus-visible:ring-amber-500/50 w-full sm:w-auto"
                >
                  S'inscrire <ExternalLink size={16} strokeWidth={2.5} />
                </a>
              {/if}
            </div>
          {/if}

        <!-- Rendu si c'est une inscription en un clic (Event direct) -->
        {:else}
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div class="flex flex-col gap-0.5">
              <span class="font-bold text-[0.95rem] text-text-main flex items-center gap-2">
                <CalendarPlus size={16} class="text-text-muted" strokeWidth={2.5} />
                {btn.label}
              </span>
              <div class="flex flex-wrap items-center gap-2 mt-1">
                {#if btn.requiresPayment && !isRegistered}
                  <span class="text-xs font-bold text-amber-600 dark:text-amber-500 flex items-center gap-1 bg-amber-500/10 px-2 py-0.5 rounded-md">
                    <CreditCard size={12} strokeWidth={2.5} /> {formatCurrency(btn.amountCents, btn.currency)}
                  </span>
                {/if}
                {#if btn.capacity && !isRegistered}
                  <span class="text-xs font-bold text-text-muted bg-black/5 dark:bg-white/10 px-2 py-0.5 rounded-md">
                    {btn.registrants.length} / {btn.capacity} places
                  </span>
                {/if}
              </div>
            </div>

            <div class="flex items-center w-full sm:w-auto">
              {#if isRegistered}
                <div class="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-bold text-sm w-full">
                  <CheckCircle2 size={18} strokeWidth={2.5} /> Inscrit
                </div>
              {:else if isFull}
                <div class="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-red-500/10 text-red-600 dark:text-red-400 font-bold text-sm w-full">
                  <XCircle size={16} strokeWidth={2.5} /> Complet
                </div>
              {:else}
                <button
                  type="button"
                  onclick={() => onRegisterEvent(btn.id)}
                  class="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-amber-500 text-[#151B2C] font-extrabold text-sm hover:bg-amber-400 active:scale-95 transition-all shadow-md shadow-amber-500/20 outline-none focus-visible:ring-4 focus-visible:ring-amber-500/50 w-full"
                >
                  Participer
                </button>
              {/if}
            </div>
          </div>
        {/if}

      </div>
    {/each}
  </div>
{/if}
