import { describe, it, expect } from 'vitest';
import { runExclusiveForGroup } from './groupMutationQueue';

/** Petit helper : une promesse resolue manuellement. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('runExclusiveForGroup', () => {
  it('serialise deux sections sur le MEME groupId (pas de chevauchement)', async () => {
    const events: string[] = [];
    const gate = deferred();

    const a = runExclusiveForGroup('g1', async () => {
      events.push('a:start');
      await gate.promise;
      events.push('a:end');
    });
    const b = runExclusiveForGroup('g1', async () => {
      events.push('b:start');
    });

    // b ne doit pas demarrer tant que a n'est pas termine.
    await Promise.resolve();
    expect(events).toEqual(['a:start']);

    gate.resolve();
    await Promise.all([a, b]);
    expect(events).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('laisse tourner en parallele des groupId DIFFERENTS', async () => {
    const events: string[] = [];
    const gate = deferred();

    const a = runExclusiveForGroup('g1', async () => {
      events.push('g1:start');
      await gate.promise;
    });
    const b = runExclusiveForGroup('g2', async () => {
      events.push('g2:start');
    });

    await Promise.resolve();
    // g2 demarre sans attendre g1 (groupes independants).
    expect(events).toContain('g2:start');

    gate.resolve();
    await Promise.all([a, b]);
  });

  it('une erreur dans une section ne bloque pas la file du groupe', async () => {
    const events: string[] = [];

    const a = runExclusiveForGroup('g1', async () => {
      events.push('a');
      throw new Error('boom');
    });
    const b = runExclusiveForGroup('g1', async () => {
      events.push('b');
    });

    await expect(a).rejects.toThrow('boom');
    await b;
    expect(events).toEqual(['a', 'b']);
  });

  it('propage la valeur de retour', async () => {
    const r = await runExclusiveForGroup('g1', async () => 42);
    expect(r).toBe(42);
  });
});
