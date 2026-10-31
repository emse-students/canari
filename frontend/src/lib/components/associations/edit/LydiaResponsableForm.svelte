<script lang="ts">
  import { untrack } from 'svelte';
  import { listMembers, setLydiaResponsable, type AssociationMember } from '$lib/associations/api';
  import { toE164Phone } from '$lib/associations/lydiaPhone';
  import { lydiaResponsableErrorText } from '$lib/associations/lydiaResponsableRefusal';
  import { m } from '$lib/paraglide/messages';
  import { getSavedUserId } from '$lib/stores/user';
  import Input from '$lib/components/ui/Input.svelte';
  import { CONTROL_LABEL_CLASS, controlClass } from '$lib/components/ui/controlClasses';

  interface Props {
    associationId: string;
    /** `add` invites at Lydia (SMS); `record` only records a cashier Lydia already lists. */
    mode: 'add' | 'record';
    /** The button's label. */
    submitLabel: string;
    /** When set, the person is fixed (a resend): the member picker is not drawn. */
    fixedUserId?: string;
    /** Called after the server accepted; the parent re-reads the payout account. */
    onDone: () => void | Promise<void>;
    /**
     * Called after the server refused or failed: Lydia may have answered the add and the person be
     * recorded UNCONFIRMED, so the parent re-reads the payout account rather than guess.
     */
    onRefused: () => void | Promise<void>;
  }

  let { associationId, mode, submitLabel, fixedUserId, onDone, onRefused }: Props = $props();

  let members = $state<AssociationMember[]>([]);
  let membersFailed = $state(false);
  let userId = $state(untrack(() => fixedUserId ?? getSavedUserId() ?? ''));
  let phone = $state('');
  let phoneError = $state('');
  let error = $state('');
  let sending = $state(false);

  /** The label a roster row is picked by. */
  function memberLabel(member: AssociationMember): string {
    const full = [member.firstName, member.lastName].filter(Boolean).join(' ');
    return member.displayName || full || member.userId;
  }

  $effect(() => {
    if (untrack(() => fixedUserId)) return;
    untrack(() => {
      void listMembers(associationId)
        .then((rows) => {
          members = rows.filter(
            (row, index) => rows.findIndex((other) => other.userId === row.userId) === index
          );
          // Default to the current user, else to the only candidate; never to nobody-in-particular.
          if (!members.some((row) => row.userId === userId)) userId = members[0]?.userId ?? '';
        })
        .catch((err) => {
          console.error('[Lydia] Member list read failed:', err);
          membersFailed = true;
        });
    });
  });

  async function submit() {
    error = '';
    phoneError = '';
    const e164 = toE164Phone(phone);
    if (!e164) {
      console.debug('[Lydia] Responsable phone refused client-side');
      phoneError = m.asso_lydia_resp_phone_format_error();
      return;
    }
    if (!userId) return;
    sending = true;
    try {
      console.debug('[Lydia] Responsable submit', { mode });
      await setLydiaResponsable(associationId, { userId, phone: e164, mode });
      phone = '';
      await onDone();
    } catch (err) {
      console.error('[Lydia] Responsable refused:', err);
      error = lydiaResponsableErrorText(err);
      void onRefused();
    } finally {
      sending = false;
    }
  }
</script>

<div class="space-y-3">
  {#if !fixedUserId}
    {#if membersFailed}
      <p class="text-red-err text-sm" role="alert">{m.asso_lydia_resp_members_error()}</p>
    {:else if members.length === 0}
      <p class="text-text-muted text-sm">{m.asso_lydia_resp_members_empty()}</p>
    {:else}
      <div>
        <label for="lydia-resp-member-{mode}" class={CONTROL_LABEL_CLASS}>
          {m.asso_lydia_resp_member_label()}
        </label>
        <select
          id="lydia-resp-member-{mode}"
          bind:value={userId}
          disabled={sending}
          class={controlClass()}
        >
          {#each members as member (member.userId)}
            <option value={member.userId}>{memberLabel(member)}</option>
          {/each}
        </select>
      </div>
    {/if}
  {/if}
  <Input
    label={m.asso_lydia_resp_phone_label()}
    type="tel"
    inputmode="tel"
    autocomplete="tel"
    placeholder={m.asso_lydia_resp_phone_placeholder()}
    bind:value={phone}
    error={phoneError}
    disabled={sending}
  />
  <button
    type="button"
    onclick={() => void submit()}
    disabled={sending || !phone.trim() || !userId}
    class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-5 py-2.5 text-sm font-bold shadow-sm disabled:opacity-50"
  >
    {sending ? m.asso_lydia_resp_sending() : submitLabel}
  </button>
  {#if error}
    <p class="text-red-err text-sm" role="alert">{error}</p>
  {/if}
</div>
