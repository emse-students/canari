<script lang="ts">
  /**
   * Post-login offer to enable biometric unlock (mobile only).
   *
   * Shown once, right after the first PIN entry - the device key only exists from that point,
   * so there is nothing to hand to the keystore before it. Declining is permanent: the caller
   * persists a "dismissed" flag and never raises this sheet again.
   */
  import { FingerprintPattern } from '@lucide/svelte';
  import ModalOverlay from '$lib/components/shared/ModalOverlay.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Whether the sheet is visible. */
    open: boolean;
    /** Called when the user accepts; the caller then runs the enrolment. */
    onEnroll: () => void;
    /** Called when the user declines. The offer is not shown again. */
    onDismiss: () => void;
  }

  let { open, onEnroll, onDismiss }: Props = $props();
</script>

<ModalOverlay
  {open}
  onClose={onDismiss}
  label={m.auth_biometric_enroll_title()}
  layer="sheet"
  panelClass="border-cn-border bg-cn-surface w-full rounded-t-3xl border-t px-6 pt-5 pb-6 shadow-2xl sm:max-w-md sm:rounded-3xl sm:border"
>
  <!-- Drag handle -->
  <div class="bg-text-muted/40 mx-auto mb-5 h-1 w-10 rounded-full"></div>

  <div class="mb-5 flex justify-center">
    <div class="rounded-full bg-amber-500/10 p-5">
      <FingerprintPattern size={52} strokeWidth={1.5} class="text-amber-500" />
    </div>
  </div>

  <h2 class="text-text-main mb-1 text-center text-lg font-bold">
    {m.auth_biometric_enroll_title()}
  </h2>
  <p class="text-text-muted mb-6 text-center text-sm leading-relaxed">
    {m.auth_biometric_enroll_desc()}
  </p>

  <button
    type="button"
    onclick={onEnroll}
    class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover w-full rounded-xl py-3.5 text-sm font-bold transition-all active:scale-95"
  >
    {m.auth_biometric_enable_btn()}
  </button>
  <button
    type="button"
    onclick={onDismiss}
    class="text-text-muted hover:text-text-main mt-3 w-full py-2.5 text-sm font-semibold transition-colors"
  >
    {m.auth_biometric_later_btn()}
  </button>
</ModalOverlay>
