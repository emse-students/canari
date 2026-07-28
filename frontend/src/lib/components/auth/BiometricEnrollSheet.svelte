<script lang="ts">
  /**
   * Post-login offer to enable biometric unlock (mobile only).
   *
   * Shown once, right after the first PIN entry - the device key only exists from that point,
   * so there is nothing to hand to the keystore before it. Declining is permanent: the caller
   * persists a "dismissed" flag and never raises this sheet again.
   */
  import { Fingerprint } from '@lucide/svelte';
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

{#if open}
  <!-- Backdrop -->
  <div
    class="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
    onclick={onDismiss}
    role="presentation"
    aria-hidden="true"
  ></div>

  <!-- Sheet -->
  <div
    class="fixed inset-x-0 bottom-0 z-50 rounded-t-3xl border-t border-cn-border bg-cn-surface/95 backdrop-blur-2xl shadow-2xl px-6 pt-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))]"
    role="dialog"
    aria-modal="true"
    aria-label={m.auth_biometric_enroll_title()}
  >
    <!-- Drag handle -->
    <div class="mx-auto mb-5 h-1 w-10 rounded-full bg-text-muted/40"></div>

    <div class="flex justify-center mb-5">
      <div class="p-5 rounded-full bg-amber-500/10">
        <Fingerprint size={52} strokeWidth={1.5} class="text-amber-500" />
      </div>
    </div>

    <h2 class="text-center text-lg font-extrabold text-text-main mb-1">
      {m.auth_biometric_enroll_title()}
    </h2>
    <p class="text-center text-sm text-text-muted mb-6 leading-relaxed">
      {m.auth_biometric_enroll_desc()}
    </p>

    <button
      type="button"
      onclick={onEnroll}
      class="w-full py-3.5 bg-cn-yellow text-cn-ink rounded-xl font-extrabold text-sm hover:bg-cn-yellow-hover transition-all active:scale-95"
    >
      {m.auth_biometric_enable_btn()}
    </button>
    <button
      type="button"
      onclick={onDismiss}
      class="w-full mt-3 py-2.5 text-sm font-semibold text-text-muted hover:text-text-main transition-colors"
    >
      {m.auth_biometric_later_btn()}
    </button>
  </div>
{/if}
