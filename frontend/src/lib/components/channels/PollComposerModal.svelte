<script lang="ts">
  import { X, Plus, Trash2, ChartColumn } from '@lucide/svelte';
  import { fade, fly } from 'svelte/transition';
  import type { ChannelPollDraft } from '$lib/utils/chat/channelCrypto';

  /**
   * Modal that lets a member compose a community poll (question, 2+ options,
   * single/multiple choice, optional deadline). Emits a {@link ChannelPollDraft}
   * with freshly generated opaque option ids; the actual encryption/send is the
   * caller's responsibility.
   */
  interface Props {
    open: boolean;
    onClose: () => void;
    onCreate: (draft: ChannelPollDraft) => void | Promise<void>;
  }

  let { open, onClose, onCreate }: Props = $props();

  interface DraftOption {
    id: string;
    label: string;
  }

  let question = $state('');
  let options = $state<DraftOption[]>([
    { id: crypto.randomUUID(), label: '' },
    { id: crypto.randomUUID(), label: '' },
  ]);
  let multipleChoice = $state(false);
  let deadline = $state(''); // datetime-local value, '' = no deadline
  let submitting = $state(false);
  let error = $state('');

  const filledOptions = $derived(options.filter((o) => o.label.trim().length > 0));
  const canSubmit = $derived(question.trim().length > 0 && filledOptions.length >= 2);

  function addOption() {
    if (options.length >= 10) return;
    options = [...options, { id: crypto.randomUUID(), label: '' }];
  }

  function removeOption(id: string) {
    if (options.length <= 2) return;
    options = options.filter((o) => o.id !== id);
  }

  /** Resets the form to its initial empty state (after a successful send or close). */
  function reset() {
    question = '';
    options = [
      { id: crypto.randomUUID(), label: '' },
      { id: crypto.randomUUID(), label: '' },
    ];
    multipleChoice = false;
    deadline = '';
    error = '';
  }

  function close() {
    reset();
    onClose();
  }

  async function submit() {
    if (!canSubmit || submitting) return;
    const ts = deadline ? new Date(deadline).getTime() : 0;
    if (deadline && (Number.isNaN(ts) || ts <= Date.now())) {
      error = 'La date de fin doit être dans le futur.';
      return;
    }
    submitting = true;
    error = '';
    try {
      await onCreate({
        question: question.trim(),
        options: filledOptions.map((o) => ({ id: o.id, label: o.label.trim() })),
        multipleChoice,
        endsAt: deadline ? new Date(deadline).toISOString() : null,
      });
      reset();
      onClose();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Échec de la création du sondage.';
    } finally {
      submitting = false;
    }
  }
</script>

{#if open}
  <div class="pointer-events-auto fixed inset-0 z-[130] flex items-end justify-center sm:items-center">
    <button
      type="button"
      class="absolute inset-0 bg-black/45 backdrop-blur-sm"
      aria-label="Fermer"
      onclick={close}
      transition:fade={{ duration: 150 }}
    ></button>
    <div
      class="relative flex max-h-[85vh] w-full flex-col rounded-t-2xl bg-[var(--cn-surface)] shadow-2xl sm:max-w-lg sm:rounded-2xl"
      transition:fly={{ y: 30, duration: 200 }}
    >
      <div class="flex items-center gap-2 border-b border-cn-border p-4">
        <ChartColumn size={18} strokeWidth={2.5} class="text-cn-yellow shrink-0" />
        <h2 class="flex-1 text-base font-extrabold text-text-main">Nouveau sondage</h2>
        <button
          type="button"
          onclick={close}
          class="rounded-xl p-2 text-text-muted hover:bg-black/5 dark:hover:bg-white/10"
          aria-label="Fermer"
        >
          <X size={18} />
        </button>
      </div>

      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div>
          <label for="poll-question" class="mb-1.5 block text-sm font-semibold text-text-main">
            Question
          </label>
          <input
            id="poll-question"
            bind:value={question}
            maxlength="300"
            placeholder="Quelle est votre question ?"
            class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-cn-yellow/40"
          />
        </div>

        <div class="space-y-2">
          <span class="block text-sm font-semibold text-text-main">Options</span>
          {#each options as option (option.id)}
            <div class="flex items-center gap-2">
              <input
                bind:value={option.label}
                maxlength="150"
                placeholder="Une réponse…"
                class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-cn-yellow/40"
              />
              <button
                type="button"
                onclick={() => removeOption(option.id)}
                disabled={options.length <= 2}
                class="rounded-xl p-2 text-text-muted hover:bg-black/5 disabled:opacity-30 dark:hover:bg-white/10"
                aria-label="Retirer l'option"
              >
                <Trash2 size={16} />
              </button>
            </div>
          {/each}
          {#if options.length < 10}
            <button
              type="button"
              onclick={addOption}
              class="flex items-center gap-1.5 rounded-xl px-2 py-1.5 text-sm font-semibold text-cn-yellow hover:bg-cn-yellow/10"
            >
              <Plus size={16} /> Ajouter une option
            </button>
          {/if}
        </div>

        <label
          class="flex cursor-pointer select-none items-center justify-between rounded-xl bg-black/5 px-4 py-3 dark:bg-white/5"
        >
          <span class="text-sm font-semibold text-text-main">Autoriser plusieurs réponses</span>
          <input type="checkbox" bind:checked={multipleChoice} class="h-5 w-5 accent-cn-yellow" />
        </label>

        <div>
          <label for="poll-deadline" class="mb-1.5 block text-sm font-semibold text-text-main">
            Date de fin <span class="font-normal text-text-muted">(facultatif)</span>
          </label>
          <input
            id="poll-deadline"
            type="datetime-local"
            bind:value={deadline}
            class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-cn-yellow/40"
          />
        </div>

        {#if error}
          <p class="text-sm font-medium text-red-500">{error}</p>
        {/if}
      </div>

      <div class="flex justify-end gap-2 border-t border-cn-border p-4">
        <button
          type="button"
          onclick={close}
          class="rounded-xl px-4 py-2 text-sm font-semibold text-text-muted hover:bg-black/5 dark:hover:bg-white/10"
        >
          Annuler
        </button>
        <button
          type="button"
          onclick={submit}
          disabled={!canSubmit || submitting}
          class="rounded-xl bg-cn-yellow px-5 py-2 text-sm font-extrabold text-cn-ink transition-all hover:brightness-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Envoi…' : 'Créer le sondage'}
        </button>
      </div>
    </div>
  </div>
{/if}
