<script lang="ts">
  import Modal from '../shared/Modal.svelte';
  import { tick } from 'svelte';
  import { Globe, Lock } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Whether the modal is visible. */
    open: boolean;
    /** Current value of the channel name input. */
    channelName: string;
    /** Channel visibility: 'public' or 'private'. */
    visibility: 'public' | 'private';
    /** Callback to close the modal. */
    onClose: () => void;
    /** Callback fired when the channel name input changes. */
    onChannelNameChange: (value: string) => void;
    /** Callback fired when the visibility toggle changes. */
    onVisibilityChange: (value: 'public' | 'private') => void;
    /** Callback to submit the new channel creation form. */
    onSubmitChannel: () => void;
  }

  let {
    open,
    channelName,
    visibility,
    onClose,
    onChannelNameChange,
    onVisibilityChange,
    onSubmitChannel,
  }: Props = $props();
  let channelInput: HTMLInputElement | undefined;

  $effect(() => {
    if (!open) return;
    void tick().then(() => channelInput?.focus());
  });
</script>

<Modal {open} {onClose} title={m.chat_modal_channel_name_label()}>
  <div class="space-y-4 pt-2">
    <div>
      <label for="new-channel-name" class="block text-sm font-medium text-text-main mb-1"
        >{m.chat_modal_channel_name_label()}</label
      >
      <input
        bind:this={channelInput}
        id="new-channel-name"
        type="text"
        value={channelName}
        oninput={(e) => onChannelNameChange((e.target as HTMLInputElement).value)}
        placeholder={m.chat_modal_channel_name_placeholder()}
        class="w-full px-4 py-2.5 bg-white/65 dark:bg-black/30 border border-white/60 dark:border-white/10 rounded-xl text-sm outline-none focus:ring-2 focus:ring-amber-400/45"
        onkeydown={(e) => e.key === 'Enter' && onSubmitChannel()}
      />
    </div>

    <!-- Visibility toggle -->
    <div>
      <span class="block text-sm font-medium text-text-main mb-2"
        >{m.chat_channel_visibility_label()}</span
      >
      <div class="flex gap-2">
        <button
          type="button"
          onclick={() => onVisibilityChange('public')}
          class="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all {visibility ===
          'public'
            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30'
            : 'bg-white/65 dark:bg-black/30 border border-white/60 dark:border-white/10 text-text-muted hover:text-text-main'}"
        >
          <Globe size={16} />
          {m.chat_channel_visibility_public()}
        </button>
        <button
          type="button"
          onclick={() => onVisibilityChange('private')}
          class="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all {visibility ===
          'private'
            ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30'
            : 'bg-white/65 dark:bg-black/30 border border-white/60 dark:border-white/10 text-text-muted hover:text-text-main'}"
        >
          <Lock size={16} />
          {m.chat_channel_visibility_private()}
        </button>
      </div>
      <p class="text-xs text-text-muted mt-1.5">
        {visibility === 'public'
          ? m.chat_channel_visibility_public_note()
          : m.chat_channel_visibility_private_note()}
      </p>
    </div>

    <button
      onclick={onSubmitChannel}
      disabled={!channelName.trim()}
      class="w-full py-2.5 bg-amber-500 text-white font-semibold rounded-xl hover:bg-amber-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {m.chat_modal_create_channel_button()}
    </button>
  </div>
</Modal>
