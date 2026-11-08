<script lang="ts">
  /**
   * The community's own names for its three roles - one field per role, administrators only (the
   * caller mounts it only when the server said `viewerCanManage`, and the server refuses anyone
   * else). LABELS ONLY: the roles, their permissions and who holds them are not touched here.
   *
   * An empty field is "no name of its own" and saves as a reset: the role shows its localized
   * default again (`resolveRoleLabel`). The field's placeholder IS that default, so the effect of
   * clearing it is visible before it is saved.
   */
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';
  import {
    MAX_ROLE_LABEL_LENGTH,
    canonicalRoleOf,
    defaultRoleLabel,
  } from '$lib/utils/chat/communityRoleLabel';
  import { describeCommunityRefusal } from '$lib/utils/chat/communityErrors';
  import { refusalCode } from '$lib/utils/apiRefusal';

  interface RoleRow {
    id: string;
    /** The role's identity: only used to find its default name, never shown. */
    name: string;
    priority: number;
    /** The community's own name for it, or null. */
    label: string | null;
  }

  interface Props {
    roles: RoleRow[];
    /** Sends one role's name (null resets it); rejects with the API refusal on failure. */
    onSave: (roleId: string, label: string | null) => Promise<unknown>;
  }

  let { roles, onSave }: Props = $props();

  const sorted = $derived([...roles].sort((a, b) => b.priority - a.priority));

  /** What each field holds while it is being edited; absent = show the saved name. */
  let drafts = $state<Record<string, string>>({});
  let saving = $state<Record<string, boolean>>({});
  let errors = $state<Record<string, string>>({});

  /** Characters a person sees (code points), the unit the server bounds a name in. */
  const lengthOf = (text: string) => Array.from(text.trim()).length;
  const tooLong = (role: RoleRow) => lengthOf(valueOf(role)) > MAX_ROLE_LABEL_LENGTH;

  const valueOf = (role: RoleRow) => drafts[role.id] ?? role.label ?? '';
  const isDirty = (role: RoleRow) =>
    (drafts[role.id]?.trim() ?? role.label ?? '') !== (role.label ?? '');

  async function save(role: RoleRow, next: string | null) {
    Log.d('CommunityRoleNames.save', { roleId: role.id, reset: next === null });
    saving = { ...saving, [role.id]: true };
    errors = { ...errors, [role.id]: '' };
    try {
      await onSave(role.id, next);
      // The saved name reaches the store from the caller's answer and the announcement alike (the
      // same value, so applying both is idempotent); the draft is dropped either way.
      const { [role.id]: _gone, ...rest } = drafts;
      drafts = rest;
    } catch (e) {
      Log.d('CommunityRoleNames.save failed', e);
      errors = {
        ...errors,
        [role.id]: describeCommunityRefusal(refusalCode(e)) ?? m.common_save_error(),
      };
    } finally {
      saving = { ...saving, [role.id]: false };
    }
  }
</script>

<div class="border-cn-border bg-cn-surface space-y-4 rounded-xl border p-4 shadow-sm">
  <div>
    <h3 class="text-text-main text-sm font-bold">{m.chat_role_names_title()}</h3>
    <p class="text-text-muted mt-1 text-sm">{m.chat_role_names_description()}</p>
  </div>
  {#each sorted as role (role.id)}
    {@const canonical = canonicalRoleOf(role.name)}
    <div class="space-y-2" data-testid="role-name-row">
      <Input
        label={m.chat_role_name_input_label({ role: defaultRoleLabel(canonical) })}
        value={valueOf(role)}
        placeholder={defaultRoleLabel(canonical)}
        disabled={saving[role.id]}
        invalid={tooLong(role)}
        error={errors[role.id] || (tooLong(role) ? m.chat_role_name_invalid_error() : '')}
        oninput={(e) => (drafts = { ...drafts, [role.id]: e.currentTarget.value })}
      />
      <div class="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={!isDirty(role) || tooLong(role) || saving[role.id]}
          loading={saving[role.id]}
          onclick={() => void save(role, drafts[role.id]?.trim() ? drafts[role.id].trim() : null)}
        >
          {m.common_save_button()}
        </Button>
        {#if role.label}
          <Button variant="ghost" disabled={saving[role.id]} onclick={() => void save(role, null)}>
            {m.chat_role_name_reset_button()}
          </Button>
        {/if}
      </div>
    </div>
  {/each}
</div>
