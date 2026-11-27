/// <reference types="jest" />

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALUMNI_ACCESS,
  alumniGateAdmits,
  alumniLinkStep,
  alumniProfileFacts,
  parisToday,
  type AlumniFacts,
} from './alumni-access';

/**
 * THE SHARED TABLE: libs/contracts/alumni-access.json is what MiConnect's policies are driven
 * through too (infrastructure/authentik/test-consent-flow.py), so a case passing here and there is
 * the proof the two implementations of the rule agree.
 */
interface Case {
  name: string;
  today: string;
  promos: number[];
  /** The RAW cursus, when the case is about how it is read. */
  cursus?: unknown[];
  posts: string[];
  alumni: AlumniFacts['alumni'];
  accessGroup: boolean;
  linked: boolean;
  link: 'none' | 'reminder' | 'required';
  gate: boolean;
}

const contract = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', '..', '..', 'libs', 'contracts', 'alumni-access.json'),
    'utf8'
  )
) as { constants: Record<string, unknown>; cases: Case[] };

/** The case's attributes as MiConnect holds them, read the way the handoff reads them. */
function facts(c: Case, application: string): AlumniFacts {
  const cursus = c.cursus ?? c.promos.map((promo) => ({ formation: 'ICM', promo }));
  return {
    ...alumniProfileFacts({
      profile: { cursus, posts: c.posts },
      ...(c.alumni ? { alumni: c.alumni } : {}),
    }),
    groups: c.accessGroup ? [`acces-${application}`] : ['some-other-group'],
    linked: c.linked,
  };
}

/** The day after an ISO date. */
function nextDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe('the Alumni access rule', () => {
  it('holds the constants of libs/contracts/alumni-access.json', () => {
    expect(ALUMNI_ACCESS).toEqual(contract.constants);
  });

  describe.each(contract.cases)('$name', (c) => {
    it('reads the entry years the case names', () => {
      expect(facts(c, 'migallery').promos).toEqual(c.promos);
    });
    it(`meets the link step ${c.link}`, () => {
      expect(alumniLinkStep(facts(c, 'migallery'), c.today)).toBe(c.link);
    });
    it.each(['migallery', 'cercle', 'mino-wiki'])(
      `is ${c.gate ? 'admitted' : 'refused'} by %s`,
      (app) => {
        expect(alumniGateAdmits(facts(c, app), app, c.today)).toBe(c.gate);
      }
    );
  });

  // A constant no case straddles could change on one side alone and every case would still pass.
  it('straddles every date constant with a case on each side of it', () => {
    const k = ALUMNI_ACCESS;
    const bare = (c: Case) =>
      c.promos.length === 1 && c.posts.length === 0 && !c.alumni && !c.accessGroup && !c.linked;
    const verdicts = (pick: (c: Case) => string | boolean, at: (p: number) => string) => {
      const found = new Set<string>();
      for (const c of contract.cases.filter(bare)) {
        const p = c.promos[0];
        if (c.today === at(p)) found.add(`on:${String(pick(c))}`);
        if (nextDay(c.today) === at(p)) found.add(`before:${String(pick(c))}`);
      }
      return found;
    };
    // The window's last day admits, the day after does not.
    const window = verdicts(
      (c) => c.gate,
      (p) => nextDay(`${p + k.windowYears}-${k.windowLastDay}`)
    );
    expect(window).toEqual(new Set(['on:false', 'before:true']));
    const reminder = verdicts(
      (c) => c.link,
      (p) => `${p + k.reminderYears}-${k.reminderFrom}`
    );
    expect(reminder).toEqual(new Set(['on:reminder', 'before:none']));
    // 1 February P+2 after the grace, and the grace itself for an older promo.
    const blocking = verdicts(
      (c) => c.link,
      (p) => {
        const own = `${p + k.blockingYears}-${k.blockingFrom}`;
        return own > k.graceUntil ? own : '';
      }
    );
    expect(blocking).toEqual(new Set(['on:required', 'before:reminder']));
    const grace = verdicts(
      (c) => c.link,
      (p) => (`${p + k.blockingYears}-${k.blockingFrom}` <= k.graceUntil ? k.graceUntil : '')
    );
    expect(grace).toEqual(new Set(['on:required', 'before:reminder']));
    // Each post admits on its own.
    for (const post of k.gateOpeningPosts) {
      expect(contract.cases.some((c) => c.posts.includes(post) && c.gate)).toBe(true);
    }
  });

  it('reads "today" in Paris: 23:30 UTC on 31 August is already 1 September there', () => {
    expect(parisToday(new Date('2025-08-31T23:30:00Z'))).toBe('2025-09-01');
    expect(parisToday(new Date('2025-08-31T21:30:00Z'))).toBe('2025-08-31');
  });

  it("admits on the group of the application asked for, never on another site's", () => {
    const closed: AlumniFacts = {
      promos: [2010],
      posts: [],
      alumni: null,
      groups: ['acces-cercle'],
      linked: true,
    };
    expect(alumniGateAdmits(closed, 'migallery', '2030-01-01')).toBe(false);
    expect(alumniGateAdmits(closed, 'cercle', '2030-01-01')).toBe(true);
  });
});
