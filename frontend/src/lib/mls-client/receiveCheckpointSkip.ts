import { isNonProductionDeployment } from '$lib/utils/deployEnvironment';

/** The localStorage key a measurement run sets, on a non-production build only. */
export const RECEIVE_SKIP_STORAGE_KEY = 'canari_dev_checkpoint_skip_k';

/** The largest budget honoured: far under the sender ratchet window (2000), see open-questions. */
const MAX_BUDGET = 500;

/**
 * How many receive-only drains may leave their checkpoint to the next trigger, or 0 for OFF.
 *
 * A MEASUREMENT SWITCH FOR WP-CHECKPOINT-SKIP, NOT A FEATURE. The Mi 9T crash measurement of
 * [open-questions](docs/wiki/open-questions.md) needs a build that holds a state ahead of the disk,
 * and no build does (every drain checkpoints). It needs BOTH of: a build made for the development
 * estate (`VITE_DEPLOY_ENVIRONMENT`, which production never has) AND an explicit positive integer under
 * {@link RECEIVE_SKIP_STORAGE_KEY}. A key alone, which a production user could hold by accident,
 * does nothing; and the persister logs at warn on every skip, so a run is visible in the console.
 *
 * @param read how the key is read, injectable for tests; defaults to `localStorage`.
 */
export function receiveCheckpointSkipBudget(
  read: () => string | null = () => {
    try {
      return localStorage.getItem(RECEIVE_SKIP_STORAGE_KEY);
    } catch {
      return null;
    }
  },
  nonProduction: boolean = isNonProductionDeployment()
): number {
  if (!nonProduction) return 0;
  const raw = read();
  if (raw === null || !/^\d+$/.test(raw.trim())) return 0;
  return Math.min(Number(raw.trim()), MAX_BUDGET);
}
