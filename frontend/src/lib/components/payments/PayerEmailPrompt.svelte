<script lang="ts">
  import { coversScreen } from '$lib/actions/coversScreen.svelte';
  import { focusTrap } from '$lib/actions/focusTrap.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { normalizePayerEmail } from '$lib/payments/payerEmail';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Called with the validated address when the payer confirms. */
    onSubmit: (email: string) => void;
    /** Called when the payer dismisses the prompt without paying. */
    onClose: () => void;
  }

  let { onSubmit, onClose }: Props = $props();

  let value = $state('');
  let touched = $state(false);
  const email = $derived(normalizePayerEmail(value));

  function submit(e: Event) {
    e.preventDefault();
    touched = true;
    if (email) onSubmit(email);
  }
</script>

<div
  use:coversScreen
  data-keyboard-aware-overlay
  class="z-50 flex items-end justify-center bg-black/40 sm:items-center"
  role="presentation"
>
  <div
    use:focusTrap
    role="dialog"
    aria-modal="true"
    aria-label={m.payer_email_title()}
    class="keyboard-aware-modal-panel border-cn-border bg-cn-surface w-full max-w-md rounded-t-3xl border p-6 shadow-2xl sm:rounded-2xl"
  >
    <form onsubmit={submit} class="space-y-4">
      <div>
        <h2 class="text-text-main text-base font-bold">{m.payer_email_title()}</h2>
        <p class="text-text-muted mt-1 text-xs">{m.payer_email_hint()}</p>
      </div>
      <Input
        type="email"
        autocomplete="email"
        bind:value
        label={m.payer_email_label()}
        required
        error={touched && !email ? m.payer_email_invalid() : undefined}
      />
      <div class="flex justify-end gap-2">
        <Button variant="ghost" onclick={onClose}>{m.payer_email_cancel()}</Button>
        <Button type="submit">{m.payer_email_confirm()}</Button>
      </div>
    </form>
  </div>
</div>
