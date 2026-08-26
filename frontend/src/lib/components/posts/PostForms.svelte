<script lang="ts">
  import {
    CircleCheck,
    ClipboardList,
    ArrowRight,
    ExternalLink,
    Clock,
    Bell,
    BellOff,
  } from '@lucide/svelte';
  import { formatFormOpensAt, formOpensAtIso } from '$lib/posts/postComposerDraft';
  import {
    subscribeFormReminder,
    unsubscribeFormReminder,
    checkFormReminder,
  } from '$lib/posts/api';
  import { onMount } from 'svelte';
  import { m } from '$lib/paraglide/messages';

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
          .then((res) => {
            subscribed[fi.id] = res.subscribed;
          })
          .catch(() => {})
          .finally(() => {
            loaded[fi.id] = true;
          });
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
  <div class="space-y-3 px-5 py-3">
    {#each formInfos as fi (fi.id)}
      <a
        href="/forms/{fi.id}?redirect=/posts"
        class="group relative flex items-center justify-between rounded-2xl border border-black/5 bg-white/60 p-4 shadow-sm backdrop-blur-xl transition-all duration-300 outline-none hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-4 focus-visible:ring-amber-500/50 dark:border-white/10 dark:bg-black/20 {fi.submitted
          ? 'hover:border-emerald-500/30'
          : 'hover:border-amber-500/30'}"
      >
        <div class="flex min-w-0 items-center gap-3.5">
          <!-- Icône d'état -->
          <div
            class="flex-shrink-0 rounded-xl p-2.5 transition-colors {fi.submitted
              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              : 'bg-amber-500/10 text-amber-600 group-hover:bg-amber-500/20 dark:text-amber-400'}"
          >
            {#if fi.submitted}
              <CircleCheck size={20} strokeWidth={2.5} />
            {:else}
              <ClipboardList size={20} strokeWidth={2.5} />
            {/if}
          </div>

          <!-- Informations du Formulaire -->
          <div class="min-w-0 flex-1">
            <h3
              class="text-text-main truncate text-[0.95rem] font-bold transition-colors {fi.submitted
                ? 'group-hover:text-emerald-600 dark:group-hover:text-emerald-400'
                : 'group-hover:text-amber-600 dark:group-hover:text-amber-400'}"
            >
              {fi.title || m.post_form_fallback_title()}
            </h3>
            <p
              class="mt-0.5 text-[0.75rem] font-semibold {fi.submitted
                ? 'text-emerald-600/80 dark:text-emerald-400/80'
                : 'text-text-muted'}"
            >
              {#if fi.submitted}
                {m.post_form_response_sent()}
              {:else if fi.opensAt && formOpensAtIso(fi.opensAt)}
                <span class="inline-flex items-center gap-1">
                  <Clock size={12} strokeWidth={2.5} />
                  {m.post_form_opens_on_label({ date: formatFormOpensAt(fi.opensAt) })}
                </span>
              {:else}
                {m.post_form_fill_label()}
              {/if}
            </p>
          </div>
        </div>

        <!-- Flèche / Icône d'action externe -->
        <div
          class="ml-4 flex-shrink-0 opacity-40 transition-all duration-300 group-hover:translate-x-1 group-hover:opacity-100 {fi.submitted
            ? 'group-hover:text-emerald-500'
            : 'group-hover:text-amber-500'}"
        >
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
          class="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition-colors {subscribed[
            fi.id
          ]
            ? 'bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 dark:text-amber-400'
            : 'text-text-muted hover:text-text hover:bg-cn-surface'}"
          title={subscribed[fi.id]
            ? m.post_form_disable_reminder_label()
            : m.post_form_notify_when_available_label()}
        >
          {#if subscribed[fi.id]}
            <BellOff size={13} strokeWidth={2} />
            {m.post_form_reminder_enabled_label()}
          {:else}
            <Bell size={13} strokeWidth={2} />
            {m.post_form_notify_me_label()}
          {/if}
        </button>
      {/if}
    {/each}
  </div>
{/if}
