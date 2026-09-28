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
    /** Available roles, one section each, sorted by priority descending (admin first). */
    roles: PermissionGridRole[];
    /** Permission definitions, one row per role section. */
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
  <!--
    ONE SECTION PER ROLE, PERMISSIONS DOWN THE PAGE - NEVER A MATRIX ACROSS IT (2026-09-28).

    This was a table: a label column, then one column per role. It fitted on paper - its floors
    summed to 336px against a 384px budget - and not on screen, because a floor only ever ADDS
    width and the real width was the role pills: "@ADMINISTRATEUR" in spaced capitals is ~150px on
    its own. At 390 only the admin column was visible and the other roles sat behind a horizontal
    scroll nothing announced; on the desktop panel "@MODERATEUR" was cut in half. That is the user's
    report of 2026-09-27 word for word: "plein d'elements sont invisibles".

    Transposed, the width a role needs is the width of one row, whatever the number of roles, so
    nothing here scrolls sideways at any size. And the tooltip, which no touch screen can show, is
    printed under each label. The admin role, locked, is one line rather than six disabled ticks.
  -->
  <div class="space-y-4">
    {#each sortedRoles as role (role.id)}
      {@const isAdmin = lockAdmin && role.priority >= maxPriority}
      <section class="border-cn-border bg-cn-surface rounded-xl border shadow-sm">
        <header
          class="flex flex-wrap items-center gap-2 border-b border-black/5 px-4 py-3 dark:border-white/10"
        >
          <span
            class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold {isAdmin
              ? 'bg-red-500/10 text-red-600 dark:text-red-400'
              : role.priority >= 50
                ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'}"
          >
            @{role.name}
          </span>
        </header>
        {#if isAdmin}
          <p class="text-text-muted flex items-center gap-2 px-4 py-3 text-sm">
            <Check size={16} strokeWidth={3} class="shrink-0 text-emerald-500" />
            {m.chat_permission_grid_admin_locked()}
          </p>
        {:else}
          <ul>
            {#each permissions as perm (perm.key)}
              {@const state = getCellState(role.id, perm.key)}
              {@const hint = m.chat_permission_grid_cell_hint({
                label: perm.label,
                state: stateLabel(state),
              })}
              <li
                class="flex items-center gap-3 border-b border-black/5 px-4 py-2.5 last:border-b-0 dark:border-white/10"
              >
                <div class="min-w-0 flex-1">
                  <p class="text-text-main text-sm font-semibold">{perm.label}</p>
                  <p class="text-text-muted text-xs">{perm.tooltip}</p>
                </div>
                <button
                  type="button"
                  onclick={() => cycleCell(role.id, perm.key)}
                  title={hint}
                  aria-label={hint}
                  class="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-all outline-none hover:scale-110 focus-visible:ring-2 focus-visible:ring-amber-500 active:scale-95 {state ===
                  'allow'
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                    : state === 'deny'
                      ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                      : 'text-text-muted/50 bg-transparent hover:bg-black/5 dark:hover:bg-white/5'}"
                >
                  {#if state === 'allow'}
                    <Check size={16} strokeWidth={3} />
                  {:else if state === 'deny'}
                    <X size={16} strokeWidth={3} />
                  {:else}
                    <Minus size={16} strokeWidth={2.5} />
                  {/if}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
  </div>

  <!-- What a cell's three states mean. -->
  <div class="text-text-muted text-2xs flex flex-wrap items-center gap-4 pt-3 font-medium">
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
