import { replenishKeyPackages } from './keyPackages';

function makeService(overrides: Record<string, unknown> = {}) {
  return {
    generateKeyPackage: vi.fn().mockResolvedValue(new Uint8Array([9])),
    ...overrides,
  } as any;
}

describe('replenishKeyPackages', () => {
  it('appelle generateKeyPackage avec le PIN fourni', async () => {
    const mls = makeService();
    await replenishKeyPackages(mls, 'secret-pin');
    expect(mls.generateKeyPackage).toHaveBeenCalledWith('secret-pin');
  });

  it('appelle generateKeyPackage exactement une fois par appel', async () => {
    const mls = makeService();
    await replenishKeyPackages(mls, 'p');
    await replenishKeyPackages(mls, 'p');
    expect(mls.generateKeyPackage).toHaveBeenCalledTimes(2);
  });

  it('propage les erreurs de generateKeyPackage', async () => {
    const mls = makeService({
      generateKeyPackage: vi.fn().mockRejectedValue(new Error('WASM out of memory')),
    });
    await expect(replenishKeyPackages(mls, 'p')).rejects.toThrow('WASM out of memory');
  });

  it('réussit sans lancer si generateKeyPackage retourne undefined', async () => {
    const mls = makeService({
      generateKeyPackage: vi.fn().mockResolvedValue(undefined),
    });
    await expect(replenishKeyPackages(mls, 'p')).resolves.not.toThrow();
  });
});
