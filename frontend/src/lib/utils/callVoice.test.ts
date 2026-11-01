import { describe, it, expect, vi, beforeEach } from 'vitest';

const logs: string[] = [];
vi.mock('$lib/utils/sessionLog', () => ({ appendLog: (l: string) => logs.push(l) }));

import { primeCallVoice, startCallVoice } from './callVoice';

beforeEach(() => {
  logs.length = 0;
});

describe('priming the call voice inside a gesture', () => {
  const abort = () => Promise.reject(new DOMException('interrupted', 'AbortError'));

  // iPhone 12 and web callee, 2026-10-30 / 11-01: the stream (or the surface going) aborts the
  // pending empty play(); that is the handover, not a refusal.
  it('says nothing when the stream attached a source and aborted the empty play', async () => {
    await primeCallVoice({ play: abort, srcObject: {} as MediaProvider, isConnected: true }, 'tap');
    expect(logs).toEqual([]);
  });

  it('says nothing when the element left the document', async () => {
    await primeCallVoice({ play: abort, srcObject: null, isConnected: false }, 'tap');
    expect(logs).toEqual([]);
  });

  it('still says an abort nothing of ours explains (no source, still mounted)', async () => {
    await primeCallVoice({ play: abort, srcObject: null, isConnected: true }, 'tap');
    expect(logs.join('\n')).toContain('voice primed (tap)');
  });

  it('still says a refusal, even with a source attached', async () => {
    const refused = () => Promise.reject(new DOMException('no gesture', 'NotAllowedError'));
    await primeCallVoice({ play: refused, srcObject: {} as MediaProvider, isConnected: true }, 'x');
    expect(logs.join('\n')).toContain('voice primed (x)');
  });
});

describe('starting the call voice', () => {
  it('plays', async () => {
    expect(await startCallVoice({ play: async () => {} }, 'stream')).toBe('playing');
  });

  it('reads a refusal without a gesture as BLOCKED - waiting for a tap, not failed', async () => {
    const refused = {
      play: () => Promise.reject(new DOMException('no gesture', 'NotAllowedError')),
    };
    expect(await startCallVoice(refused, 'stream')).toBe('blocked');
    expect(logs.join('\n')).toContain('waiting for a tap');
  });

  it('reads any other rejection as failed, and logs it', async () => {
    const broken = {
      play: () => Promise.reject(new DOMException('no source', 'NotSupportedError')),
    };
    expect(await startCallVoice(broken, 'tap')).toBe('failed');
    expect(logs.join('\n')).toContain('voice did not start (tap)');
  });
});
