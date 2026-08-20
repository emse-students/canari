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
    <p class="text-text-muted text-sm leading-relaxed">
      {m.moderation_mute_desc()}
    </p>

    <div class="flex flex-wrap gap-2">
      {#each presets as preset (preset.label)}
        <button
          type="button"
          class="border-cn-border text-text-muted hover:text-text-main rounded-lg border px-2.5 py-1.5 text-[11px] transition-colors hover:border-amber-400"
          onclick={() => applyPreset(preset.text)}
          disabled={loading}
          title={preset.text}
        >
          {preset.label}
        </button>
      {/each}
    </div>

    <label class="block">
      <span class="text-text-muted mb-1.5 block text-xs font-semibold"
        >{m.moderation_mute_message_label()}</span
      >
      <textarea
        bind:value={reason}
        rows="4"
        maxlength="500"
        placeholder={m.moderation_mute_placeholder()}
        class="border-cn-border text-text-main placeholder:text-text-muted/60 focus:border-cn-yellow focus:ring-cn-yellow/20 min-h-[6rem] w-full resize-y rounded-xl border bg-white/50 px-3 py-2.5 text-sm outline-none focus:ring-2 dark:bg-black/20"
        disabled={loading}></textarea>
    </label>

    <div class="flex justify-end gap-2 pt-1">
      <button
        type="button"
        class="text-text-muted rounded-xl px-4 py-2 text-sm font-semibold transition-colors hover:bg-black/5"
        onclick={onClose}
        disabled={loading}
      >
        {m.common_cancel_button()}
      </button>
      <button
        type="button"
        class="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-40"
        onclick={submit}
        disabled={loading || !reason.trim()}
      >
        {loading ? m.moderation_mute_in_progress() : m.moderation_mute_confirm_button()}
      </button>
    </div>
  </div>
</Modal>
