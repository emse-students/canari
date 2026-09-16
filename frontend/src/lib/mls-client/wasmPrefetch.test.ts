/**
 * The prefetch fires for profiles that will need the binary, and for no others.
 *
 * The predicate is the whole decision: `prefetchMlsWasmAtBoot` is a fire-and-forget import whose
 * only branch is this answer, so testing the predicate tests the behaviour without standing up a
 * WASM module.
 */
import { browserHasEnrolledMlsDevice } from './wasmPrefetch';

/** A minimal `Storage` over a plain object, with the index API the predicate actually uses. */
function storageOf(entries: Record<string, string>): Pick<Storage, 'length' | 'key'> {
  const keys = Object.keys(entries);
  return {
    length: keys.length,
    key: (i: number) => keys[i] ?? null,
  };
}

describe('browserHasEnrolledMlsDevice', () => {
  it('is true when this profile has enrolled a device', () => {
    expect(browserHasEnrolledMlsDevice(storageOf({ mls_device_id_abc123: 'web-abc123-xyz' }))).toBe(
      true
    );
  });

  it('is false on a profile that has never signed in, so an anonymous reader pays nothing', () => {
    expect(
      browserHasEnrolledMlsDevice(storageOf({ 'canari-theme': 'dark', someOtherKey: '1' }))
    ).toBe(false);
  });

  it('is false on empty storage', () => {
    expect(browserHasEnrolledMlsDevice(storageOf({}))).toBe(false);
  });

  it('finds the entry wherever it sits, not only first', () => {
    expect(
      browserHasEnrolledMlsDevice(
        storageOf({ 'canari-theme': 'light', a: '1', mls_device_id_zz: 'web-zz', b: '2' })
      )
    ).toBe(true);
  });

  it('does not match a key that merely CONTAINS the prefix', () => {
    // The stored id is written as `mls_device_id_<userId>`; anything else carrying those characters
    // later in the string is a different key and must not arm a 723 kB download.
    expect(browserHasEnrolledMlsDevice(storageOf({ 'backup:mls_device_id_abc': 'x' }))).toBe(false);
  });
});
