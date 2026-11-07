import { describe, expect, it } from 'vitest';
import { publishViewLabel } from './publishViewLabel';
import type { PublishView } from './publishQueue';

const view = (patch: Partial<PublishView>): PublishView => ({
  id: 'p',
  phase: 'queued',
  index: 0,
  count: 3,
  fraction: 0,
  step: 0,
  ...patch,
});

describe('publishViewLabel', () => {
  it('names the media on the wire 1-based, with its own percentage', () => {
    expect(publishViewLabel(view({ phase: 'uploading', index: 1, step: 0.42 }))).toMatch(
      /2.*3.*42/
    );
  });

  it("says a stopped post's reason, and a waiting one resumes on its own", () => {
    expect(publishViewLabel(view({ phase: 'failed', failure: 'Trop de medias' }))).toContain(
      'Trop de medias'
    );
    expect(publishViewLabel(view({ phase: 'waiting' }))).not.toBe(publishViewLabel(view({})));
  });

  it('a video being prepared shows its percentage only once there is one', () => {
    expect(publishViewLabel(view({ phase: 'preparing', step: 0 }))).not.toMatch(/%/);
    expect(publishViewLabel(view({ phase: 'preparing', step: 0.5 }))).toMatch(/50/);
  });
});
