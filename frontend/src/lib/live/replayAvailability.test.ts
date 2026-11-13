import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { replayFollows, replaysAvailable } from './replayAvailability';
import { LIVE_REPLAY_MIN_MS, LIVE_REPLAY_RETENTION_DAYS } from './constants';

describe('replaysAvailable', () => {
  it('is on only when the server says on', () => {
    expect(replaysAvailable('on')).toBe(true);
    expect(replaysAvailable('off')).toBe(false);
  });
});

describe('replayFollows', () => {
  it('promises a replay only to a live of at least 30 s, with the switch on', () => {
    expect(replayFollows('on', LIVE_REPLAY_MIN_MS)).toBe(true);
    expect(replayFollows('on', LIVE_REPLAY_MIN_MS - 1)).toBe(false);
    expect(replayFollows('off', 10 * LIVE_REPLAY_MIN_MS)).toBe(false);
  });
});

describe('the client copies of the server numbers', () => {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const server = readFileSync(
    join(repo, 'apps/social-service/src/lives/live.constants.ts'),
    'utf8'
  );
  it('the minimum length and the retention are the servers', () => {
    const min = /LIVE_REPLAY_MIN_MS = ([\d_]+);/.exec(server);
    expect(min).not.toBeNull();
    expect(Number(min![1].replaceAll('_', ''))).toBe(LIVE_REPLAY_MIN_MS);
    const days = /LIVE_REPLAY_RETENTION_DAYS = (\d+);/.exec(server);
    expect(days).not.toBeNull();
    expect(Number(days![1])).toBe(LIVE_REPLAY_RETENTION_DAYS);
  });
});
