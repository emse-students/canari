<script lang="ts">
  import { FingerprintPattern } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Whether the sheet is visible. */
    open: boolean;
    /**
     * Called when the user chooses to use their PIN instead. Omit to render a
     * non-dismissible sheet: during enrolment the OS prompt owns the interaction and there
     * is no PIN to fall back to.
     */
    onSkip?: () => void;
    /** Which flow raised the OS prompt; selects the sheet copy. */
    variant?: 'unlock' | 'enroll';
  }

  let { open, onSkip, variant = 'unlock' }: Props = $props();

  const isEnroll = $derived(variant === 'enroll');
  const title = $derived(
    isEnroll ? m.auth_biometric_enroll_confirm_title() : m.auth_biometric_title()
  );
  const description = $derived(
    isEnroll ? m.auth_biometric_enroll_confirm_desc() : m.auth_biometric_desc()
  );
</script>

{#if open}
  <!-- Backdrop -->
  <div
    class="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
    onclick={() => onSkip?.()}
    role="presentation"
    aria-hidden="true"
  ></div>

  <!-- Sheet -->
  <div
    class="border-cn-border bg-cn-surface/95 fixed inset-x-0 bottom-0 z-50 rounded-t-3xl border-t px-6 pt-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-2xl backdrop-blur-2xl"
    role="dialog"
    aria-modal="true"
    aria-label={m.auth_biometric_aria()}
  >
    <!-- Drag handle -->
    <div class="bg-text-muted/40 mx-auto mb-5 h-1 w-10 rounded-full"></div>

    <!-- FingerprintPattern icon (animated) -->
    <div class="mb-5 flex justify-center">
      <div class="relative rounded-full bg-amber-500/10 p-5">
        <FingerprintPattern size={52} strokeWidth={1.5} class="text-amber-500" />
        <!-- Pulsing ring -->
        <span class="absolute inset-0 animate-ping rounded-full border-2 border-amber-500/40"
        ></span>
      </div>
    </div>

    <h2 class="text-text-main mb-1 text-center text-lg font-extrabold">
      {title}
    </h2>
    <p class="text-text-muted mb-6 text-center text-sm leading-relaxed">
      {description}
    </p>

    {#if onSkip}
      <button
        type="button"
        onclick={onSkip}
        class="text-text-muted hover:text-text-main mt-3 w-full py-2.5 text-sm font-semibold transition-colors"
      >
        {m.auth_biometric_use_pin()}
      </button>
    {/if}
  </div>
{/if}
