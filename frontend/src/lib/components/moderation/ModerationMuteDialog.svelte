<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    open: boolean;
    targetLabel: string;
    loading?: boolean;
    onClose: () => void;
    onConfirm: (userVisibleReason: string) => void;
  }

  let { open, targetLabel, loading = false, onClose, onConfirm }: Props = $props();

  let reason = $state('');

  const presets = $derived([
    {
      label: m.moderation_preset_inappropriate(),
      text: m.moderation_preset_inappropriate_text(),
    },
    {
      label: m.moderation_preset_harassment(),
      text: m.moderation_preset_harassment_text(),
    },
    {
      label: m.moderation_preset_spam(),
      text: m.moderation_preset_spam_text(),
    },
    {
      label: m.moderation_preset_general(),
      text: m.moderation_preset_general_text(),
    },
  ]);

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
  title={m.moderation_mute_title({ targetLabel })}
  maxWidth="max-w-md"
  dismissible={!loading}
>
  <div class="space-y-4 px-1 pb-2">
    <p class="text-sm text-text-muted leading-relaxed">
      {m.moderation_mute_desc()}
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
        >{m.moderation_mute_message_label()}</span
      >
      <textarea
        bind:value={reason}
        rows="4"
        maxlength="500"
        placeholder={m.moderation_mute_placeholder()}
        class="w-full rounded-xl border border-cn-border bg-white/50 dark:bg-black/20 px-3 py-2.5 text-sm text-text-main placeholder:text-text-muted/60 focus:border-cn-yellow focus:ring-2 focus:ring-cn-yellow/20 outline-none resize-y min-h-[6rem]"
        disabled={loading}></textarea>
    </label>

    <div class="flex justify-end gap-2 pt-1">
      <button
        type="button"
        class="px-4 py-2 text-sm font-semibold rounded-xl text-text-muted hover:bg-black/5 transition-colors"
        onclick={onClose}
        disabled={loading}
      >
        {m.common_cancel_button()}
      </button>
      <button
        type="button"
        class="px-4 py-2 text-sm font-semibold rounded-xl bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-40"
        onclick={submit}
        disabled={loading || !reason.trim()}
      >
        {loading ? m.moderation_mute_in_progress() : m.moderation_mute_confirm_button()}
      </button>
    </div>
  </div>
</Modal>
