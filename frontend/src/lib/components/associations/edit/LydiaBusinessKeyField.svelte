<script lang="ts">
  /**
   * The Lydia Business private token of the association: the key its payment callbacks are verified
   * with (payments.md, "What confirms a payment"). WRITE-ONLY - the server never answers the value,
   * so this field only ever shows "set" or "not set" and is emptied after every save. Until a key is
   * set, the panel says plainly that callbacks cannot be verified yet and payments are confirmed only
   * when the payer comes back to the app.
   */
  import { untrack } from 'svelte';
  import { getLydiaBusinessKeyStatus, setLydiaBusinessKey } from '$lib/associations/api';
  import { KeyRound } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import Input from '$lib/components/ui/Input.svelte';

  interface Props {
    associationId: string;
  }

  let { associationId }: Props = $props();

  /** null while unknown (loading, or the read failed). */
  let keySet = $state<boolean | null>(null);
  let statusFailed = $state(false);
  let draft = $state('');
  let saving = $state(false);
  let saveError = $state('');
  let saved = $state(false);

  async function loadStatus() {
    statusFailed = false;
    try {
      keySet = (await getLydiaBusinessKeyStatus(associationId)).set;
    } catch (err) {
      console.error('[Lydia] Business key status read failed:', err);
      statusFailed = true;
    }
  }

  $effect(() => {
    untrack(() => void loadStatus());
  });

  async function handleSave() {
    const value = draft.trim();
    if (!value) return;
    saving = true;
    saveError = '';
    saved = false;
    try {
      await setLydiaBusinessKey(associationId, value);
      keySet = true;
      saved = true;
    } catch (err) {
      console.error('[Lydia] Business key save failed:', err);
      saveError = m.asso_lydia_business_key_save_error();
    } finally {
      // Never kept in memory longer than the request: the field is write-only.
      draft = '';
      saving = false;
    }
  }
</script>

<div class="border-cn-border space-y-3 rounded-2xl border p-4">
  <p class="text-text-main flex flex-wrap items-center gap-2 text-sm font-semibold">
    <KeyRound size={16} />
    {m.asso_lydia_business_key_title()}
    {#if keySet !== null}
      <span
        class="{keySet
          ? 'text-green-ok bg-green-ok/20'
          : 'text-amber-warn bg-amber-warn/20'} text-2xs rounded-full px-2 py-0.5 font-bold tracking-wide uppercase"
      >
        {keySet ? m.asso_lydia_business_key_status_set() : m.asso_lydia_business_key_status_unset()}
      </span>
    {/if}
  </p>

  {#if statusFailed}
    <p class="text-red-err text-sm" role="alert">{m.asso_lydia_business_key_status_error()}</p>
    <button
      type="button"
      onclick={() => void loadStatus()}
      class="border-cn-border text-text-main hover:bg-cn-bg rounded-xl border px-4 py-2.5 text-sm font-bold"
    >
      {m.asso_payments_provider_retry()}
    </button>
  {:else if keySet === false}
    <p class="text-amber-warn text-sm leading-relaxed" role="status">
      {m.asso_lydia_business_key_unverified()}
    </p>
  {:else if keySet}
    <p class="text-text-muted text-sm leading-relaxed">{m.asso_lydia_business_key_verified()}</p>
  {/if}

  <p class="text-text-muted text-xs leading-relaxed">{m.asso_lydia_business_key_help()}</p>

  <Input
    label={keySet ? m.asso_lydia_business_key_replace_label() : m.asso_lydia_business_key_label()}
    type="password"
    autocomplete="off"
    spellcheck="false"
    bind:value={draft}
    disabled={saving}
  />
  <button
    type="button"
    onclick={() => void handleSave()}
    disabled={saving || !draft.trim()}
    class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-4 py-2.5 text-sm font-bold shadow-sm disabled:opacity-50"
  >
    {saving ? m.asso_lydia_business_key_saving() : m.asso_lydia_business_key_save()}
  </button>
  {#if saved}
    <p class="text-green-ok text-sm" role="status">{m.asso_lydia_business_key_saved()}</p>
  {/if}
  {#if saveError}
    <p class="text-red-err text-sm" role="alert">{saveError}</p>
  {/if}
</div>
