import { describe, it, expect, vi, beforeEach } from 'vitest';

const logs: string[] = [];
vi.mock('$lib/utils/sessionLog', () => ({ appendLog: (l: string) => logs.push(l) }));

import { startCallVoice } from './callVoice';

beforeEach(() => {
  logs.length = 0;
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
