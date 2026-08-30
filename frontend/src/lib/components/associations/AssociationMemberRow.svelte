<script lang="ts">
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import type { AssociationMember } from '$lib/associations/api';
  import {
    AssociationPermissionFlag,
    BDE_ONLY_FLAGS,
    hasPermissionFlag,
  } from '$lib/associations/api';
  import { Trash2, ChevronDown } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    member: AssociationMember;
    displayName: string;
    /** When true, shows role editor and remove (association admins). */
    manage?: boolean;
    /** When false, BDE-only flags (VALIDATE_EVENTS, MANAGE_ASSO, MODERATE) are hidden. */
    isBDE?: boolean;
    /** `permissions` is omitted for a role-only rename, which leaves the bitmask untouched. */
    onRoleChange?: (userId: string, role: string, permissions?: number) => void | Promise<void>;
    onRemove?: (userId: string) => void | Promise<void>;
  }

  let {
    member,
    displayName,
    manage = false,
    isBDE = false,
    onRoleChange,
    onRemove,
  }: Props = $props();

  /**
   * Human-readable labels for each applicable permission flag, reactive across locale changes.
   *
   * EVERY flag the enum defines appears here. `MANAGE_PARTNERSHIPS` was missing, and this list is
   * the only screen that grants or revokes a flag - so a right that gates eight endpoints, and that
   * the admin preset hands out on creation, could never afterwards be seen or taken away.
   */
  const FLAG_LABELS = $derived<{ flag: AssociationPermissionFlag; label: string }[]>(
    [
      { flag: AssociationPermissionFlag.POST_AS_ASSO, label: m.asso_flag_post_as() },
      { flag: AssociationPermissionFlag.PROPOSE_EVENT, label: m.asso_flag_propose_event() },
      { flag: AssociationPermissionFlag.MANAGE_MEMBERS, label: m.asso_flag_manage_members() },
      { flag: AssociationPermissionFlag.MANAGE_DOCUMENTS, label: m.asso_flag_manage_documents() },
      { flag: AssociationPermissionFlag.MANAGE_FORMS, label: m.asso_flag_manage_forms() },
      { flag: AssociationPermissionFlag.MANAGE_PRODUCTS, label: m.asso_flag_manage_products() },
      {
        flag: AssociationPermissionFlag.MANAGE_PARTNERSHIPS,
        label: m.asso_flag_manage_partnerships(),
      },
      {
        flag: AssociationPermissionFlag.MANAGE_STRIPE_CONNECT,
        label: m.asso_flag_manage_payments(),
      },
      { flag: AssociationPermissionFlag.VALIDATE_EVENTS, label: m.asso_flag_validate_events() },
      { flag: AssociationPermissionFlag.MANAGE_ASSO, label: m.asso_flag_manage_asso() },
      { flag: AssociationPermissionFlag.MODERATE, label: m.asso_flag_moderate() },
    ].filter(({ flag }) => isBDE || !BDE_ONLY_FLAGS.has(flag))
  );

  /**
   * The bitmask as the SERVER sent it, or undefined when it withheld it - `listMembers` returns it
   * only to a caller holding `MANAGE_MEMBERS` (plus every caller's own row).
   *
   * There is deliberately NO fallback. The `member.isAdmin ? ALL_CORE_FLAGS : 0` guess that stood
   * here was WRITTEN BACK by `toggleFlag`, so ticking one box on a member whose bitmask had been
   * withheld granted them all seven core flags. `manage` is only ever set by a caller holding
   * `MANAGE_MEMBERS`, which is exactly the caller the server sends the bitmask to: undefined here
   * means the two disagree, and that is reported, not repaired.
   */
  const permissions = $derived(member.permissions);
  const canEditPermissions = $derived(manage && permissions !== undefined);

  $effect(() => {
    if (manage && permissions === undefined) {
      console.error(
        `[ASSO] member ${member.userId} is shown as manageable but the server withheld its permission bitmask - the flag editor stays closed`
      );
    }
  });

  const permissionsCount = $derived(
    FLAG_LABELS.reduce((n, { flag }) => n + (hasPermissionFlag(permissions ?? 0, flag) ? 1 : 0), 0)
  );

  let showPermissions = $state(false);

  function toggleFlag(flag: AssociationPermissionFlag): void {
    if (permissions === undefined) return;
    const next = hasPermissionFlag(permissions, flag) ? permissions & ~flag : permissions | flag;
    onRoleChange?.(member.userId, member.role, next);
  }
</script>

<div
  class="border-cn-border/70 bg-cn-bg/40 hover:bg-cn-bg/60 flex flex-col gap-3 rounded-2xl border px-4 py-3 transition-colors"
>
  <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    <div class="flex min-w-0 flex-1 items-center gap-3">
      <a
        href="/profile/{encodeURIComponent(member.userId)}"
        class="hover:ring-cn-yellow/40 shrink-0 rounded-full ring-2 ring-transparent transition-shadow"
        title={m.asso_member_view_profile_title()}
      >
        <Avatar userId={member.userId} size="lg" shape="circle" fallbackLabel={displayName} />
      </a>
      <div class="min-w-0">
        <a
          href="/profile/{encodeURIComponent(member.userId)}"
          class="text-text-main block truncate font-semibold hover:underline"
        >
          {displayName}
        </a>
        <div class="mt-1 flex flex-wrap items-center gap-2">
          <span
            class="rounded-full px-2.5 py-0.5 text-xs font-semibold
            {member.isAdmin
              ? 'bg-cn-yellow/25 text-cn-dark dark:text-cn-yellow'
              : 'bg-cn-border/50 text-text-muted'}"
          >
            {member.role}
          </span>
          {#if member.isAdmin}
            <span class="text-text-muted text-[11px] font-medium tracking-wide uppercase"
              >Admin</span
            >
          {/if}
        </div>
      </div>
    </div>

    {#if manage && onRoleChange && onRemove}
      <div class="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
        <input
          type="text"
          value={member.role}
          aria-label={m.asso_member_role_label()}
          onchange={(e) =>
            onRoleChange(member.userId, (e.target as HTMLInputElement).value, permissions)}
          class="border-cn-border w-full rounded-xl border bg-(--cn-surface) px-3 py-2 text-sm sm:w-36"
        />
        <button
          type="button"
          disabled={!canEditPermissions}
          onclick={() => (showPermissions = !showPermissions)}
          class="border-cn-border text-text-main hover:border-cn-yellow/60 inline-flex items-center gap-1.5 rounded-xl border bg-(--cn-surface) px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 {showPermissions
            ? 'border-cn-yellow/60 bg-cn-yellow/5'
            : ''}"
          aria-expanded={showPermissions}
        >
          {m.asso_member_permissions_label({ count: permissionsCount })}
          <ChevronDown
            size={14}
            class="transition-transform {showPermissions ? 'rotate-180' : ''}"
          />
        </button>
        <button
          type="button"
          onclick={() => onRemove(member.userId)}
          class="border-red-err/30 bg-red-err/10 text-red-err hover:bg-red-err/20 inline-flex items-center justify-center rounded-xl border p-2 transition-colors"
          title={m.asso_member_remove_title()}
        >
          <Trash2 size={16} />
        </button>
      </div>
    {/if}
  </div>

  {#if canEditPermissions && showPermissions}
    <div
      class="border-cn-border/40 grid grid-cols-1 gap-x-4 gap-y-2.5 border-t pt-3 sm:grid-cols-2 lg:grid-cols-3"
    >
      {#each FLAG_LABELS as { flag, label } (flag)}
        <label class="group flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={hasPermissionFlag(permissions ?? 0, flag)}
            onchange={() => toggleFlag(flag)}
            class="border-cn-border accent-cn-yellow h-4 w-4 cursor-pointer rounded"
          />
          <span class="text-text-main group-hover:text-cn-dark text-sm transition-colors"
            >{label}</span
          >
        </label>
      {/each}
    </div>
  {/if}
</div>
