import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  DeviceTrustRefusedError,
  announcesNewDevice,
  deviceEventAudience,
  deviceEventKey,
  entersUninvited,
  isNewToItsOwner,
  keyFingerprintOf,
  reportDeviceTrustRefusal,
  resetReportedDeviceTrustRefusals,
  type DeviceEvent,
} from './deviceTrust';

const event = (over: Partial<DeviceEvent> = {}): DeviceEvent => ({
  groupId: 'g1',
  epoch: 4,
  identity: 'bob:web-2',
  keyFingerprint: '0011223344556677',
  trust: 'first-sight',
  addedBy: 'bob:phone-1',
  memberAlreadyPresent: true,
  ...over,
});

const alice = { ownUserId: 'alice', ownDeviceId: 'phone-a' };

// Decided by the user 2026-10-22: the owner is alerted wherever the admission happened; contacts see
// "X added a device" in private conversations only, never in a community or salon key group.
describe('deviceEventAudience - who is told about an admitted device', () => {
  it('shows the contact line in a 1:1 or group conversation', () => {
    expect(deviceEventAudience(event(), { ...alice, isKeyDistributionGroup: false })).toBe(
      'contact-line'
    );
  });

  it('shows nothing to contacts in a community key group', () => {
    expect(deviceEventAudience(event(), { ...alice, isKeyDistributionGroup: true })).toBe('none');
  });

  it('announces nothing for a member joining with their device, nor a pinned re-add', () => {
    const ctx = { ...alice, isKeyDistributionGroup: false };
    expect(deviceEventAudience(event({ memberAlreadyPresent: false }), ctx)).toBe('none');
    expect(deviceEventAudience(event({ trust: 'pinned' }), ctx)).toBe('none');
  });

  it('never alerts the added device about itself', () => {
    expect(
      deviceEventAudience(event(), {
        ownUserId: 'bob',
        ownDeviceId: 'web-2',
        isKeyDistributionGroup: false,
      })
    ).toBe('none');
  });

  it('alerts the account owner from any kind of group, case-insensitively', () => {
    for (const isKeyDistributionGroup of [false, true]) {
      expect(
        deviceEventAudience(event({ identity: 'BOB:web-2' }), {
          ownUserId: 'bob',
          ownDeviceId: 'phone-1',
          isKeyDistributionGroup,
        })
      ).toBe('owner-alert');
    }
  });

  it('announces nothing for a changed key found in a joined tree, which no commit admitted', () => {
    expect(
      deviceEventAudience(event({ trust: 'key-changed', addedBy: null }), {
        ownUserId: 'bob',
        ownDeviceId: 'phone-1',
        isKeyDistributionGroup: false,
      })
    ).toBe('none');
  });
});

/**
 * THE SAME TABLE RUST IS HELD TO (`device_trust.rs`, `the_owner_alert_and_the_notice_key_follow_
 * the_shared_table`): the background engines decide the owner alert there, the app decides here, and
 * a phone that notified for a device the app then stayed silent about - or the reverse - is the
 * disagreement this one file prevents.
 */
describe('deviceEventAudience and deviceEventKey - the table shared with Rust', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const cases = JSON.parse(
    readFileSync(resolve(here, '../../../mls-core/tests/fixtures/device_notices.json'), 'utf8')
  ) as Array<{
    name: string;
    event: DeviceEvent;
    ownUserId: string;
    ownDeviceId: string;
    isKeyDistributionGroup: boolean;
    audience: string;
    key: string | null;
  }>;

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(deviceEventAudience(c.event, c)).toBe(c.audience);
    expect(deviceEventKey(c.event)).toBe(c.key);
  });
});

describe('deviceEventKey - one device under one key is announced once', () => {
  it('is the same across groups and user-id case, and differs by device and by key', () => {
    const base = deviceEventKey(event());
    expect(deviceEventKey(event({ groupId: 'g2', identity: 'BOB:web-2' }))).toBe(base);
    expect(deviceEventKey(event({ identity: 'bob:WEB-2' }))).not.toBe(base);
    expect(deviceEventKey(event({ keyFingerprint: 'ffffffffffffffff' }))).not.toBe(base);
  });
});

describe('keyFingerprintOf - the fingerprint Rust prints, computed by the app', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const cases = JSON.parse(
    readFileSync(resolve(here, '../../../mls-core/tests/fixtures/key_fingerprints.json'), 'utf8')
  ) as Array<{ keyHex: string; fingerprint: string }>;

  it.each(cases)('$keyHex -> $fingerprint', async ({ keyHex, fingerprint }) => {
    const key = new Uint8Array(keyHex.match(/../g)!.map((h) => parseInt(h, 16)));
    expect(await keyFingerprintOf(key)).toBe(fingerprint);
  });
});

/**
 * "First sight by THIS device" is not "new to its owner": a fresh install, a restore, a heal that
 * re-adds a contact's old laptop all show devices this device never pinned (#2278 review). The
 * server's first sight of the key is the evidence, used only to SUPPRESS.
 */
describe('isNewToItsOwner', () => {
  const DAY = 24 * 3600_000;
  const now = 100 * DAY;
  const enrolled = 90 * DAY; // this device enrolled ten days ago

  const dated = (at: number) => ({ kind: 'dated', at }) as const;

  it('a key the server lists undated predates the history and is never new', () => {
    const sight = { kind: 'before-history' } as const;
    for (const ownersAlert of [false, true]) {
      expect(isNewToItsOwner(sight, { learnedAt: now, ownEnrolledAt: enrolled, ownersAlert })).toBe(
        false
      );
    }
  });

  it('A SERVER THAT STAYS SILENT DOES NOT SILENCE IT: a key it says nothing about is new', () => {
    const sight = { kind: 'unknown' } as const;
    for (const ownersAlert of [false, true]) {
      for (const ownEnrolledAt of [enrolled, null]) {
        expect(isNewToItsOwner(sight, { learnedAt: now, ownEnrolledAt, ownersAlert })).toBe(true);
      }
    }
  });

  it("a contact's device registered minutes ago is new", () => {
    expect(
      isNewToItsOwner(dated(now - 5 * 60_000), {
        learnedAt: now,
        ownEnrolledAt: enrolled,
        ownersAlert: false,
      })
    ).toBe(true);
  });

  it("a contact's old device a heal re-adds is not - before this device enrolled, or long ago", () => {
    const ctx = { learnedAt: now, ownEnrolledAt: enrolled, ownersAlert: false };
    expect(isNewToItsOwner(dated(30 * DAY), ctx)).toBe(false);
    expect(isNewToItsOwner(dated(enrolled + DAY), ctx)).toBe(false);
  });

  it("the owner's old device re-added on a young device is not; one registered since it enrolled is", () => {
    const ctx = { learnedAt: now, ownEnrolledAt: enrolled, ownersAlert: true };
    expect(isNewToItsOwner(dated(30 * DAY), ctx)).toBe(false);
    // However late this device learns of it - a phone off for a fortnight still alerts.
    expect(isNewToItsOwner(dated(enrolled + DAY), { ...ctx, learnedAt: now + 14 * DAY })).toBe(
      true
    );
    // The LINE is bounded like a contact's: not written a fortnight late.
    expect(
      isNewToItsOwner(dated(enrolled + DAY), {
        ...ctx,
        ownersAlert: false,
        learnedAt: now + 14 * DAY,
      })
    ).toBe(false);
  });

  it('an unknown own enrolment skips that comparison, the window still holds', () => {
    const ctx = { learnedAt: now, ownEnrolledAt: null, ownersAlert: false };
    expect(isNewToItsOwner(dated(now - 60_000), ctx)).toBe(true);
    expect(isNewToItsOwner(dated(now - 8 * DAY), ctx)).toBe(false);
  });
});

describe('reportDeviceTrustRefusal', () => {
  it('says a refusal once at error, then at debug', () => {
    resetReportedDeviceTrustRefusals();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const refusal = new DeviceTrustRefusedError('signature-key-changed', 'bob', 'web-2');

    expect(reportDeviceTrustRefusal('[T]', 'g1', refusal)).toBe(true);
    expect(reportDeviceTrustRefusal('[T]', 'g2', refusal)).toBe(false);

    expect(error).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledTimes(1);
    error.mockRestore();
    debug.mockRestore();
  });
});

// A NEW PERSON WHO BROUGHT THEMSELVES IN: the admitted user signed the commit (an external commit -
// the joiner is its own sender) and held no leaf before it. Read from the signed commit alone, so a
// server that stays silent cannot hide it.
describe('entersUninvited - an entry no member made', () => {
  it('is a user absent from the tree who signed their own admission', () => {
    expect(
      entersUninvited(
        event({ identity: 'mallory:dev1', addedBy: 'mallory:dev1', memberAlreadyPresent: false })
      )
    ).toBe(true);
  });

  it('reads the user half canonically', () => {
    expect(
      entersUninvited(
        event({ identity: 'mallory:dev1', addedBy: 'Mallory:dev1', memberAlreadyPresent: false })
      )
    ).toBe(true);
  });

  it('is not a commit another device signed, even of the same user', () => {
    // A member's Add is signed by a device already in the tree, never by the leaf it admits.
    expect(
      entersUninvited(
        event({ identity: 'mallory:dev2', addedBy: 'mallory:dev1', memberAlreadyPresent: false })
      )
    ).toBe(false);
  });

  it('is not a new person a member added', () => {
    expect(
      entersUninvited(
        event({ identity: 'carol:dev1', addedBy: 'alice:dev1', memberAlreadyPresent: false })
      )
    ).toBe(false);
  });

  it('is not a member bringing in their own new device', () => {
    expect(
      entersUninvited(
        event({ identity: 'bob:web-2', addedBy: 'bob:web-2', memberAlreadyPresent: true })
      )
    ).toBe(false);
  });

  it('is never an event recorded before memberAlreadyPresent existed, nor a joined tree', () => {
    expect(
      entersUninvited(
        event({
          identity: 'mallory:dev1',
          addedBy: 'mallory:dev1',
          memberAlreadyPresent: undefined,
        })
      )
    ).toBe(false);
    expect(
      entersUninvited(
        event({ identity: 'mallory:dev1', addedBy: null, memberAlreadyPresent: false })
      )
    ).toBe(false);
  });
});

describe('a further device of a member that admitted itself (owner, 2026-10-31)', () => {
  it('is announced exactly like one a member added, and is no uninvited entry', () => {
    const selfEntry = event({ addedBy: 'Bob:web-2' });
    const memberAdd = event({ addedBy: 'bob:phone-1' });
    for (const ctx of [
      { ...alice, isKeyDistributionGroup: false },
      { ownUserId: 'bob', ownDeviceId: 'phone-1', isKeyDistributionGroup: false },
    ]) {
      expect(deviceEventAudience(selfEntry, ctx)).toBe(deviceEventAudience(memberAdd, ctx));
    }
    expect(deviceEventAudience(selfEntry, { ...alice, isKeyDistributionGroup: false })).toBe(
      'contact-line'
    );
    expect(
      deviceEventAudience(selfEntry, {
        ownUserId: 'bob',
        ownDeviceId: 'phone-1',
        isKeyDistributionGroup: false,
      })
    ).toBe('owner-alert');
    expect(entersUninvited(selfEntry)).toBe(false);
  });

  it('under a key already pinned is the same device, announced by nobody', () => {
    expect(announcesNewDevice(event({ addedBy: 'bob:web-2', trust: 'pinned' }))).toBe(false);
  });
});
