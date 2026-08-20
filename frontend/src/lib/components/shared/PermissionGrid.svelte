<script lang="ts">
  import { Check, X, Minus } from '@lucide/svelte';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  /** A workspace role row (id, name, priority). */
  export interface PermissionGridRole {
    id: string;
    name: string;
    priority: number;
  }

  /** An existing override loaded from the server. */
  export interface PermissionGridOverride {
    roleId: string;
    permission: string;
    value: 'allow' | 'deny';
  }

  /** Permission metadata for one row. */
  export interface PermissionGridPermission {
    key: string;
    label: string;
    tooltip: string;
  }

  interface Props {
    /** Available roles (columns), sorted by priority descending (admin first). */
    roles: PermissionGridRole[];
    /** Permission definitions (rows). */
    permissions: PermissionGridPermission[];
    /** Currently loaded overrides (role × permission → allow|deny). */
    overrides: PermissionGridOverride[];
    /** Fired when a cell is toggled: (roleId, permissionKey, newValue). */
    onToggle: (roleId: string, permissionKey: string, value: 'allow' | 'deny' | 'neutral') => void;
    /** When true, admin (highest priority) cells are read-only. */
    lockAdmin?: boolean;
    /**
     * When true, the cell toggle only cycles between neutral and allow (2 states).
     * Deny is reserved for channel-level overrides; workspace-level roles use 2-state toggle.
     */
    disableDeny?: boolean;
  }

  let {
    roles = [],
    permissions = [],
    overrides = [],
    onToggle,
    lockAdmin = true,
    disableDeny = false,
  }: Props = $props();

  // Sort roles by priority DESC so admin appears first.
  const sortedRoles = $derived([...roles].sort((a, b) => b.priority - a.priority));
  const maxPriority = $derived(Math.max(...sortedRoles.map((r) => r.priority), 0));

  /** Resolve the current override state for a (roleId, permission) cell. */
  function getCellState(roleId: string, permissionKey: string): 'allow' | 'deny' | 'neutral' {
    const ov = overrides.find((o) => o.roleId === roleId && o.permission === permissionKey);
    return ov?.value ?? 'neutral';
  }

  /**
   * Cycle cell state. When {@link disableDeny} is true, only neutral ↔ allow.
   * Otherwise: neutral → allow → deny → neutral.
   */
  function cycleCell(roleId: string, permissionKey: string) {
    Log.d('PermissionGrid.cycleCell', { roleId, permissionKey, disableDeny });
    const current = getCellState(roleId, permissionKey);
    let next: 'allow' | 'deny' | 'neutral';
    if (disableDeny) {
      next = current === 'neutral' ? 'allow' : 'neutral';
    } else {
      next = current === 'neutral' ? 'allow' : current === 'allow' ? 'deny' : 'neutral';
    }
    onToggle(roleId, permissionKey, next);
  }

  /** How one cell's current state reads, in the two-state and three-state vocabularies. */
  function stateLabel(state: 'allow' | 'deny' | 'neutral'): string {
    if (disableDeny) {
      return state === 'allow' ? m.chat_permission_state_yes() : m.chat_permission_state_no();
    }
    if (state === 'allow') return m.chat_permission_state_allowed();
    if (state === 'deny') return m.chat_permission_state_denied();
    return m.chat_permission_state_neutral();
  }
</script>

{#if permissions.length === 0}
  <p class="text-text-muted text-sm italic">{m.chat_permission_grid_empty()}</p>
{:else}
  <div class="custom-scrollbar overflow-x-auto">
    <table class="w-full border-collapse text-xs" cellspacing="0">
      <thead>
        <tr>
          <th
            class="text-text-muted sticky left-0 min-w-52 border-b border-black/5 bg-white/80 px-3 py-2.5 text-left text-[0.65rem] font-bold tracking-wider uppercase backdrop-blur-sm dark:border-white/10 dark:bg-zinc-900/80"
          >
            {m.chat_permission_grid_column_header()}
          </th>
          {#each sortedRoles as role (role.id)}
            <th
              class="text-text-muted min-w-24 border-b border-black/5 px-3 py-2.5 text-center text-[0.65rem] font-bold tracking-wider uppercase dark:border-white/10"
            >
              <span
                class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 {role.priority >=
                  maxPriority && lockAdmin
                  ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                  : role.priority >= 50
                    ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                    : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'}"
              >
                @{role.name}
              </span>
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each permissions as perm (perm.key)}
          <tr class="group transition-colors hover:bg-black/2 dark:hover:bg-white/2">
            <td
              class="sticky left-0 border-b border-black/5 bg-white/80 px-3 py-2.5 backdrop-blur-sm dark:border-white/10 dark:bg-zinc-900/80"
              title={perm.tooltip}
            >
              <div class="flex flex-col">
                <span class="text-text-main text-[0.7rem] leading-tight font-semibold"
                  >{perm.label}</span
                >
              </div>
            </td>
            {#each sortedRoles as role (role.id)}
              {@const state = getCellState(role.id, perm.key)}
              {@const isAdmin = lockAdmin && role.priority >= maxPriority}
              <td class="border-b border-black/5 px-2 py-2.5 text-center dark:border-white/10">
                <button
                  type="button"
                  onclick={() => cycleCell(role.id, perm.key)}
                  disabled={isAdmin}
                  title={isAdmin
                    ? m.chat_permission_grid_admin_locked()
                    : m.chat_permission_grid_cell_hint({
                        label: perm.label,
                        state: stateLabel(state),
                      })}
                  class="inline-flex h-8 w-8 items-center justify-center rounded-lg transition-all outline-none focus-visible:ring-2 focus-visible:ring-amber-500 {isAdmin
                    ? 'cursor-not-allowed opacity-40'
                    : 'cursor-pointer hover:scale-110 active:scale-95'} {state === 'allow'
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                    : state === 'deny'
                      ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                      : 'text-text-muted/50 bg-transparent hover:bg-black/5 dark:hover:bg-white/5'}"
                >
                  {#if isAdmin}
                    <Check size={16} strokeWidth={3} class="text-emerald-500/70" />
                  {:else if state === 'allow'}
                    <Check size={16} strokeWidth={3} />
                  {:else if state === 'deny'}
                    <X size={16} strokeWidth={3} />
                  {:else}
                    <Minus size={16} strokeWidth={2.5} />
                  {/if}
                </button>
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <!-- Légende -->
  <div class="text-text-muted flex flex-wrap items-center gap-4 pt-3 text-[0.65rem] font-medium">
    <span class="inline-flex items-center gap-1.5">
      <Check size={12} strokeWidth={3} class="text-emerald-500" />
      {disableDeny ? m.chat_permission_state_yes() : m.chat_permission_state_allowed()}
    </span>
    {#if !disableDeny}
      <span class="inline-flex items-center gap-1.5">
        <X size={12} strokeWidth={3} class="text-red-500" />
        {m.chat_permission_state_denied()}
      </span>
    {/if}
    <span class="inline-flex items-center gap-1.5">
      <Minus size={12} strokeWidth={2.5} class="text-text-muted/50" />
      {disableDeny ? m.chat_permission_state_no() : m.chat_permission_state_neutral()}
    </span>
  </div>
{/if}

<style>
  .custom-scrollbar::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }
  .custom-scrollbar::-webkit-scrollbar-track {
    background: transparent;
  }
  .custom-scrollbar::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--cn-surface) 20%, transparent);
    border-radius: 6px;
  }
  :global([data-theme='dark']) .custom-scrollbar::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.1);
  }
</style>
