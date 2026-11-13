<script lang="ts">
  import ModalOverlay from './ModalOverlay.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import { m } from '$lib/paraglide/messages';
  import { confirmStore, resolveConfirm } from '$lib/stores/confirm.svelte';

  const pending = $derived(confirmStore.pending);

  /** What the user has typed, when the dialog asks for a typed confirmation. */
  let typed = $state('');

  // Every new dialog starts empty. Without this, a second delete would open already satisfied
  // by what was typed into the first one - which is the whole guard, gone.
  $effect(() => {
    void pending;
    typed = '';
  });

  const canConfirm = $derived(!pending?.requireText || typed.trim() === pending.requireText.trim());
</script>

<!--
  A confirmation is nearly
  always raised FROM a modal (delete this document, leave this community), and it covers it because
  it opens later (`utils/overlayStack.ts`).
-->
<ModalOverlay
  open={!!pending}
  onClose={() => resolveConfirm(false)}
  label={pending?.message ?? ''}
  role="alertdialog"
  panelClass="border-cn-border w-full max-w-sm space-y-5 rounded-2xl border bg-(--cn-surface) p-6 shadow-2xl"
>
  {#if pending}
    <p class="text-text-main text-sm leading-relaxed font-medium">{pending.message}</p>
    {#if pending.requireText}
      <div class="space-y-2">
        <p class="text-text-muted text-xs">{m.confirm_type_to_continue()}</p>
        <p class="text-text-main text-sm font-bold wrap-break-word select-all">
          {pending.requireText}
        </p>
        <!--
              NO `autofocus` HERE, and its absence is what makes the field focused rather than the
              other way round. Chrome refuses the attribute when something already holds focus -
              always the case, since the dialog is opened by a button the user just clicked - and
              logged "Autofocus processing was blocked because a document already has a focused
              element" on every community deletion, which is how it was found. `use:focusTrap` on
              the dialog focuses its first focusable child, and in DOM order that is this input; a
              programmatic focus is never blocked, so the attribute added a warning and nothing else.
            -->
        <Input
          bind:value={typed}
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          aria-label={m.confirm_type_to_continue()}
          placeholder={m.confirm_type_placeholder()}
        />
      </div>
    {/if}
    <div class="flex justify-end gap-2">
      <Button variant="secondary" onclick={() => resolveConfirm(false)}>
        {pending.cancelLabel}
      </Button>
      <Button
        variant={pending.danger ? 'danger' : 'primary'}
        onclick={() => resolveConfirm(true)}
        disabled={!canConfirm}
      >
        {pending.confirmLabel}
      </Button>
    </div>
  {/if}
</ModalOverlay>
