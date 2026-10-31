<script lang="ts">
  import {
    addLydiaCashier,
    changeLydiaCashierRole,
    listMembers,
    revokeLydiaCashier,
    type AssociationMember,
    type AssociationPayoutAccount,
    type LydiaAddableCashierRole,
    type LydiaCashier,
    type LydiaCashierRole,
  } from '$lib/associations/api';
  import { LYDIA_ADDABLE_CASHIER_ROLES, lydiaCashiersView } from '$lib/associations/lydiaCashiers';
  import { lydiaCashierErrorText } from '$lib/associations/lydiaCashierRefusal';
  import { toE164Phone } from '$lib/associations/lydiaPhone';
  import { LYDIA_PRO_HELP_ROUTE } from '$lib/posts/notificationTarget';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import { CONTROL_LABEL_CLASS, controlClass } from '$lib/components/ui/controlClasses';
  import { Users } from '@lucide/svelte';

  interface Props {
    associationId: string;
    /** The payout account the parent read: the section draws from it alone. */
    account: AssociationPayoutAccount;
    /** Re-reads the payout account, after every action and every refusal. */
    reload: () => void | Promise<void>;
  }

  let { associationId, account, reload }: Props = $props();

  const view = $derived(lydiaCashiersView(account));

  let error = $state('');
  let notice = $state('');
  let busy = $state(false);

  let adding = $state(false);
  let members = $state<AssociationMember[]>([]);
  let membersFailed = $state(false);
  let addUserId = $state('');
  let addPhone = $state('');
  let addPhoneError = $state('');
  let addRole = $state<LydiaAddableCashierRole>('vendeur');

  /** The cashier whose role is being changed, and the role picked for them. */
  let roleFor = $state<string | null>(null);
  let newRole = $state<LydiaAddableCashierRole>('vendeur');

  /** The role in everyday words. */
  function roleName(role: LydiaCashierRole): string {
    switch (role) {
      case 'responsable':
        return m.asso_lydia_cashier_role_responsable();
      case 'tresorier':
        return m.asso_lydia_cashier_role_tresorier();
      case 'vendeur':
        return m.asso_lydia_cashier_role_vendeur();
    }
  }

  /** What the role lets the person do, in everyday words. */
  function roleHint(role: LydiaCashierRole): string {
    switch (role) {
      case 'responsable':
        return m.asso_lydia_cashier_role_responsable_hint();
      case 'tresorier':
        return m.asso_lydia_cashier_role_tresorier_hint();
      case 'vendeur':
        return m.asso_lydia_cashier_role_vendeur_hint();
    }
  }

  /** The date a cashier was added, in the reader's locale. */
  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(getLocale() === 'en' ? 'en-US' : 'fr-FR');
  }

  /** The label a roster row is picked by. */
  function memberLabel(member: AssociationMember): string {
    const full = [member.firstName, member.lastName].filter(Boolean).join(' ');
    return member.displayName || full || member.userId;
  }

  /** Opens the add form and reads the roster once (members who are not cashiers yet first). */
  function openAdd() {
    adding = true;
    error = '';
    notice = '';
    void listMembers(associationId)
      .then((rows) => {
        const taken = new Set((account.cashiers ?? []).map((c) => c.userId));
        members = rows.filter(
          (row, index) =>
            !taken.has(row.userId) &&
            rows.findIndex((other) => other.userId === row.userId) === index
        );
        addUserId = members[0]?.userId ?? '';
      })
      .catch((err) => {
        console.error('[Lydia] Cashier roster read failed:', err);
        membersFailed = true;
      });
  }

  /** Runs one action, then re-reads the account whatever the outcome. */
  async function run(label: string, action: () => Promise<unknown>, done?: string) {
    busy = true;
    error = '';
    notice = '';
    try {
      console.debug('[Lydia] Cashier action', { label });
      await action();
      if (done) notice = done;
    } catch (err) {
      console.error(`[Lydia] Cashier ${label} refused:`, err);
      error = lydiaCashierErrorText(err);
    } finally {
      busy = false;
      await reload();
    }
  }

  async function submitAdd() {
    addPhoneError = '';
    const e164 = toE164Phone(addPhone);
    if (!e164) {
      console.debug('[Lydia] Cashier phone refused client-side');
      addPhoneError = m.asso_lydia_resp_phone_format_error();
      return;
    }
    if (!addUserId) return;
    await run('add', () =>
      addLydiaCashier(associationId, { userId: addUserId, phone: e164, role: addRole })
    );
    if (!error) {
      adding = false;
      addPhone = '';
    }
  }

  async function submitRole(cashier: LydiaCashier) {
    await run('role', () => changeLydiaCashierRole(associationId, cashier.id, newRole));
    if (!error) roleFor = null;
  }

  async function revoke(cashier: LydiaCashier, number: 'current' | 'previous') {
    const question =
      number === 'previous'
        ? m.asso_lydia_cashier_revoke_previous_confirm({
            phoneEnd: cashier.previousPhoneEnd ?? '',
          })
        : m.asso_lydia_cashier_revoke_confirm({ name: cashier.name });
    if (
      !(await showConfirm(question, {
        danger: true,
        confirmLabel:
          number === 'previous'
            ? m.asso_lydia_cashier_revoke_previous_button()
            : m.asso_lydia_cashier_revoke_button(),
      }))
    )
      return;
    await run(
      'revoke',
      () => revokeLydiaCashier(associationId, cashier.id, number),
      m.asso_lydia_cashier_revoked()
    );
  }
</script>

{#if view.visible}
  <section class="border-cn-border space-y-3 border-t pt-4" aria-labelledby="lydia-cashiers-title">
    <h3
      id="lydia-cashiers-title"
      class="text-text-main flex items-center gap-2 text-base font-bold tracking-tight"
    >
      <Users size={18} />
      {m.asso_lydia_cashiers_title()}
    </h3>
    <p class="text-text-muted text-sm leading-relaxed">
      {m.asso_lydia_cashiers_intro()}
      <a href={LYDIA_PRO_HELP_ROUTE} class="text-text-main font-semibold underline">
        {m.asso_lydia_cashiers_help_link()}
      </a>
    </p>

    <ul class="space-y-3">
      {#each view.rows as row (row.cashier.id)}
        {@const cashier = row.cashier}
        <li class="border-cn-border space-y-2 rounded-lg border p-3">
          <p class="text-text-main text-sm font-semibold">
            {cashier.name}
            <span class="text-text-muted font-normal">
              - {roleName(cashier.role)} ({roleHint(cashier.role)})
            </span>
          </p>
          <p class="text-text-muted text-xs">
            {m.asso_lydia_cashier_phone_end({ phoneEnd: cashier.phoneEnd })} · {m.asso_lydia_cashier_added(
              { date: formatDate(cashier.addedAt), name: cashier.addedByName }
            )}
          </p>
          {#if cashier.state === 'unconfirmed'}
            <p class="text-amber-warn text-xs" role="status">
              {m.asso_lydia_cashier_state_unconfirmed()}
            </p>
          {:else if cashier.state === 'revoke-unconfirmed'}
            <p class="text-red-err text-xs" role="status">
              {m.asso_lydia_cashier_state_revoke_unconfirmed()}
            </p>
          {/if}
          {#if cashier.previousPhoneEnd}
            <p class="text-red-err text-xs" role="status">
              {m.asso_lydia_cashier_previous_number({ phoneEnd: cashier.previousPhoneEnd })}
            </p>
          {/if}

          {#if roleFor === cashier.id}
            <div class="space-y-2">
              <label for="lydia-cashier-role-{cashier.id}" class={CONTROL_LABEL_CLASS}>
                {m.asso_lydia_cashier_role_label()}
              </label>
              <select
                id="lydia-cashier-role-{cashier.id}"
                bind:value={newRole}
                disabled={busy}
                class={controlClass()}
              >
                {#each LYDIA_ADDABLE_CASHIER_ROLES as role (role)}
                  <option value={role}>{roleName(role)} - {roleHint(role)}</option>
                {/each}
              </select>
              <div class="flex flex-wrap gap-2">
                <button
                  type="button"
                  onclick={() => void submitRole(cashier)}
                  disabled={busy || newRole === cashier.role}
                  class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-50"
                >
                  {busy
                    ? m.asso_lydia_cashier_working()
                    : m.asso_lydia_cashier_change_role_submit()}
                </button>
                <button
                  type="button"
                  onclick={() => (roleFor = null)}
                  disabled={busy}
                  class="border-cn-border text-text-main hover:bg-cn-bg rounded-lg border px-3 py-1.5 text-xs font-semibold"
                >
                  {m.asso_lydia_cashier_cancel()}
                </button>
              </div>
            </div>
          {:else}
            <div class="flex flex-wrap gap-2">
              {#if row.canChangeRole}
                <button
                  type="button"
                  onclick={() => {
                    roleFor = cashier.id;
                    newRole = cashier.role === 'tresorier' ? 'tresorier' : 'vendeur';
                  }}
                  disabled={busy}
                  class="border-cn-border text-text-main hover:bg-cn-bg rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                >
                  {m.asso_lydia_cashier_change_role_button()}
                </button>
              {/if}
              {#if row.canRevokeCurrent}
                <button
                  type="button"
                  onclick={() => void revoke(cashier, 'current')}
                  disabled={busy}
                  class="border-red-err/30 text-red-err hover:bg-red-err/10 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                >
                  {m.asso_lydia_cashier_revoke_button()}
                </button>
              {/if}
              {#if row.canRevokePrevious}
                <button
                  type="button"
                  onclick={() => void revoke(cashier, 'previous')}
                  disabled={busy}
                  class="border-red-err/30 text-red-err hover:bg-red-err/10 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                >
                  {m.asso_lydia_cashier_revoke_previous_button()}
                </button>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>

    {#if view.canAdd}
      {#if adding}
        <div class="space-y-3">
          {#if membersFailed}
            <p class="text-red-err text-sm" role="alert">{m.asso_lydia_resp_members_error()}</p>
          {:else if members.length === 0}
            <p class="text-text-muted text-sm">{m.asso_lydia_resp_members_empty()}</p>
          {:else}
            <div>
              <label for="lydia-cashier-member" class={CONTROL_LABEL_CLASS}>
                {m.asso_lydia_resp_member_label()}
              </label>
              <select
                id="lydia-cashier-member"
                bind:value={addUserId}
                disabled={busy}
                class={controlClass()}
              >
                {#each members as member (member.userId)}
                  <option value={member.userId}>{memberLabel(member)}</option>
                {/each}
              </select>
            </div>
          {/if}
          <div>
            <label for="lydia-cashier-add-role" class={CONTROL_LABEL_CLASS}>
              {m.asso_lydia_cashier_role_label()}
            </label>
            <select
              id="lydia-cashier-add-role"
              bind:value={addRole}
              disabled={busy}
              class={controlClass()}
            >
              {#each LYDIA_ADDABLE_CASHIER_ROLES as role (role)}
                <option value={role}>{roleName(role)} - {roleHint(role)}</option>
              {/each}
            </select>
          </div>
          <Input
            label={m.asso_lydia_cashier_phone_label()}
            type="tel"
            inputmode="tel"
            autocomplete="tel"
            placeholder={m.asso_lydia_resp_phone_placeholder()}
            bind:value={addPhone}
            error={addPhoneError}
            disabled={busy}
          />
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              onclick={() => void submitAdd()}
              disabled={busy || !addPhone.trim() || !addUserId}
              class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-5 py-2.5 text-sm font-bold shadow-sm disabled:opacity-50"
            >
              {busy ? m.asso_lydia_cashier_working() : m.asso_lydia_cashier_add_submit()}
            </button>
            <button
              type="button"
              onclick={() => (adding = false)}
              disabled={busy}
              class="border-cn-border text-text-main hover:bg-cn-bg rounded-xl border px-4 py-2.5 text-sm font-semibold"
            >
              {m.asso_lydia_cashier_cancel()}
            </button>
          </div>
        </div>
      {:else}
        <button
          type="button"
          onclick={openAdd}
          disabled={busy}
          class="border-cn-border text-text-main hover:bg-cn-bg rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        >
          {m.asso_lydia_cashier_add_button()}
        </button>
      {/if}
    {/if}

    {#if notice}
      <p class="text-green-ok text-xs" role="status">{notice}</p>
    {/if}
    {#if error}
      <p class="text-red-err text-sm" role="alert">{error}</p>
    {/if}
  </section>
{/if}
