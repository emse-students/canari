<script lang="ts">
  import { FingerprintPattern } from '@lucide/svelte';
  import ModalOverlay from '$lib/components/shared/ModalOverlay.svelte';
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

<!--
  NON-DISMISSIBLE IS `onSkip` BEING ABSENT, AND IT STAYS THAT WAY THROUGH THE SHARED OVERLAY.
  `onClose` is required by `ModalOverlay` because a modal a caller may leave uncloseable is one a
  caller will leave uncloseable; here it forwards to the optional `onSkip`, so the outside click and
  the Escape key do exactly what the backdrop's `onclick` did before - something during an unlock,
  nothing during an enrolment, where the OS prompt owns the interaction and there is no PIN to fall
  back to.
-->
<ModalOverlay
  {open}
  onClose={() => onSkip?.()}
  label={m.auth_biometric_aria()}
  layer="sheet"
  panelClass="border-cn-border bg-cn-surface w-full rounded-t-3xl border-t px-6 pt-5 pb-6 shadow-2xl sm:max-w-md sm:rounded-3xl sm:border"
>
  <!-- Drag handle -->
  <div class="bg-text-muted/40 mx-auto mb-5 h-1 w-10 rounded-full"></div>

  <!-- FingerprintPattern icon (animated) -->
  <div class="mb-5 flex justify-center">
    <div class="relative rounded-full bg-amber-500/10 p-5">
      <FingerprintPattern size={52} strokeWidth={1.5} class="text-amber-500" />
      <!-- Pulsing ring -->
      <span class="absolute inset-0 animate-ping rounded-full border-2 border-amber-500/40"></span>
    </div>
  </div>

  <h2 class="text-text-main mb-1 text-center text-lg font-bold">
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
</ModalOverlay>
