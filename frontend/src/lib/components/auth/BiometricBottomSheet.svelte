<script lang="ts">
  import { Fingerprint } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Whether the sheet is visible. */
    open: boolean;
    /** Called when the user chooses to use PIN instead. */
    onSkip: () => void;
  }

  let { open, onSkip }: Props = $props();
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
    aria-label={m.auth_biometric_aria()}
  >
    <!-- Drag handle -->
    <div class="mx-auto mb-5 h-1 w-10 rounded-full bg-black/15 dark:bg-white/20"></div>

    <!-- Fingerprint icon (animated) -->
    <div class="flex justify-center mb-5">
      <div class="relative p-5 rounded-full bg-amber-500/10">
        <Fingerprint size={52} strokeWidth={1.5} class="text-amber-500" />
        <!-- Pulsing ring -->
        <span class="absolute inset-0 rounded-full border-2 border-amber-500/40 animate-ping"
        ></span>
      </div>
    </div>

    <h2 class="text-center text-lg font-extrabold text-text-main mb-1">
      {m.auth_biometric_title()}
    </h2>
    <p class="text-center text-sm text-text-muted mb-6 leading-relaxed">
      {m.auth_biometric_desc()}
    </p>

    <button
      type="button"
      onclick={onSkip}
      class="w-full mt-3 py-2.5 text-sm font-semibold text-text-muted hover:text-text-main transition-colors"
    >
      {m.auth_biometric_use_pin()}
    </button>
  </div>
{/if}
