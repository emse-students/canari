import { afterEach, describe, expect, it, vi } from 'vitest';
import { installMlsEpochDevTools, mlsEpochsOf } from './epochDevTools';

const svcWith = (epochs: Record<string, number>) => ({
  getLocalGroups: vi.fn(() => Object.keys(epochs)),
  getEpoch: vi.fn((g: string) => epochs[g] ?? 0),
});

describe('epochDevTools - the client half of the epoch-fork comparison', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__canariMlsEpochs;
  });

  it('reports every locally held group at its own epoch', () => {
    expect(mlsEpochsOf(svcWith({ a: 3, b: 139 }))).toEqual({ a: 3, b: 139 });
  });

  it('reports nothing for a device holding no group, rather than inventing one', () => {
    expect(mlsEpochsOf(svcWith({}))).toEqual({});
  });

  it('reads LIVE on each call, so a later commit is visible without re-installing', () => {
    const epochs: Record<string, number> = { a: 1 };
    installMlsEpochDevTools(svcWith(epochs));
    const hook = (window as unknown as { __canariMlsEpochs: () => Record<string, number> })
      .__canariMlsEpochs;
    expect(hook()).toEqual({ a: 1 });
    epochs.a = 2;
    expect(hook()).toEqual({ a: 2 });
  });

  it('the latest service wins, so a re-login does not leave the hook on a dead client', () => {
    installMlsEpochDevTools(svcWith({ old: 1 }));
    installMlsEpochDevTools(svcWith({ fresh: 7 }));
    const hook = (window as unknown as { __canariMlsEpochs: () => Record<string, number> })
      .__canariMlsEpochs;
    expect(hook()).toEqual({ fresh: 7 });
  });
});
