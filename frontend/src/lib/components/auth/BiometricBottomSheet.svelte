<script lang="ts">
  import { Fingerprint } from '@lucide/svelte';

  interface Props {
    /** Whether the sheet is visible. */
    open: boolean;
    /** Called when the user taps the biometric button. */
    onConfirm: () => void;
    /** Called when the user chooses to use PIN instead. */
    onSkip: () => void;
  }

  let { open, onConfirm, onSkip }: Props = $props();
</script>

{#if open}
  <!-- Backdrop -->
  <div
    class="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
    onclick={onSkip}
    role="presentation"
    aria-hidden="true"
  ></div>

  <!-- Sheet -->
  <div
    class="fixed inset-x-0 bottom-0 z-50 rounded-t-3xl border-t border-black/8 dark:border-white/10 bg-white/95 dark:bg-[#1a1f2e]/95 backdrop-blur-2xl shadow-2xl px-6 pt-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))]"
    role="dialog"
    aria-modal="true"
    aria-label="Authentification biométrique"
  >
    <!-- Drag handle -->
    <div class="mx-auto mb-5 h-1 w-10 rounded-full bg-black/15 dark:bg-white/20"></div>

    <!-- Fingerprint icon (animated) -->
    <div class="flex justify-center mb-5">
      <div class="relative p-5 rounded-full bg-amber-500/10">
        <Fingerprint size={52} strokeWidth={1.5} class="text-amber-500" />
        <!-- Pulsing ring -->
        <span class="absolute inset-0 rounded-full border-2 border-amber-500/40 animate-ping"></span>
      </div>
    </div>

    <h2 class="text-center text-lg font-extrabold text-text-main mb-1">
      Déverrouillage biométrique
    </h2>
    <p class="text-center text-sm text-text-muted mb-6 leading-relaxed">
      Utilisez votre empreinte ou Face ID pour déchiffrer vos messages.
    </p>

    <button
      type="button"
      onclick={onConfirm}
      class="w-full py-3.5 bg-amber-500 text-[#151B2C] rounded-2xl font-extrabold text-sm hover:bg-amber-400 active:scale-[0.98] transition-all shadow-lg shadow-amber-500/25 flex items-center justify-center gap-2.5"
    >
      <Fingerprint size={18} strokeWidth={2.5} />
      Utiliser la biométrie
    </button>

    <button
      type="button"
      onclick={onSkip}
      class="w-full mt-3 py-2.5 text-sm font-semibold text-text-muted hover:text-text-main transition-colors"
    >
      Utiliser mon PIN
    </button>
  </div>
{/if}
