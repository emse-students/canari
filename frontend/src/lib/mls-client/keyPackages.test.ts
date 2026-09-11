import { mintKeyPackages } from './keyPackages';

/**
 * `replenishKeyPackages` was tested here until 2026-09-06 and deleted with these tests: it wrapped
 * `mlsService.generateKeyPackage` in one line, its docblock called itself "a single entry point for
 * the connection layer", and the connection layer called the service directly. Its only caller was
 * this file.
 */
function makeClient(held?: Uint8Array) {
  return {
    generate_last_resort_key_package: vi.fn(() => new Uint8Array([0xfa])),
    generate_key_packages: vi.fn((n: number) =>
      Array.from({ length: n }, (_, i) => new Uint8Array([i]))
    ),
    // `bigint`, like the generated binding - a mock that accepted a Number is what let the defect
    // below through, since it is the only client `mintKeyPackages` is ever type-checked against.
    existing_last_resort_key_package: vi.fn((_now: bigint) => held),
  };
}

describe('mintKeyPackages', () => {
  it('mints the fallback as LAST RESORT, which is the whole reason this helper exists', () => {
    const client = makeClient();
    const { fallback } = mintKeyPackages(client, 0);
    expect(client.generate_last_resort_key_package).toHaveBeenCalledTimes(1);
    // The ordinary minter must not have been touched for the fallback: the delivery service serves
    // that one package to every peer that finds the pool empty, and MLS deletes an ordinary
    // package's private bundle at the first Welcome built on it.
    expect(client.generate_key_packages).not.toHaveBeenCalled();
    expect(fallback).toEqual(new Uint8Array([0xfa]));
  });

  it('mints the pool as ORDINARY one-time prekeys', () => {
    const client = makeClient();
    const { poolPackages } = mintKeyPackages(client, 3);
    expect(client.generate_key_packages).toHaveBeenCalledWith(3);
    expect(poolPackages).toHaveLength(3);
  });

  it('asks for no pool at all when the server already holds enough', () => {
    const client = makeClient();
    const { poolPackages } = mintKeyPackages(client, 0);
    expect(client.generate_key_packages).not.toHaveBeenCalled();
    expect(poolPackages).toEqual([]);
  });

  it('materialises the pool, which the WASM layer returns as a lazy js_sys::Array', () => {
    const client = makeClient();
    const { poolPackages } = mintKeyPackages(client, 2);
    expect(Array.isArray(poolPackages)).toBe(true);
    expect(poolPackages[0]).toBeInstanceOf(Uint8Array);
  });
});

describe('mintKeyPackages republishes the fallback it already holds', () => {
  it('does NOT mint when a valid last-resort is held, which is where the leak was', () => {
    // Unconditional reminting was half the key-package leak: the pool has always been incremental,
    // while the fallback was reminted on every connection - 269 bundles on the Mi 9T measured on
    // 2026-09-09, 9% of a 3051-bundle keystore, each one nothing deletes for 84 days.
    const client = makeClient(new Uint8Array([0xbe, 0xef]));
    const { fallback } = mintKeyPackages(client, 0);

    expect(client.generate_last_resort_key_package).not.toHaveBeenCalled();
    expect(fallback).toEqual(new Uint8Array([0xbe, 0xef]));
  });

  it('mints when nothing valid is held, so rotation is the package lifetime and not the socket', () => {
    const client = makeClient(undefined);
    const { fallback } = mintKeyPackages(client, 0);

    expect(client.generate_last_resort_key_package).toHaveBeenCalledTimes(1);
    expect(fallback).toEqual(new Uint8Array([0xfa]));
  });

  it('asks with a BigInt, because the binding takes a u64 and a Number THROWS', () => {
    const client = makeClient(new Uint8Array([1]));
    mintKeyPackages(client, 0);

    const asked = client.existing_last_resort_key_package.mock.calls[0][0];
    // THE ASSERTION THAT USED TO BE HERE WAS `Number.isInteger(asked)`, and it is why the defect
    // shipped: it demanded of the clock exactly the type the binding refuses. wasm-bindgen marshals
    // `u64` through `BigInt.asUintN`, whose `ToBigInt` throws a TypeError on any Number - so every
    // web key-package publication died from #458 until this test was corrected with the call.
    expect(typeof asked).toBe('bigint');
    // And still SECONDS: milliseconds would put every query ~1971 years in the future and reject
    // every held package as expired, which fails safe but reinstates the remint this exists to
    // remove.
    expect(Math.abs(Number(asked) - Date.now() / 1000)).toBeLessThan(5);
  });

  // `mintKeyPackages` used to call the query optionally, and a test asserted that a client without
  // it simply minted - "the old behaviour rather than a broken one". Both are gone: the method is
  // not optional on the generated client, ONE `WasmMlsClient` serves both web call sites, and a
  // fallback for a client that cannot exist is a path that only ever hid a signature.
});
