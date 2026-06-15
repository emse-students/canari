<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';

  interface Props {
    open: boolean;
    targetLabel: string;
    loading?: boolean;
    onClose: () => void;
    onConfirm: (userVisibleReason: string) => void;
  }

  let { open, targetLabel, loading = false, onClose, onConfirm }: Props = $props();

  let reason = $state('');

  const presets: { label: string; text: string }[] = [
    {
      label: 'Contenu inapproprié',
      text: 'Votre compte a été restreint suite à un signalement pour contenu inapproprié.',
    },
    {
      label: 'Harcèlement',
      text: 'Votre compte a été restreint suite à un signalement pour harcèlement.',
    },
    {
      label: 'Spam',
      text: 'Votre compte a été restreint suite à un signalement pour spam.',
    },
    {
      label: 'Modération générale',
      text: 'Votre compte a été restreint par l\'équipe de modération. Contactez le BDE si vous pensez qu\'il s\'agit d\'une erreur.',
    },
  ];

  $effect(() => {
    if (!open) resetOnClose();
  });

  function applyPreset(text: string) {
    reason = text;
  }

  /** Resets the reason field when the dialog closes. */
  function resetOnClose() {
    reason = '';
  }

  function submit() {
    const trimmed = reason.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  }
</script>

<Modal
  {open}
  {onClose}
  title="Muter {targetLabel}"
  maxWidth="max-w-md"
  dismissible={!loading}
>
  <div class="space-y-4 px-1 pb-2">
    <p class="text-sm text-text-muted leading-relaxed">
      L'utilisateur pourra encore se connecter et lire, mais ne pourra plus publier, commenter ni
      réagir. Le message ci-dessous lui sera affiché dans l'application.
    </p>

    <div class="flex flex-wrap gap-2">
      {#each presets as preset (preset.label)}
        <button
          type="button"
          class="text-[11px] px-2.5 py-1.5 rounded-lg border border-cn-border text-text-muted hover:border-amber-400 hover:text-text-main transition-colors"
          onclick={() => applyPreset(preset.text)}
          disabled={loading}
          title={preset.text}
        >
          {preset.label}
        </button>
      {/each}
    </div>

    <label class="block">
      <span class="text-xs font-semibold text-text-muted mb-1.5 block"
        >Message visible par l'utilisateur</span
      >
      <textarea
        bind:value={reason}
        rows="4"
        maxlength="500"
        placeholder="Expliquez la restriction de façon claire et factuelle…"
        class="w-full rounded-xl border border-cn-border bg-white/50 dark:bg-black/20 px-3 py-2.5 text-sm text-text-main placeholder:text-text-muted/60 focus:border-cn-yellow focus:ring-2 focus:ring-cn-yellow/20 outline-none resize-y min-h-[6rem]"
        disabled={loading}
      ></textarea>
    </label>

    <div class="flex justify-end gap-2 pt-1">
      <button
        type="button"
        class="px-4 py-2 text-sm font-semibold rounded-xl text-text-muted hover:bg-black/5 transition-colors"
        onclick={onClose}
        disabled={loading}
      >
        Annuler
      </button>
      <button
        type="button"
        class="px-4 py-2 text-sm font-semibold rounded-xl bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-40"
        onclick={submit}
        disabled={loading || !reason.trim()}
      >
        {loading ? 'En cours…' : 'Confirmer le mute'}
      </button>
    </div>
  </div>
</Modal>
