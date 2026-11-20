<script lang="ts">
  import { intlLocale } from '$lib/utils/intlLocale';
  import Button from '$lib/components/ui/Button.svelte';
  import {
    addLydiaCashier,
    changeLydiaCashierRole,
    handOverLydiaResponsable,
    listMembers,
    revokeLydiaCashier,
    type AssociationMember,
    type AssociationPayoutAccount,
    type LydiaAddableCashierRole,
    type LydiaCashier,
    type LydiaCashierRole,
  } from '$lib/associations/api';
  import {
    LYDIA_ADDABLE_CASHIER_ROLES,
    addableMembers,
    handoverConfirmText,
    handoverDoneText,
    handoverHeirs,
    lydiaCashiersView,
  } from '$lib/associations/lydiaCashiers';
  import {
    lydiaCashierErrorText,
    lydiaHandoverErrorText,
  } from '$lib/associations/lydiaCashierRefusal';
  import { currentUserId, isGlobalAdmin } from '$lib/stores/user';
  import { toE164Phone } from '$lib/associations/lydiaPhone';
  import { LYDIA_PRO_HELP_ROUTE } from '$lib/posts/notificationTarget';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Select from '$lib/components/ui/Select.svelte';
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

  const view = $derived(
    lydiaCashiersView(account, undefined, {
      userId: currentUserId(),
      globalAdmin: isGlobalAdmin(),
    })
  );

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

  /** The Responsable row being handed over, and the heir and number picked (owner, 2026-11-19). */
  let handoverFor = $state<string | null>(null);
  let handoverUserId = $state('');
  let handoverPhone = $state('');
  let handoverPhoneError = $state('');

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
    return new Date(iso).toLocaleDateString(intlLocale());
  }

  /** The label a roster row is picked by. */
  function memberLabel(member: AssociationMember): string {
    const full = [member.firstName, member.lastName].filter(Boolean).join(' ');
    return member.displayName || full || member.userId;
  }

  /**
   * Reads the roster once and keeps whom the form offers (`addableMembers` for the add,
   * `handoverHeirs` for the hand-over); `pick` receives the first one.
   */
  function loadPickableMembers(
    offered: (rows: AssociationMember[]) => AssociationMember[],
    pick: (userId: string) => void
  ) {
    membersFailed = false;
    void listMembers(associationId)
      .then((rows) => {
        members = offered(rows);
        pick(members[0]?.userId ?? '');
      })
      .catch((err) => {
        console.error('[Lydia] Cashier roster read failed:', err);
        membersFailed = true;
      });
  }

  /** Opens the add form. */
  function openAdd() {
    adding = true;
    handoverFor = null;
    error = '';
    notice = '';
    loadPickableMembers(
      (rows) => addableMembers(rows, account),
      (userId) => (addUserId = userId)
    );
  }

  /** Opens the hand-over form under the Responsable's row. */
  function openHandover(cashier: LydiaCashier) {
    console.debug('[Lydia] Hand-over form opened');
    handoverFor = cashier.id;
    adding = false;
    roleFor = null;
    handoverPhone = '';
    handoverPhoneError = '';
    error = '';
    notice = '';
    loadPickableMembers(
      (rows) => handoverHeirs(rows, account, cashier.userId),
      (userId) => (handoverUserId = userId)
    );
  }

  /**
   * Hands the role over once the consequence is confirmed: the heir becomes Responsable, the
   * current number loses its Lydia rights. The server adds first and removes second.
   */
  async function submitHandover(responsable: LydiaCashier) {
    handoverPhoneError = '';
    const e164 = toE164Phone(handoverPhone);
    if (!e164) {
      console.debug('[Lydia] Hand-over phone refused client-side');
      handoverPhoneError = m.asso_lydia_resp_phone_format_error();
      return;
    }
    const heir = members.find((member) => member.userId === handoverUserId);
    if (!heir) {
      // The picker only offers listed members: a pick missing from the list means the roster
      // changed under the form, and saying nothing would leave the button dead.
      Log.w('lydia-cashiers', 'hand-over: the picked member is not in the roster', handoverUserId);
      return;
    }
    const heirName = memberLabel(heir);
    const self = currentUserId() === responsable.userId;
    if (
      !(await showConfirm(handoverConfirmText(heirName, responsable.phoneEnd, self), {
        danger: true,
        confirmLabel: m.asso_lydia_handover_button(),
      }))
    )
      return;
    busy = true;
    error = '';
    notice = '';
    try {
      console.debug('[Lydia] Hand-over asked', { self });
      const done = await handOverLydiaResponsable(associationId, {
        userId: heir.userId,
        phone: e164,
      });
      notice = handoverDoneText(heirName, done.previousNumberRemoved);
      handoverFor = null;
    } catch (err) {
      console.error('[Lydia] Hand-over refused:', err);
      error = lydiaHandoverErrorText(err);
    } finally {
      busy = false;
      await reload();
    }
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
      class="text-text-main flex items-center gap-2 text-base font-bold"
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
          {#if row.departed === 'responsable'}
            <p class="text-red-err text-xs" role="status">
              {m.asso_lydia_cashier_responsable_departed()}
            </p>
          {:else if row.departed === 'cashier'}
            <p class="text-amber-warn-text text-xs" role="status">
              {m.asso_lydia_cashier_departed()}
            </p>
          {:else if row.withoutPayout}
            <p class="text-amber-warn-text text-xs" role="status">
              {m.asso_lydia_cashier_responsable_no_payout()}
            </p>
          {/if}
          {#if cashier.state === 'unconfirmed'}
            <p class="text-amber-warn-text text-xs" role="status">
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

          {#if handoverFor === cashier.id}
            <div class="space-y-3">
              <p class="text-text-muted text-xs">{m.asso_lydia_handover_hint()}</p>
              {#if membersFailed}
                <p class="text-red-err text-sm" role="alert">{m.asso_lydia_resp_members_error()}</p>
              {:else if members.length === 0}
                <p class="text-text-muted text-sm">{m.asso_lydia_handover_members_empty()}</p>
              {:else}
                <Select
                  id="lydia-handover-member"
                  label={m.asso_lydia_handover_member_label()}
                  value={handoverUserId}
                  options={members.map((member) => ({
                    value: member.userId,
                    label: memberLabel(member),
                  }))}
                  disabled={busy}
                  onValueChange={(userId) => (handoverUserId = userId)}
                />
              {/if}
              <Input
                label={m.asso_lydia_handover_phone_label()}
                type="tel"
                inputmode="tel"
                autocomplete="off"
                placeholder={m.asso_lydia_resp_phone_placeholder()}
                bind:value={handoverPhone}
                error={handoverPhoneError}
                disabled={busy}
              />
              <div class="flex flex-wrap gap-2">
                <Button
                  size="compact"
                  onclick={() => void submitHandover(cashier)}
                  disabled={busy || !handoverPhone.trim() || !handoverUserId}
                >
                  {busy ? m.asso_lydia_cashier_working() : m.asso_lydia_handover_submit()}
                </Button>
                <Button
                  variant="secondary"
                  size="compact"
                  onclick={() => (handoverFor = null)}
                  disabled={busy}
                >
                  {m.asso_lydia_cashier_cancel()}
                </Button>
              </div>
            </div>
          {:else if roleFor === cashier.id}
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
                <Button
                  size="compact"
                  onclick={() => void submitRole(cashier)}
                  disabled={busy || newRole === cashier.role}
                >
                  {busy
                    ? m.asso_lydia_cashier_working()
                    : m.asso_lydia_cashier_change_role_submit()}
                </Button>
                <Button
                  variant="secondary"
                  size="compact"
                  onclick={() => (roleFor = null)}
                  disabled={busy}
                >
                  {m.asso_lydia_cashier_cancel()}
                </Button>
              </div>
            </div>
          {:else}
            <div class="flex flex-wrap gap-2">
              {#if row.canHandOver}
                <Button
                  variant="secondary"
                  size="compact"
                  onclick={() => openHandover(cashier)}
                  disabled={busy}
                >
                  {m.asso_lydia_handover_button()}
                </Button>
              {/if}
              {#if row.canChangeRole}
                <Button
                  variant="secondary"
                  size="compact"
                  onclick={() => {
                    roleFor = cashier.id;
                    newRole = cashier.role === 'tresorier' ? 'tresorier' : 'vendeur';
                  }}
                  disabled={busy}
                >
                  {m.asso_lydia_cashier_change_role_button()}
                </Button>
              {/if}
              {#if row.canRevokeCurrent}
                <Button
                  variant="danger-outline"
                  size="compact"
                  onclick={() => void revoke(cashier, 'current')}
                  disabled={busy}
                >
                  {m.asso_lydia_cashier_revoke_button()}
                </Button>
              {/if}
              {#if row.canRevokePrevious}
                <Button
                  variant="danger-outline"
                  size="compact"
                  onclick={() => void revoke(cashier, 'previous')}
                  disabled={busy}
                >
                  {m.asso_lydia_cashier_revoke_previous_button()}
                </Button>
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
            <Button
              onclick={() => void submitAdd()}
              disabled={busy || !addPhone.trim() || !addUserId}
            >
              {busy ? m.asso_lydia_cashier_working() : m.asso_lydia_cashier_add_submit()}
            </Button>
            <Button variant="secondary" onclick={() => (adding = false)} disabled={busy}>
              {m.asso_lydia_cashier_cancel()}
            </Button>
          </div>
        </div>
      {:else}
        <Button variant="secondary" size="compact" onclick={openAdd} disabled={busy}>
          {m.asso_lydia_cashier_add_button()}
        </Button>
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
