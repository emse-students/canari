<script lang="ts">
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import type { AssociationMember } from '$lib/associations/api';
  import {
    ALL_CORE_FLAGS,
    AssociationPermissionFlag,
    hasPermissionFlag,
  } from '$lib/associations/api';
  import { Trash2, ChevronDown } from '@lucide/svelte';

  /** Human-readable labels for each permission flag (French). */
  const FLAG_LABELS: { flag: AssociationPermissionFlag; label: string }[] = [
    { flag: AssociationPermissionFlag.POST_AS_ASSO, label: "Publier au nom de l'asso" },
    { flag: AssociationPermissionFlag.PROPOSE_EVENT, label: 'Proposer des événements' },
    { flag: AssociationPermissionFlag.MANAGE_MEMBERS, label: 'Gérer les membres' },
    { flag: AssociationPermissionFlag.MANAGE_DOCUMENTS, label: 'Gérer les documents' },
    { flag: AssociationPermissionFlag.MANAGE_FORMS, label: 'Gérer les formulaires' },
    { flag: AssociationPermissionFlag.MANAGE_PRODUCTS, label: 'Gérer les paiements (boutique)' },
    {
      flag: AssociationPermissionFlag.MANAGE_STRIPE_CONNECT,
      label: 'Gérer Stripe Connect',
    },
    { flag: AssociationPermissionFlag.VALIDATE_EVENTS, label: 'Valider les événements' },
    { flag: AssociationPermissionFlag.CREATE_ASSO, label: 'Créer des associations' },
    { flag: AssociationPermissionFlag.MODERATE, label: 'Modérer' },
  ];

  interface Props {
    member: AssociationMember;
    displayName: string;
    /** When true, shows role editor and remove (association admins). */
    manage?: boolean;
    onRoleChange?: (userId: string, role: string, permissions: number) => void | Promise<void>;
    onRemove?: (userId: string) => void | Promise<void>;
  }

  let { member, displayName, manage = false, onRoleChange, onRemove }: Props = $props();

  /** Resolved bitmask: prefer explicit permissions, fall back to isAdmin heuristic. */
  const effectivePermissions = $derived(
    member.permissions !== undefined ? member.permissions : member.isAdmin ? ALL_CORE_FLAGS : 0
  );

  const permissionsCount = $derived(
    FLAG_LABELS.reduce((n, { flag }) => n + (hasPermissionFlag(effectivePermissions, flag) ? 1 : 0), 0)
  );

  let showPermissions = $state(false);

  function toggleFlag(flag: AssociationPermissionFlag): void {
    const next = hasPermissionFlag(effectivePermissions, flag)
      ? effectivePermissions & ~flag
      : effectivePermissions | flag;
    onRoleChange?.(member.userId, member.role, next);
  }
</script>

<div
  class="flex flex-col gap-3 rounded-2xl border border-cn-border/70 bg-cn-bg/40 px-4 py-3 transition-colors hover:bg-cn-bg/60"
>
  <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
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
        <button
          type="button"
          onclick={() => (showPermissions = !showPermissions)}
          class="inline-flex items-center gap-1.5 text-sm rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 text-text-main hover:border-cn-yellow/60 transition-colors {showPermissions ? 'border-cn-yellow/60 bg-cn-yellow/5' : ''}"
          aria-expanded={showPermissions}
        >
          Permissions ({permissionsCount})
          <ChevronDown size={14} class="transition-transform {showPermissions ? 'rotate-180' : ''}" />
        </button>
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

  {#if manage && showPermissions}
    <div class="border-t border-cn-border/40 pt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-2.5">
      {#each FLAG_LABELS as { flag, label } (flag)}
        <label class="flex items-center gap-2 cursor-pointer group">
          <input
            type="checkbox"
            checked={hasPermissionFlag(effectivePermissions, flag)}
            onchange={() => toggleFlag(flag)}
            class="w-4 h-4 rounded border-cn-border accent-cn-yellow cursor-pointer"
          />
          <span class="text-sm text-text-main group-hover:text-cn-dark transition-colors">{label}</span>
        </label>
      {/each}
    </div>
  {/if}
</div>
