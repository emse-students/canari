/**
 * The one value `core.hooksPath` may hold, and why anything else is a repository-wide hazard.
 *
 * `core.hooksPath` is stored in the COMMON git directory, and every `git worktree` shares it. So an
 * ABSOLUTE value is not a local detail: it re-points the hooks of the main checkout and of every
 * other worktree at whichever checkout last ran an install. Worktrees created by tooling appear and
 * vanish without anybody acting, and when the named directory is gone git runs NO hook and says
 * nothing - commits are merely suspiciously fast and stop re-staging anything. A RELATIVE value
 * resolves inside whichever checkout is committing, which is what every checkout wants.
 *
 * AND IT NAMES A TRACKED DIRECTORY (2026-11-15). It was `.husky/_`, the wrappers husky GENERATES
 * on `bun install` - so a fresh worktree with no `node_modules` had no `.husky/_`, and git ran no
 * hook there and said nothing (PR #3611 was committed that way). `.husky/` itself is tracked: every
 * checkout has the hooks the moment it exists, and a hook that then finds no toolchain FAILS and
 * names what to install, rather than never running.
 */
export const HOOKS_PATH = '.husky';

/**
 * Why a `core.hooksPath` reading cannot be trusted, or `null` when it can.
 *
 * "Non-empty" was the previous post-condition, and it is exactly what let an absolute path through
 * on four separate occasions: the value WAS set, the install DID report success, and the hooks of
 * every other checkout sharing this `.git` had just been taken over.
 *
 * @param {string} value the value git reports
 * @returns {string | null} the reason it is unusable, or null when it is sound
 */
export function hooksPathProblem(value) {
  if (!value) return 'core.hooksPath is empty - no hook runs, and git reports that as silence';
  const absolute =
    value.startsWith('/') ||
    value.startsWith('\\') ||
    (/^[A-Za-z]:/.test(value) && (value[2] === '/' || value[2] === '\\'));
  if (absolute) {
    return (
      `core.hooksPath is absolute (${value}), and it is shared by every worktree - so this value ` +
      `disarms the hooks of every other checkout the moment that directory moves or is removed`
    );
  }
  return null;
}
