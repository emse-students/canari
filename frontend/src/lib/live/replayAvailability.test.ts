import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { replayEndText, replaysAvailable } from './replayAvailability';
import { LIVE_REPLAY_MIN_MS } from './constants';

describe('replaysAvailable', () => {
  it('is on only when the server says on', () => {
    expect(replaysAvailable('on')).toBe(true);
    expect(replaysAvailable('off')).toBe(false);
  });
});

describe('replayEndText', () => {
  it("says the server's verdict, the rule while it is unknown, and none for a live it does not keep", () => {
    expect(replayEndText(true, true)).toBe('kept');
    expect(replayEndText(true, false)).toBe('none');
    expect(replayEndText(true, null)).toBe('pending');
    expect(replayEndText(false, true)).toBe('none');
    expect(replayEndText(false, null)).toBe('none');
  });
});

describe('the client copies of the server numbers', () => {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const server = readFileSync(
    join(repo, 'apps/social-service/src/lives/live.constants.ts'),
    'utf8'
  );
  it("the minimum length is the server's (the retention is no longer a constant: an admin setting)", () => {
    const min = /LIVE_REPLAY_MIN_MS = ([\d_]+);/.exec(server);
    expect(min).not.toBeNull();
    expect(Number(min![1].replaceAll('_', ''))).toBe(LIVE_REPLAY_MIN_MS);
    expect(server).not.toMatch(/LIVE_REPLAY_RETENTION_DAYS/);
  });
});
