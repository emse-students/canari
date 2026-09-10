<script lang="ts">
  /**
   * ONE form for creating a partnership and for editing one.
   *
   * WHY IT EXISTS. The manage screen used to be two different shapes for one object: a flat form
   * that could set eight fields at creation, and - afterwards - a toggle button, a chevron and a
   * one-field badge form scattered across the card, which between them could change three. Title,
   * description, link, shared code, static text and members-only were settable once and then
   * frozen for ever, so a typo in a title meant DELETING the partnership and recreating it, which
   * destroys the claim ledger. Reported by the user, 2026-09-10: *"pas très intuitive, et qui ne
   * permet pas d'éditer un partenariat"*.
   *
   * SO THE RULE HERE IS: every field the API accepts appears in this form, once. A control that
   * exists in only one of the two flows is the defect coming back.
   *
   * THE ONE EXCEPTION IS `claimMode`, AND IT IS THE SERVER'S RULE, NOT A UI SHORTCUT. Changing how
   * a partnership is claimed would strand the claims already made against the old mode, so the
   * backend's update DTO does not accept it. **It is shown read-only with the reason rather than
   * hidden**: a field that silently disappears between the two flows is exactly what made this
   * screen unreadable. Decision recorded with the user, 2026-09-10.
   *
   * THE ICON IS THE OTHER ASYMMETRY, and it is real rather than chosen: an upload needs a card id
   * to attach to, so it cannot happen before the first save. Which is why a successful CREATE does
   * not close this form - it hands it the new card and stays open in edit mode, so the icon and the
   * codes are the next thing in the same place rather than a second journey.
   */
  import {
    createPartnershipCard,
    updatePartnershipCard,
    addPartnershipCodes,
    listPartnershipClaims,
    uploadPartnershipIcon,
    deletePartnershipIcon,
    type Association,
    type ManagedPartnershipCard,
    type PartnershipClaimMode,
    type PartnershipClaimRow,
  } from '$lib/associations/api';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import CardIconEditor from '$lib/components/shared/CardIconEditor.svelte';
  import { PARTNERSHIP_FALLBACK_ICON } from '$lib/utils/cardIcons';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    asso: Association;
    /** The card being edited, or `null` to create one. */
    card: ManagedPartnershipCard | null;
    /** Called after every successful write, with the card as the server now holds it. */
    onSaved: (card: ManagedPartnershipCard, created: boolean) => void;
    onClose: () => void;
  }

  let { asso, card, onSaved, onClose }: Props = $props();

  const isNew = $derived(card === null);

  // The form's own copy. Seeded from the card ONCE per card identity rather than derived, because
  // a derived field would discard what the user is typing every time the parent re-renders.
  let title = $state('');
  let description = $state('');
  let link = $state('');
  let claimMode = $state<PartnershipClaimMode>('code_pool');
  let sharedCode = $state('');
  let staticText = $state('');
  let membersOnly = $state(false);
  let badgeText = $state('');
  let isActive = $state(true);

  let seededFor = $state<string | null>(null);
  $effect(() => {
    const identity = card?.id ?? '__new__';
    if (seededFor === identity) return;
    seededFor = identity;
    title = card?.title ?? '';
    description = card?.description ?? '';
    link = card?.link ?? '';
    claimMode = card?.claimMode ?? 'code_pool';
    sharedCode = card?.sharedCode ?? '';
    staticText = card?.staticText ?? '';
    membersOnly = card?.membersOnly ?? false;
    badgeText = card?.badgeText ?? '';
    isActive = card?.isActive ?? true;
  });

  let saving = $state(false);
  let error = $state('');
  let justCreated = $state(false);

  let codesPaste = $state('');
  let savingCodes = $state(false);
  let claims = $state<PartnershipClaimRow[] | null>(null);
  let claimsLoading = $state(false);

  // The claim ledger is READ-ONLY here and loaded only for the mode that has one. It is in the
  // editor rather than behind a separate chevron because "who took a code" is the question a
  // manager has while looking at the offer, not a separate errand.
  $effect(() => {
    if (!card || card.claimMode !== 'code_pool' || claims !== null || claimsLoading) return;
    claimsLoading = true;
    listPartnershipClaims(asso.id, card.id)
      .then((rows) => (claims = rows))
      .catch((e) => (error = e instanceof Error ? e.message : 'Error'))
      .finally(() => (claimsLoading = false));
  });

  const modeLabel = (mode: PartnershipClaimMode): string =>
    mode === 'code_pool'
      ? m.asso_partnership_mode_code_pool()
      : mode === 'shared_code'
        ? m.asso_partnership_mode_shared_code()
        : m.asso_partnership_mode_text();

  /** The mode-specific field must be filled for the mode that requires one - the server agrees. */
  const incomplete = $derived(
    !title.trim() ||
      (claimMode === 'shared_code' && !sharedCode.trim()) ||
      (claimMode === 'text' && !staticText.trim())
  );

  async function handleSubmit() {
    if (incomplete) return;
    saving = true;
    error = '';
    try {
      const shared = claimMode === 'shared_code' ? sharedCode.trim() : undefined;
      const staticValue = claimMode === 'text' ? staticText.trim() : undefined;
      if (card) {
        // `badgeText` is the one field whose EMPTY value is meaningful - null clears the pill -
        // so it is sent explicitly rather than omitted the way the optional strings are.
        const updated = await updatePartnershipCard(asso.id, card.id, {
          title: title.trim(),
          description: description.trim() || undefined,
          link: link.trim() || undefined,
          sharedCode: shared,
          staticText: staticValue,
          membersOnly,
          isActive,
          badgeText: badgeText.trim() || null,
        });
        onSaved({ ...card, ...updated }, false);
      } else {
        const created = await createPartnershipCard(asso.id, {
          title: title.trim(),
          description: description.trim() || undefined,
          link: link.trim() || undefined,
          claimMode,
          sharedCode: shared,
          staticText: staticValue,
          membersOnly,
          badgeText: badgeText.trim() || undefined,
        });
        justCreated = true;
        // A fresh card has no codes and no claims yet, and the list endpoint is what carries those
        // counters - so they are stated here rather than left undefined.
        onSaved({ ...created, claimedCount: 0, totalCodes: 0 }, true);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Error';
    } finally {
      saving = false;
    }
  }

  async function handleAddCodes() {
    if (!card) return;
    const codes = codesPaste
      .split('\n')
      .map((c) => c.trim())
      .filter(Boolean);
    if (codes.length === 0) return;
    savingCodes = true;
    error = '';
    try {
      const { totalCodes } = await addPartnershipCodes(asso.id, card.id, codes);
      codesPaste = '';
      onSaved({ ...card, totalCodes }, false);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Error';
    } finally {
      savingCodes = false;
    }
  }

  async function handleUploadIcon(file: File) {
    if (!card) return;
    onSaved({ ...card, ...(await uploadPartnershipIcon(asso.id, card.id, file)) }, false);
  }

  async function handleRemoveIcon() {
    if (!card) return;
    onSaved({ ...card, ...(await deletePartnershipIcon(asso.id, card.id)) }, false);
  }
</script>

<form
  class="border-cn-border bg-cn-bg space-y-5 rounded-xl border p-5"
  onsubmit={(e) => {
    e.preventDefault();
    void handleSubmit();
  }}
>
  <h3 class="text-text-main text-sm font-bold">
    {isNew ? m.asso_partnership_form_title() : m.asso_partnership_edit_form_title()}
  </h3>

  {#if justCreated && card}
    <p class="border-green-ok/30 bg-green-ok/10 text-green-ok rounded-xl border px-4 py-3 text-sm">
      {m.asso_partnership_created_continue()}
    </p>
  {/if}

  {#if error}
    <div class="border-red-err/30 bg-red-err/10 text-red-err rounded-xl border px-4 py-3 text-sm">
      {error}
    </div>
  {/if}

  <div class="space-y-1">
    <label for="partnership-title" class="text-text-muted text-xs font-semibold"
      >{m.asso_partnership_title_label()}</label
    >
    <input
      id="partnership-title"
      type="text"
      bind:value={title}
      required
      class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
    />
  </div>

  <Textarea
    id="partnership-description"
    bind:value={description}
    rows={2}
    label={m.asso_partnership_description_label()}
  />

  <div class="space-y-1">
    <label for="partnership-link" class="text-text-muted text-xs font-semibold"
      >{m.asso_partnership_link_label()}</label
    >
    <input
      id="partnership-link"
      type="url"
      bind:value={link}
      placeholder={m.asso_partnership_link_placeholder()}
      class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
    />
  </div>

  <div class="space-y-1">
    <label for="partnership-badge" class="text-text-muted text-xs font-semibold"
      >{m.asso_card_badge_label()}</label
    >
    <input
      id="partnership-badge"
      type="text"
      maxlength="30"
      bind:value={badgeText}
      placeholder={m.asso_card_badge_placeholder()}
      class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
    />
  </div>

  <!-- THE MODE. A choice while creating; a fact, with its reason, once claims can exist. -->
  <div class="space-y-1">
    <span class="text-text-muted text-xs font-semibold">{m.asso_partnership_mode_label()}</span>
    {#if isNew}
      <div class="flex flex-wrap gap-3">
        {#each [['code_pool', m.asso_partnership_mode_code_pool()], ['shared_code', m.asso_partnership_mode_shared_code()], ['text', m.asso_partnership_mode_text()]] as [value, label] (value)}
          <label class="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="radio"
              name="claimMode"
              {value}
              checked={claimMode === value}
              onchange={() => (claimMode = value as PartnershipClaimMode)}
            />
            {label}
          </label>
        {/each}
      </div>
    {:else}
      <p class="text-text-main text-sm">{modeLabel(claimMode)}</p>
      <p class="text-text-muted text-xs">{m.asso_partnership_mode_locked_hint()}</p>
    {/if}
  </div>

  {#if claimMode === 'shared_code'}
    <div class="space-y-1">
      <label for="partnership-shared-code" class="text-text-muted text-xs font-semibold"
        >{m.asso_partnership_shared_code_label()}</label
      >
      <input
        id="partnership-shared-code"
        type="text"
        bind:value={sharedCode}
        required
        class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2 text-sm"
      />
    </div>
  {:else if claimMode === 'text'}
    <Textarea
      id="partnership-static-text"
      bind:value={staticText}
      rows={2}
      label={m.asso_partnership_static_text_label()}
    />
  {/if}

  <label class="flex cursor-pointer items-center gap-2 text-sm">
    <input type="checkbox" bind:checked={membersOnly} class="rounded" />
    {m.asso_partnership_members_only_label()}
  </label>

  {#if !isNew}
    <div class="space-y-1">
      <label class="flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" bind:checked={isActive} class="rounded" />
        {m.asso_partnership_active_label()}
      </label>
      <p class="text-text-muted text-xs">{m.asso_partnership_active_hint()}</p>
    </div>
  {/if}

  <div class="flex items-center gap-3 pt-1">
    <button
      type="submit"
      disabled={saving || incomplete}
      class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-5 py-2.5 text-sm font-bold disabled:opacity-50"
    >
      {#if saving}
        {isNew ? m.asso_partnership_creating() : m.common_saving_label()}
      {:else}
        {isNew ? m.asso_partnership_create_button() : m.common_save_button()}
      {/if}
    </button>
    <button type="button" onclick={onClose} class="text-text-muted hover:text-text-main text-sm">
      {isNew ? m.common_cancel_button() : m.common_close_label()}
    </button>
  </div>

  <!-- WHAT NEEDS THE CARD TO EXIST. Below the save, because that is the order it becomes usable. -->
  {#if card}
    <div class="border-cn-border/60 space-y-5 border-t pt-5">
      <div class="space-y-1">
        <span class="text-text-muted text-xs font-semibold">{m.asso_partnership_icon_label()}</span>
        <CardIconEditor
          iconUrl={card.iconUrl}
          fallbackIcon={PARTNERSHIP_FALLBACK_ICON}
          onUpload={handleUploadIcon}
          onRemove={handleRemoveIcon}
        />
      </div>

      {#if card.claimMode === 'code_pool'}
        <div class="space-y-2">
          <Textarea
            id="partnership-codes-paste"
            bind:value={codesPaste}
            rows={4}
            label={m.asso_partnership_codes_paste_label()}
            placeholder={m.asso_partnership_codes_paste_placeholder()}
          />
          <button
            type="button"
            onclick={() => void handleAddCodes()}
            disabled={savingCodes || !codesPaste.trim()}
            class="bg-cn-yellow text-cn-ink rounded-lg px-4 py-2 text-xs font-bold disabled:opacity-50"
          >
            {m.asso_partnership_codes_add_button()}
          </button>
        </div>

        <div class="space-y-1">
          <p class="text-text-main text-xs font-bold tracking-wide uppercase">
            {m.asso_partnership_claims_title()}
          </p>
          {#if claimsLoading}
            <p class="text-text-muted text-xs">{m.asso_partnership_claims_loading()}</p>
          {:else if (claims ?? []).length === 0}
            <p class="text-text-muted text-xs">{m.asso_partnership_claims_empty()}</p>
          {:else}
            <ul class="space-y-1">
              {#each claims ?? [] as claim (claim.userId)}
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
  {:else}
    <p class="text-text-muted border-cn-border/60 border-t pt-4 text-xs">
      {m.asso_partnership_icon_after_create_hint()}
    </p>
  {/if}
</form>
