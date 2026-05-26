<script lang="ts">
  import { CheckCircle2, ClipboardList, ArrowRight, ExternalLink, Clock, Bell, BellOff } from '@lucide/svelte';
  import { formatFormOpensAt, formOpensAtIso } from '$lib/posts/postComposerDraft';
  import { subscribeFormReminder, unsubscribeFormReminder, checkFormReminder } from '$lib/posts/api';
  import { onMount } from 'svelte';

  interface Props {
    /** Forms attached to the post, each with its submission status for the current user. */
    formInfos: Array<{ id: string; title: string; submitted: boolean; opensAt?: string | null }>;
  }

  let { formInfos }: Props = $props();

  let subscribed = $state<Record<string, boolean>>({});
  let toggling = $state<Record<string, boolean>>({});
  let loaded = $state<Record<string, boolean>>({});

  onMount(() => {
    for (const fi of formInfos) {
      if (!fi.submitted && formOpensAtIso(fi.opensAt)) {
        checkFormReminder(fi.id)
          .then((res) => { subscribed[fi.id] = res.subscribed; })
          .catch(() => {})
          .finally(() => { loaded[fi.id] = true; });
      }
    }
  });

  async function toggleReminder(formId: string) {
    if (toggling[formId]) return;
    toggling[formId] = true;
    try {
      if (subscribed[formId]) {
        await unsubscribeFormReminder(formId);
        subscribed[formId] = false;
      } else {
        await subscribeFormReminder(formId);
        subscribed[formId] = true;
      }
    } catch {
      // silent
    } finally {
      toggling[formId] = false;
    }
  }
</script>

{#if formInfos.length > 0}
  <div class="px-5 py-3 space-y-3">
    {#each formInfos as fi (fi.id)}
      <a
        href="/forms/{fi.id}?redirect=/posts"
        class="relative flex items-center justify-between p-4 rounded-2xl border border-black/5 dark:border-white/10 bg-white/60 dark:bg-black/20 backdrop-blur-xl shadow-sm hover:shadow-md transition-all duration-300 hover:-translate-y-0.5 group outline-none focus-visible:ring-4 focus-visible:ring-amber-500/50 {fi.submitted ? 'hover:border-emerald-500/30' : 'hover:border-amber-500/30'}"
      >
        <div class="flex items-center gap-3.5 min-w-0">
          <!-- Icône d'état -->
          <div
            class="p-2.5 rounded-xl flex-shrink-0 transition-colors {fi.submitted
              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : 'bg-amber-500/10 text-amber-600 dark:text-amber-400 group-hover:bg-amber-500/20'}"
          >
            {#if fi.submitted}
              <CheckCircle2 size={20} strokeWidth={2.5} />
            {:else}
              <ClipboardList size={20} strokeWidth={2.5} />
            {/if}
          </div>

          <!-- Informations du Formulaire -->
          <div class="flex-1 min-w-0">
            <h3 class="font-bold text-[0.95rem] text-text-main truncate transition-colors {fi.submitted ? 'group-hover:text-emerald-600 dark:group-hover:text-emerald-400' : 'group-hover:text-amber-600 dark:group-hover:text-amber-400'}">
              {fi.title || 'Formulaire'}
            </h3>
            <p class="text-[0.75rem] font-semibold mt-0.5 {fi.submitted ? 'text-emerald-600/80 dark:text-emerald-400/80' : 'text-text-muted'}">
              {#if fi.submitted}
                Réponse envoyée
              {:else if fi.opensAt && formOpensAtIso(fi.opensAt)}
                <span class="inline-flex items-center gap-1">
                  <Clock size={12} strokeWidth={2.5} />
                  Ouvre le {formatFormOpensAt(fi.opensAt)}
                </span>
              {:else}
                Remplir le formulaire
              {/if}
            </p>
          </div>
        </div>

        <!-- Flèche / Icône d'action externe -->
        <div class="flex-shrink-0 ml-4 opacity-40 group-hover:opacity-100 transition-all duration-300 group-hover:translate-x-1 {fi.submitted ? 'group-hover:text-emerald-500' : 'group-hover:text-amber-500'}">
          {#if fi.submitted}
            <ArrowRight size={18} strokeWidth={2.5} />
          {:else}
            <ExternalLink size={18} strokeWidth={2.5} />
          {/if}
        </div>
      </a>

      {#if !fi.submitted && formOpensAtIso(fi.opensAt) && loaded[fi.id]}
        <button
          type="button"
          onclick={() => toggleReminder(fi.id)}
          disabled={toggling[fi.id]}
          class="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-xl transition-colors {subscribed[fi.id] ? 'text-amber-600 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/20' : 'text-text-muted hover:text-text hover:bg-cn-surface'}"
          title={subscribed[fi.id] ? 'Désactiver le rappel' : 'Me prévenir quand disponible'}
        >
          {#if subscribed[fi.id]}
            <BellOff size={13} strokeWidth={2} />
            Rappel activé
          {:else}
            <Bell size={13} strokeWidth={2} />
            Me prévenir
          {/if}
        </button>
      {/if}
    {/each}
  </div>
{/if}
