<script lang="ts">
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import type { AssociationMember } from '$lib/associations/api';
  import { Trash2 } from '@lucide/svelte';

  /** ALL_CORE_FLAGS = POST_AS_ASSO|PROPOSE_EVENT|MANAGE_MEMBERS|MANAGE_DOCUMENTS|MANAGE_FORMS|MANAGE_PRODUCTS = 287 */
  const ALL_CORE_FLAGS = 287;

  interface Props {
    member: AssociationMember;
    displayName: string;
    /** When true, shows role editor and remove (association admins). */
    manage?: boolean;
    onRoleChange?: (userId: string, role: string, permissions: number) => void | Promise<void>;
    onRemove?: (userId: string) => void | Promise<void>;
  }

  let { member, displayName, manage = false, onRoleChange, onRemove }: Props = $props();

  /** Resolved bitmask for the select: prefer explicit permissions, fall back to isAdmin heuristic. */
  const effectivePermissions = $derived(
    member.permissions !== undefined ? member.permissions : member.isAdmin ? ALL_CORE_FLAGS : 0
  );
</script>

<div
  class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-2xl border border-cn-border/70 bg-cn-bg/40 px-4 py-3 transition-colors hover:bg-cn-bg/60"
>
  <div class="flex items-center gap-3 min-w-0 flex-1">
    <a
      href="/profile/{encodeURIComponent(member.userId)}"
      class="shrink-0 ring-2 ring-transparent hover:ring-cn-yellow/40 rounded-full transition-shadow"
      title="Voir le profil"
    >
      <Avatar userId={member.userId} size="lg" shape="circle" fallbackLabel={displayName} />
    </a>
    <div class="min-w-0">
      <a
        href="/profile/{encodeURIComponent(member.userId)}"
        class="font-semibold text-text-main truncate hover:underline block"
      >
        {displayName}
      </a>
      <div class="flex flex-wrap items-center gap-2 mt-1">
        <span
          class="text-xs font-semibold px-2.5 py-0.5 rounded-full
          {member.isAdmin
            ? 'bg-cn-yellow/25 text-cn-dark dark:text-cn-yellow'
            : 'bg-cn-border/50 text-text-muted'}"
        >
          {member.role}
        </span>
        {#if member.isAdmin}
          <span class="text-[11px] uppercase tracking-wide text-text-muted font-medium">Admin</span>
        {/if}
      </div>
    </div>
  </div>

  {#if manage && onRoleChange && onRemove}
    <div class="flex flex-wrap items-center gap-2 sm:justify-end shrink-0">
      <input
        type="text"
        value={member.role}
        aria-label="Libellé du rôle"
        onchange={(e) =>
          onRoleChange(
            member.userId,
            (e.target as HTMLInputElement).value,
            effectivePermissions
          )}
        class="text-sm rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 w-full sm:w-36"
      />
      <select
        value={effectivePermissions === 0 ? 0 : ALL_CORE_FLAGS}
        aria-label="Niveau d'accès"
        onchange={(e) =>
          onRoleChange(
            member.userId,
            member.role,
            Number((e.target as HTMLSelectElement).value)
          )}
        class="text-sm rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2"
      >
        <option value={0}>Membre</option>
        <option value={ALL_CORE_FLAGS}>Admin</option>
      </select>
      <button
        type="button"
        onclick={() => onRemove(member.userId)}
        class="inline-flex items-center justify-center rounded-xl border border-red-200 bg-red-50/80 p-2 text-red-600 hover:bg-red-100 transition-colors"
        title="Retirer ce membre"
      >
        <Trash2 size={16} />
      </button>
    </div>
  {/if}
</div>
