<script lang="ts">
  /**
   * The partnerships an association offers, and the ONE place they are created and changed.
   *
   * WHAT THIS USED TO BE, and why it was reported (user, 2026-09-10: *"pas tres intuitive, et qui
   * ne permet pas d'editer un partenariat"*). Creating one was a flat form over eight fields.
   * Changing one afterwards was a toggle button, a chevron whose LABEL changed meaning by mode,
   * and a one-field badge form buried inside the expander - three fields between them. The other
   * six were settable once and frozen for ever, so fixing a typo in a title meant deleting the
   * partnership and recreating it, which destroys the claim ledger with it.
   *
   * THE FORM IS `PartnershipEditor` AND IT IS THE SAME COMPONENT IN BOTH FLOWS. This file is now
   * the LIST: what exists, what state each one is in, and the three list-level actions - edit,
   * activate/deactivate, delete. Anything that edits a field lives in the editor, once.
   */
  import { onMount } from 'svelte';
  import {
    listAssociationPartnershipsForManage,
    updatePartnershipCard,
    deletePartnershipCard,
    type Association,
    type ManagedPartnershipCard,
    type PartnershipClaimMode,
  } from '$lib/associations/api';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { Plus, Trash2, Pencil, Handshake } from '@lucide/svelte';
  import CardTile from '$lib/components/shared/CardTile.svelte';
  import PartnershipEditor from './PartnershipEditor.svelte';
  import { PARTNERSHIP_FALLBACK_ICON } from '$lib/utils/cardIcons';
  import { generateAvatarColor } from '$lib/utils/avatar';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    asso: Association;
  }

  let { asso }: Props = $props();

  /** Card accent color - the association's own, or a deterministic fallback when unset. */
  const cardAccentColor = $derived(asso.color ?? generateAvatarColor(asso.name));

  let cards = $state<ManagedPartnershipCard[]>([]);
  let cardsLoading = $state(false);
  let cardsError = $state('');

  /**
   * Which card the editor is open on: a card id, `'new'`, or `null` for closed.
   *
   * ONE piece of state for both flows, because they are one flow. It is a card ID rather than the
   * card object so that a save which replaces the object in `cards` does not close the editor -
   * which is what lets a CREATE hand straight over to editing the card it just made.
   */
  let editing = $state<string | null>(null);
  const editingCard = $derived(
    editing === null || editing === 'new' ? null : (cards.find((c) => c.id === editing) ?? null)
  );

  onMount(loadCards);

  async function loadCards() {
    cardsLoading = true;
    cardsError = '';
    try {
      cards = await listAssociationPartnershipsForManage(asso.id);
    } catch (e) {
      cardsError = e instanceof Error ? e.message : 'Error';
    } finally {
      cardsLoading = false;
    }
  }

  /** Every write the editor makes lands here, so the list never re-fetches to stay honest. */
  function handleSaved(card: ManagedPartnershipCard, created: boolean) {
    cards = created ? [...cards, card] : cards.map((c) => (c.id === card.id ? card : c));
    // The editor stays open on the new card: the icon and the codes need it to exist, and sending
    // the user back to the list to find what they just made is the second journey this removes.
    if (created) editing = card.id;
  }

  /**
   * The list-level shortcut for hiding an offer, which the editor also carries.
   *
   * TWO TRIGGERS, ONE WRITE - not two implementations. Hiding an expired offer fast is a real need
   * and does not deserve opening a form, while an editor that omitted the field would be the same
   * "where do I change this" the rest of this change removes.
   */
  async function handleToggleActive(card: ManagedPartnershipCard) {
    try {
      const updated = await updatePartnershipCard(asso.id, card.id, { isActive: !card.isActive });
      cards = cards.map((c) => (c.id === card.id ? { ...c, ...updated } : c));
    } catch (e) {
      cardsError = e instanceof Error ? e.message : 'Error';
    }
  }

  async function handleDelete(card: ManagedPartnershipCard) {
    if (
      !(await showConfirm(m.asso_partnership_delete_confirm({ title: card.title }), {
        danger: true,
        confirmLabel: m.common_delete_button(),
      }))
    )
      return;
    try {
      await deletePartnershipCard(asso.id, card.id);
      cards = cards.filter((c) => c.id !== card.id);
      if (editing === card.id) editing = null;
    } catch (e) {
      cardsError = e instanceof Error ? e.message : 'Error';
    }
  }

  function modeLabel(mode: PartnershipClaimMode): string {
    return mode === 'code_pool'
      ? m.asso_partnership_mode_code_pool()
      : mode === 'shared_code'
        ? m.asso_partnership_mode_shared_code()
        : m.asso_partnership_mode_text();
  }
</script>

<div class="border-cn-border bg-cn-surface space-y-6 rounded-2xl border p-6 shadow-sm">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div>
      <h2 class="text-text-main flex items-center gap-2 text-lg font-bold tracking-tight">
        <Handshake size={20} />
        {m.asso_partnership_title()}
      </h2>
      <p class="text-text-muted mt-1 text-sm">
        {m.asso_partnership_subtitle()}
      </p>
    </div>
    <button
      type="button"
      onclick={() => (editing = editing === 'new' ? null : 'new')}
      class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold transition-colors"
    >
      <Plus size={16} />
      {m.asso_partnership_new_button()}
    </button>
  </div>

  {#if cardsError}
    <div class="border-red-err/30 bg-red-err/10 text-red-err rounded-xl border px-4 py-3 text-sm">
      {cardsError}
    </div>
  {/if}

  <!-- Keyed on the identity being edited, so switching cards reseeds the form rather than
       carrying the previous card's values into it. -->
  {#if editing !== null}
    {#key editing}
      <PartnershipEditor
        {asso}
        card={editingCard}
        onSaved={handleSaved}
        onClose={() => (editing = null)}
      />
    {/key}
  {/if}

  {#if cardsLoading}
    <div class="flex justify-center py-6">
      <div
        class="border-cn-yellow h-6 w-6 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else if cards.length === 0}
    <p class="text-text-muted py-6 text-center text-sm">{m.asso_partnership_no_partnerships()}</p>
  {:else}
    <ul class="grid gap-4 sm:grid-cols-2">
      {#each cards as card (card.id)}
        <li>
          <CardTile
            iconUrl={card.iconUrl}
            fallbackIcon={PARTNERSHIP_FALLBACK_ICON}
            accentColor={cardAccentColor}
            badgeText={card.badgeText}
          >
            <div class="flex flex-col gap-3 p-4">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <p class="text-text-main text-sm font-semibold">{card.title}</p>
                  <span
                    class="rounded-full px-2 py-0.5 text-xs font-semibold {card.isActive
                      ? 'bg-green-ok/15 text-green-ok'
                      : 'bg-cn-surface-alt text-text-muted'}"
                  >
                    {card.isActive
                      ? m.asso_partnership_status_active()
                      : m.asso_partnership_status_inactive()}
                  </span>
                  {#if card.membersOnly}
                    <span
                      class="bg-amber-warn/15 text-amber-warn rounded-full px-2 py-0.5 text-xs font-semibold"
                    >
                      {m.asso_partnership_members_only_label()}
                    </span>
                  {/if}
                </div>
                <p class="text-text-muted mt-0.5 text-xs">
                  {modeLabel(card.claimMode)}
                  {#if card.claimMode === 'code_pool'}
                    · {m.asso_partnership_claimed_count({
                      claimed: card.claimedCount,
                      total: card.totalCodes,
                    })}
                  {/if}
                </p>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onclick={() => (editing = editing === card.id ? null : card.id)}
                  class="border-cn-border inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-(--cn-surface)"
                >
                  <Pencil size={12} />
                  {m.asso_partnership_edit_button()}
                </button>
                <button
                  type="button"
                  onclick={() => handleToggleActive(card)}
                  class="border-cn-border rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-(--cn-surface)"
                >
                  {card.isActive
                    ? m.asso_partnership_deactivate_button()
                    : m.asso_partnership_activate_button()}
                </button>
                <button
                  type="button"
                  onclick={() => handleDelete(card)}
                  title={m.common_delete_button()}
                  class="ui-icon-button border-red-err/30 bg-red-err/10 text-red-err hover:bg-red-err/20 ml-auto rounded-xl border transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          </CardTile>
        </li>
      {/each}
    </ul>
  {/if}
</div>
