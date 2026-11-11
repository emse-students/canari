// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { flushSync } from 'svelte';
import {
  forgetPeerNames,
  mergeStoredNames,
  openDirectory,
  readPeerName,
} from './peerNameDirectory';

describe('peerNameDirectory is reactive, including whether it is open', () => {
  afterEach(() => forgetPeerNames());

  it('a row drawn BEFORE the bind re-reads when the directory opens and the stored copy lands', () => {
    let seen: string | null = 'unset';
    const stop = $effect.root(() => {
      $effect(() => {
        seen = readPeerName('me', 'peer-1');
      });
    });
    flushSync();
    expect(seen).toBeNull(); // drawn closed, as at the first frame

    openDirectory('me'); // the layout's bind
    mergeStoredNames('me', { 'peer-1': 'Alice Martin' }); // the hydrate
    flushSync();
    expect(seen).toBe('Alice Martin');
    stop();
  });
});
