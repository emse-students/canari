import type { IMlsService } from './IMlsService';

/** The two reads the epoch report needs - nothing that could mutate the client. */
type EpochSource = Pick<IMlsService, 'getLocalGroups' | 'getEpoch'>;

/**
 * This device's MLS epoch for every group it holds local state for, keyed by group id.
 *
 * WHY IT EXISTS: a sidebar that painted says nothing about whether the device is IN STEP with the
 * group. Two production conversations sat one epoch behind for a day while every readiness signal
 * was green (`docs/wiki/testing-methodology.md`, "A green sidebar tile does not prove the group is
 * not epoch-forked"). The server already answers `activeEpoch`; this is the client half of the
 * pair, so the cross-client rig (`tools/cross-client-harness/epochfork.mjs`) can put the two side
 * by side. Epoch numbers and group ids are not secret - no key material is read.
 */
export function mlsEpochsOf(svc: EpochSource): Record<string, number> {
  const out: Record<string, number> = {};
  for (const groupId of svc.getLocalGroups()) out[groupId] = svc.getEpoch(groupId);
  return out;
}

/**
 * Exposes {@link mlsEpochsOf} as `window.__canariMlsEpochs()`, unconditionally.
 *
 * Unconditionally for the boot benchmark's reason: a fork is found on a device that is ALREADY in
 * that state, so a flag that had to be set beforehand would never be set on the device that
 * matters. The latest service wins - a logout/login builds a new one and re-installs.
 */
export function installMlsEpochDevTools(svc: EpochSource): void {
  if (typeof window === 'undefined') return;
  console.debug('[MLS] window.__canariMlsEpochs installed for the current MLS service');
  (window as unknown as Record<string, unknown>).__canariMlsEpochs = (): Record<string, number> =>
    mlsEpochsOf(svc);
}
