import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRAINE_RETENTION_FLOOR_DAYS } from './retention';

/**
 * The client floor on the seed sweep and the server's message window are ONE number in two packages.
 *
 * A floor ABOVE the window keeps seeds past their messages; a floor BELOW it lets a server-provided
 * value shorten a device's seed lifetime again. Neither package can import the other, so the server
 * constant is read from its source.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SCHEDULER = resolve(
  here,
  '../../../../../apps/social-service/src/channels/channel-retention.scheduler.ts'
);

describe('GRAINE_RETENTION_FLOOR_DAYS', () => {
  it('equals the server window CHANNEL_MESSAGE_RETENTION_DAYS', () => {
    const source = readFileSync(SCHEDULER, 'utf8');
    const match = /export const CHANNEL_MESSAGE_RETENTION_DAYS = (\d+);/.exec(source);

    expect(match, 'CHANNEL_MESSAGE_RETENTION_DAYS not found in the scheduler').not.toBeNull();
    expect(Number(match![1])).toBe(GRAINE_RETENTION_FLOOR_DAYS);
  });
});
