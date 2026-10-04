/**
 * Why `add_members_bulk` refused one KeyPackage, as classified in Rust from the openmls error
 * VARIANT (`SkippedKeyPackageReason` in `mls-core/src/lib.rs`, the one table - this union mirrors
 * its wire names). A closed set: nothing here branches on an error message.
 */
export type SkippedKeyPackageReason =
  | 'undecodable'
  | 'expired'
  | 'not-yet-valid'
  | 'missing-lifetime'
  | 'invalid-signature'
  | 'unsupported-protocol-version'
  | 'malformed'
  | 'internal';

/** One KeyPackage refused by the WASM/native layer: its position in the input and the typed reason. */
export interface SkippedKeyPackage {
  index: number;
  reason: SkippedKeyPackageReason;
}

/** A device whose KeyPackage was refused, with the reason (positions already mapped to devices). */
export interface SkippedDevice {
  deviceId: string;
  reason: SkippedKeyPackageReason;
}

/** Groups skipped devices by reason, in first-seen order, so a log line can name each cause once. */
export function groupSkippedByReason(
  skipped: readonly SkippedDevice[]
): Array<{ reason: SkippedKeyPackageReason; deviceIds: string[] }> {
  const groups = new Map<SkippedKeyPackageReason, string[]>();
  for (const s of skipped) {
    const ids = groups.get(s.reason);
    if (ids) ids.push(s.deviceId);
    else groups.set(s.reason, [s.deviceId]);
  }
  return [...groups].map(([reason, deviceIds]) => ({ reason, deviceIds }));
}
