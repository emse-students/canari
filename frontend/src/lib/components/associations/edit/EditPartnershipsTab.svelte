<script lang="ts">
  import { onMount } from 'svelte';
  import {
    listAssociationPartnershipsForManage,
    createPartnershipCard,
    updatePartnershipCard,
    deletePartnershipCard,
    addPartnershipCodes,
    listPartnershipClaims,
    uploadPartnershipIcon,
    deletePartnershipIcon,
    type Association,
    type ManagedPartnershipCard,
    type PartnershipClaimMode,
    type PartnershipClaimRow,
  } from '$lib/associations/api';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { Plus, Trash2, ChevronDown, Handshake } from '@lucide/svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import CardTile from '$lib/components/shared/CardTile.svelte';
  import CardIconEditor from '$lib/components/shared/CardIconEditor.svelte';
  import { PARTNERSHIP_FALLBACK_ICON } from '$lib/utils/cardIcons';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    asso: Association;
  }

  let { asso }: Props = $props();

  let cards = $state<ManagedPartnershipCard[]>([]);
  let cardsLoading = $state(false);
  let cardsError = $state('');
  let showForm = $state(false);
  let saving = $state(false);

  let newTitle = $state('');
  let newDescription = $state('');
  let newLink = $state('');
  let newClaimMode = $state<PartnershipClaimMode>('code_pool');
  let newSharedCode = $state('');
  let newStaticText = $state('');
  let newMembersOnly = $state(false);

  let expandedCardId = $state<string | null>(null);
  let codesPaste = $state('');
  let savingCodes = $state<string | null>(null);
  let claimsByCard = $state<Record<string, PartnershipClaimRow[]>>({});
  let claimsLoading = $state<string | null>(null);

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

  function resetForm() {
    newTitle = '';
    newDescription = '';
    newLink = '';
    newClaimMode = 'code_pool';
    newSharedCode = '';
    newStaticText = '';
    newMembersOnly = false;
    showForm = false;
  }

  async function handleCreate() {
    if (!newTitle.trim()) return;
    saving = true;
    cardsError = '';
    try {
      await createPartnershipCard(asso.id, {
        title: newTitle.trim(),
        description: newDescription.trim() || undefined,
        link: newLink.trim() || undefined,
        claimMode: newClaimMode,
        sharedCode: newClaimMode === 'shared_code' ? newSharedCode.trim() : undefined,
        staticText: newClaimMode === 'text' ? newStaticText.trim() : undefined,
        membersOnly: newMembersOnly,
      });
      resetForm();
      await loadCards();
    } catch (e) {
      cardsError = e instanceof Error ? e.message : 'Error';
    } finally {
      saving = false;
    }
  }

  async function handleToggleActive(card: ManagedPartnershipCard) {
    try {
      await updatePartnershipCard(asso.id, card.id, { isActive: !card.isActive });
      cards = cards.map((c) => (c.id === card.id ? { ...c, isActive: !card.isActive } : c));
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
    } catch (e) {
      cardsError = e instanceof Error ? e.message : 'Error';
    }
  }

  async function toggleExpanded(card: ManagedPartnershipCard) {
    if (expandedCardId === card.id) {
      expandedCardId = null;
      return;
    }
    expandedCardId = card.id;
    codesPaste = '';
    if (!claimsByCard[card.id]) {
      claimsLoading = card.id;
      try {
        claimsByCard = {
          ...claimsByCard,
          [card.id]: await listPartnershipClaims(asso.id, card.id),
        };
      } catch (e) {
        cardsError = e instanceof Error ? e.message : 'Error';
      } finally {
        claimsLoading = null;
      }
    }
  }

  async function handleAddCodes(card: ManagedPartnershipCard) {
    const codes = codesPaste
      .split('\n')
      .map((c) => c.trim())
      .filter(Boolean);
    if (codes.length === 0) return;
    savingCodes = card.id;
    cardsError = '';
    try {
      const { totalCodes } = await addPartnershipCodes(asso.id, card.id, codes);
      cards = cards.map((c) => (c.id === card.id ? { ...c, totalCodes } : c));
      codesPaste = '';
    } catch (e) {
      cardsError = e instanceof Error ? e.message : 'Error';
    } finally {
      savingCodes = null;
    }
  }

  async function handleUploadCardIcon(card: ManagedPartnershipCard, file: File) {
    const updated = await uploadPartnershipIcon(asso.id, card.id, file);
    cards = cards.map((c) => (c.id === card.id ? { ...c, ...updated } : c));
  }

  async function handleRemoveCardIcon(card: ManagedPartnershipCard) {
    const updated = await deletePartnershipIcon(asso.id, card.id);
    cards = cards.map((c) => (c.id === card.id ? { ...c, ...updated } : c));
  }

  function modeLabel(mode: PartnershipClaimMode): string {
    return mode === 'code_pool'
      ? m.asso_partnership_mode_code_pool()
      : mode === 'shared_code'
        ? m.asso_partnership_mode_shared_code()
        : m.asso_partnership_mode_text();
  }
</script>

<div class="border-cn-border space-y-6 rounded-2xl border bg-(--cn-surface)/95 p-6 shadow-sm">
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
      onclick={() => (showForm = !showForm)}
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

  {#if showForm}
    <form
      class="border-cn-border bg-cn-bg/40 space-y-4 rounded-xl border p-5"
      onsubmit={(e) => {
        e.preventDefault();
        void handleCreate();
      }}
    >
      <h3 class="text-text-main text-sm font-bold">{m.asso_partnership_form_title()}</h3>

      <div class="space-y-1">
        <label for="new-partnership-title" class="text-text-muted text-xs font-semibold"
          >{m.asso_partnership_title_label()}</label
        >
        <input
          id="new-partnership-title"
          type="text"
          bind:value={newTitle}
          required
          class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
        />
      </div>

      <Textarea
        id="new-partnership-description"
        bind:value={newDescription}
        rows={2}
        label={m.asso_partnership_description_label()}
      />

      <div class="space-y-1">
        <label for="new-partnership-link" class="text-text-muted text-xs font-semibold"
          >{m.asso_partnership_link_label()}</label
        >
        <input
          id="new-partnership-link"
          type="url"
          bind:value={newLink}
          placeholder={m.asso_partnership_link_placeholder()}
          class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
        />
      </div>

      <div class="space-y-1">
        <span class="text-text-muted text-xs font-semibold">{m.asso_partnership_mode_label()}</span>
        <div class="flex flex-wrap gap-3">
          {#each [['code_pool', m.asso_partnership_mode_code_pool()], ['shared_code', m.asso_partnership_mode_shared_code()], ['text', m.asso_partnership_mode_text()]] as [value, label] (value)}
            <label class="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="claimMode"
                {value}
                checked={newClaimMode === value}
                onchange={() => (newClaimMode = value as PartnershipClaimMode)}
              />
              {label}
            </label>
          {/each}
        </div>
      </div>

      {#if newClaimMode === 'shared_code'}
        <div class="space-y-1">
          <label for="new-partnership-shared-code" class="text-text-muted text-xs font-semibold"
            >{m.asso_partnership_shared_code_label()}</label
          >
          <input
            id="new-partnership-shared-code"
            type="text"
            bind:value={newSharedCode}
            required
            class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
          />
        </div>
      {:else if newClaimMode === 'text'}
        <Textarea
          id="new-partnership-static-text"
          bind:value={newStaticText}
          rows={2}
          label={m.asso_partnership_static_text_label()}
        />
      {:else}
        <p class="text-text-muted text-xs">{m.asso_partnership_codes_after_create_hint()}</p>
      {/if}

      <label class="flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" bind:checked={newMembersOnly} class="rounded" />
        {m.asso_partnership_members_only_label()}
      </label>

      <div class="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={saving ||
            !newTitle.trim() ||
            (newClaimMode === 'shared_code' && !newSharedCode.trim()) ||
            (newClaimMode === 'text' && !newStaticText.trim())}
          class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-5 py-2.5 text-sm font-bold disabled:opacity-50"
        >
          {saving ? m.asso_partnership_creating() : m.asso_partnership_create_button()}
        </button>
        <button
          type="button"
          onclick={resetForm}
          class="text-text-muted hover:text-text-main text-sm">{m.common_cancel_button()}</button
        >
      </div>
    </form>
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
        <li class={expandedCardId === card.id ? 'sm:col-span-2' : ''}>
          <CardTile iconUrl={card.iconUrl} fallbackIcon={PARTNERSHIP_FALLBACK_ICON}>
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
                  onclick={() => toggleExpanded(card)}
                  class="border-cn-border inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors hover:bg-(--cn-surface)"
                >
                  {card.claimMode === 'code_pool'
                    ? m.asso_partnership_codes_button()
                    : m.asso_partnership_icon_button()}
                  <ChevronDown
                    size={12}
                    class="transition-transform {expandedCardId === card.id ? 'rotate-180' : ''}"
                  />
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
                  class="border-red-err/30 bg-red-err/10 text-red-err hover:bg-red-err/20 ml-auto inline-flex items-center justify-center rounded-xl border p-2 transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            {#if expandedCardId === card.id}
              <div class="border-cn-border/60 bg-cn-bg/20 space-y-4 border-t px-4 py-3">
                <CardIconEditor
                  iconUrl={card.iconUrl}
                  fallbackIcon={PARTNERSHIP_FALLBACK_ICON}
                  onUpload={(file) => handleUploadCardIcon(card, file)}
                  onRemove={() => handleRemoveCardIcon(card)}
                />

                {#if card.claimMode === 'code_pool'}
                  <div class="space-y-2">
                    <Textarea
                      id="codes-paste-{card.id}"
                      bind:value={codesPaste}
                      rows={4}
                      label={m.asso_partnership_codes_paste_label()}
                      placeholder={m.asso_partnership_codes_paste_placeholder()}
                    />
                    <button
                      type="button"
                      onclick={() => handleAddCodes(card)}
                      disabled={savingCodes === card.id || !codesPaste.trim()}
                      class="bg-cn-yellow text-cn-ink rounded-lg px-4 py-2 text-xs font-bold disabled:opacity-50"
                    >
                      {m.asso_partnership_codes_add_button()}
                    </button>
                  </div>

                  <div class="space-y-1">
                    <p class="text-text-main text-xs font-bold tracking-wide uppercase">
                      {m.asso_partnership_claims_title()}
                    </p>
                    {#if claimsLoading === card.id}
                      <p class="text-text-muted text-xs">{m.asso_partnership_claims_loading()}</p>
                    {:else if (claimsByCard[card.id] ?? []).length === 0}
                      <p class="text-text-muted text-xs">{m.asso_partnership_claims_empty()}</p>
                    {:else}
                      <ul class="space-y-1">
                        {#each claimsByCard[card.id] as claim (claim.userId)}
                          <li class="text-text-muted flex items-center justify-between text-xs">
                            <span>{claim.firstName ?? ''} {claim.lastName ?? ''}</span>
                            <span class="font-mono">{claim.code}</span>
                          </li>
                        {/each}
                      </ul>
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}
          </CardTile>
        </li>
      {/each}
    </ul>
  {/if}
</div>
