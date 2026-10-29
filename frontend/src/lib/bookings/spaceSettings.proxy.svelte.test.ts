import { describe, expect, it } from 'vitest';
import type { AudienceCondition, FormItem } from '$lib/forms/api';
import type { ManagedSpace } from './api';
import { draftFromSpace } from './spaceSettings.svelte';

/**
 * THE DRAFT IS READ FROM A `$state` PROXY, NEVER A PLAIN OBJECT (v1.3.0-alpha.2).
 *
 * The edit page holds the space it loaded in `$state` and hands it to `SpaceEditor` as a prop, so
 * `draftFromSpace` receives a PROXY. `structuredClone` of a proxy throws `DataCloneError`, and the
 * editor crashed on every client right after "Create the space" - while `spaceSettings.test.ts`
 * passed, because it only ever handed in a literal. These tests build the proxy the page builds.
 */

const ITEM = { id: 'q1', kind: 'text', label: 'Instrument' } as unknown as FormItem;
const AUDIENCE = { all: [] } as unknown as AudienceCondition;

function loadedSpace(): ManagedSpace {
  return {
    id: 's1',
    ownerId: 'o',
    associationId: null,
    resources: [],
    poster: null,
    name: 'Salle de musique',
    description: null,
    timeZone: 'Europe/Paris',
    slotMode: 'step',
    stepMinutes: 30,
    maxSteps: 4,
    nameVisibility: 'occupied',
    discoverability: 'listed',
    audience: AUDIENCE,
    items: [ITEM],
    privateInfo: null,
    opensAt: null,
    minNoticeMinutes: null,
    horizonDays: null,
    maxActiveBookings: null,
    maxMinutesPerPeriod: null,
    quotaPeriod: null,
    participantWithdrawMinMinutes: 0,
    maxPeople: null,
    retentionDays: 7,
    reminderMinutes: 60,
  };
}

describe('a draft read from the page state', () => {
  it('reads a $state proxy, items included, without throwing', () => {
    const space = $state(loadedSpace());
    const draft = draftFromSpace(space);
    expect(draft.items).toEqual([ITEM]);
    expect(draft.audience).toEqual(AUDIENCE);
  });

  it('owns its items and audience: editing the draft never writes into the space it was read from', () => {
    const space = $state(loadedSpace());
    const draft = draftFromSpace(space);
    draft.items.push({ ...ITEM, id: 'q2' });
    (draft.audience as unknown as { all: unknown[] }).all.push('x');
    expect(space.items).toHaveLength(1);
    expect((space.audience as unknown as { all: unknown[] }).all).toHaveLength(0);
  });
});
