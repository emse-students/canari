// @vitest-environment happy-dom
import type { IStorage } from '$lib/db/types';
import { ed25519PublicKeyOf, webCryptoEngine } from '$lib/crypto/graineV2.testEngine';
import {
  encodeAdmissionVoucher,
  encodeDirectAdmission,
  mintInviteLinkGrant,
  redeemInviteLinkGrant,
  type AdmissionPlace,
} from '$lib/crypto/graineAdmission';
import type { DeviceSignatureKeys } from '$lib/mls-client/deviceKeyPackage';
import type { DevicePin } from '$lib/mls-client/deviceTrust';
import {
  canonicalIdentity,
  canonicalUserId,
  sameDeviceIdentity,
} from '$lib/mls-client/leafIdentity';
import { setGraineRuntime } from './runtime';
import { admissionProven, admissionVerdict, observeAdmissionState } from './admissionGate';

/**
 * The admission gate against a server that lies (channel-encryption section 25): it may publish a
 * device key of its own under a real member's name, backdate a roster row, re-admit a removed member
 * with the voucher they had before, or drop a signer from the roster. Each row below is one of those.
 */

const listWorkspaceMembers = vi.fn();
vi.mock('$lib/services/ChannelService', () => ({
  ChannelService: class {
    listWorkspaceMembers(...args: unknown[]) {
      return listWorkspaceMembers(...args);
    }
  },
}));

const BEFORE_THE_PROOF = '2026-01-01T00:00:00.000Z';
const AFTER_THE_PROOF = '2026-12-01T00:00:00.000Z';
const KG = 'kg-1';

function member(
  userId: string,
  joinedAt = BEFORE_THE_PROOF,
  extra: { isCreator?: boolean; admissionVoucher?: string | null } = {}
) {
  return { id: `m-${userId}`, userId, role: 'member', joinedAt, ...extra };
}

const CAROL_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 100 + i);
const FORGED_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 7 + i);
const MALLORY_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 150 + i);
const ALICE_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 60 + i);
let ALICE_PK: Uint8Array;
let CAROL_PK: Uint8Array;
let FORGED_PK: Uint8Array;
let MALLORY_PK: Uint8Array;

/** The key group as this device merged it: its leaves, their keys, its epoch. */
const keys = new Map<string, Uint8Array>();
let leaves: string[] = [];
let epoch = 5;
/** Whether this device has merged everything the server holds for the key group (`isGroupDrained`). */
let drained = true;
/** Who waits on `whenGroupDrained` - woken by {@link drainNow}, as the MLS layer's events wake them. */
let drainWaiters: Array<() => void> = [];
/** The key group drains: `isGroupDrained` holds, and every `whenGroupDrained` waiter is woken. */
function drainNow() {
  drained = true;
  const woken = drainWaiters;
  drainWaiters = [];
  for (const wake of woken) wake();
}
/**
 * The MLS layer's pins (`pinnedSignatureKeys`, #2268): the keys it saw for a device in a signed
 * tree. carol:dev-c is pinned; a device the server invents is not.
 */
const pins = new Map<string, DevicePin>();
/** A pin as the MLS layer reports it; `anchored: false` is a pin re-learned after a prune. */
function pin(pinned: Uint8Array[], anchored = true): DevicePin {
  return { keys: pinned, anchored, reaffirmations: 0 };
}
/**
 * The MLS layer's departures (`removalEpochs`, #2268): the epochs at which a merged commit removed
 * a user's last leaf - live or caught up; a device repair is one commit and records none.
 */
const departures = new Map<string, number[]>();
/** What the SERVER publishes for a device - never to be believed for a voucher signer. */
let published: DeviceSignatureKeys = { kind: 'keys', keys: [] };

beforeAll(async () => {
  CAROL_PK = await ed25519PublicKeyOf(CAROL_SECRET);
  FORGED_PK = await ed25519PublicKeyOf(FORGED_SECRET);
  MALLORY_PK = await ed25519PublicKeyOf(MALLORY_SECRET);
  ALICE_PK = await ed25519PublicKeyOf(ALICE_SECRET);
});

beforeEach(() => {
  localStorage.clear();
  listWorkspaceMembers.mockReset();
  keys.clear();
  keys.set('alice:alice-laptop', new Uint8Array(32).fill(1));
  keys.set('carol:dev-c', CAROL_PK);
  leaves = ['alice:alice-laptop', 'carol:dev-c'];
  epoch = 5;
  drained = true;
  drainWaiters = [];
  published = { kind: 'keys', keys: [] };
  pins.clear();
  pins.set('carol:dev-c', pin([CAROL_PK]));
  departures.clear();
  installRuntime('alice');
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

/** This device's Graine runtime, signed in as `userId` - spelled as the session spells it. */
function installRuntime(userId: string) {
  setGraineRuntime({
    storage: {} as IStorage,
    deviceKey: () => 'device-key',
    userId,
    mlsService: {
      getGroupMemberIdentities: async () => [...leaves],
      // As Rust matches them: one canonical identity (`identity_names`, `pin_naming`).
      memberSignatureKey: async (_g: string, identity: string) => {
        const leaf = leaves.find((l) => sameDeviceIdentity(l, identity));
        return leaf ? (keys.get(leaf) ?? null) : null;
      },
      getEpoch: () => epoch,
      isGroupDrained: () => drained,
      whenGroupDrained: () =>
        drained ? Promise.resolve() : new Promise<void>((wake) => drainWaiters.push(wake)),
      pinnedSignatureKeys: async (user: string, deviceId: string) =>
        pins.get(canonicalIdentity(`${user}:${deviceId}`) ?? '') ?? null,
      removalEpochs: async (_g: string, user: string) =>
        departures.get(canonicalUserId(user)) ?? [],
      fetchDeviceSignatureKeys: async () => published,
      graineSignatureEngine: () => webCryptoEngine,
      getDeviceId: () => 'alice-laptop',
    } as never,
  });
}

afterEach(() => {
  setGraineRuntime(null);
  vi.restoreAllMocks();
});

/** A direct voucher: `signer` admitted `subject` at `place`, signed with `secret`. */
async function voucher(
  subject: string,
  signer: { userId: string; deviceId: string },
  secret: Uint8Array,
  place: AdmissionPlace = { keyGroupId: KG, epoch }
) {
  const statement = {
    workspaceId: 'ws-1',
    subjectUserId: subject,
    signer,
    place,
    issuedAt: 1_800_000_000_000,
  };
  return encodeAdmissionVoucher({
    kind: 'direct',
    ...statement,
    signature: await webCryptoEngine.signWithSessionKey(secret, encodeDirectAdmission(statement)),
  });
}

const carol = { userId: 'carol', deviceId: 'dev-c' };

describe('a voucher signer is checked against the tree or the MLS layer pins, never the server', () => {
  it('REFUSES a voucher signed by a device the server published for a rooted member', async () => {
    // The server invents carol:dev-forged, publishes its key, and signs with it.
    published = { kind: 'keys', keys: [FORGED_PK] };
    listWorkspaceMembers.mockResolvedValue([
      member('alice'),
      member('carol'),
      member('newcomer', AFTER_THE_PROOF, {
        admissionVoucher: await voucher(
          'newcomer',
          { userId: 'carol', deviceId: 'dev-forged' },
          FORGED_SECRET
        ),
      }),
    ]);
    leaves.push('newcomer:dev-n');

    expect(await admissionProven('ws-1', KG, 'newcomer')).toBe(false);
  });

  it('keeps verifying a signer device that has since left the tree, under its pinned key', async () => {
    listWorkspaceMembers.mockResolvedValue([member('alice'), member('carol')]);
    await observeAdmissionState('ws-1', KG);

    // carol's phone is lost and leaves the tree; she stays a member on another device.
    keys.set('carol:dev-c2', new Uint8Array(32).fill(9));
    leaves = ['alice:alice-laptop', 'carol:dev-c2', 'newcomer:dev-n'];
    listWorkspaceMembers.mockResolvedValue([
      member('alice'),
      member('carol'),
      member('newcomer', AFTER_THE_PROOF, {
        admissionVoucher: await voucher('newcomer', carol, CAROL_SECRET),
      }),
    ]);

    expect(await admissionProven('ws-1', KG, 'newcomer')).toBe(true);
  });

  it('accepts a signature that verifies under ANY of the keys pinned for the device', async () => {
    pins.set('carol:dev-c2', pin([new Uint8Array(32).fill(4), CAROL_PK]));
    leaves.push('newcomer:dev-n');
    listWorkspaceMembers.mockResolvedValue([
      member('alice'),
      member('carol'),
      member('newcomer', AFTER_THE_PROOF, {
        admissionVoucher: await voucher(
          'newcomer',
          { userId: 'carol', deviceId: 'dev-c2' },
          CAROL_SECRET
        ),
      }),
    ]);

    expect(await admissionProven('ws-1', KG, 'newcomer')).toBe(true);
  });

  it('leaves unproven a signer that verifies only under a pin re-learned after a prune', async () => {
    // carol's phone left the tree, and its pin was pruned then re-learned from a later tree: the
    // signature verifies, but under a pin nobody anchored. Fail closed - the newcomer reads from
    // arrival on.
    pins.set('carol:dev-c', pin([CAROL_PK], false));
    listWorkspaceMembers.mockResolvedValue([member('alice'), member('carol')]);
    await observeAdmissionState('ws-1', KG);
    leaves = ['alice:alice-laptop', 'newcomer:dev-n'];
    listWorkspaceMembers.mockResolvedValue([
      member('alice'),
      member('carol'),
      member('newcomer', AFTER_THE_PROOF, {
        admissionVoucher: await voucher('newcomer', carol, CAROL_SECRET),
      }),
    ]);

    expect(await admissionProven('ws-1', KG, 'newcomer')).toBe(false);
  });
});

describe('roots are recorded at the first sync, from members present in the key group', () => {
  it('never roots a roster row with no leaf in the tree, however early its date', async () => {
    keys.set('mallory:dev-m', MALLORY_PK);
    listWorkspaceMembers.mockResolvedValue([
      member('alice'),
      member('carol'),
      member('mallory'),
      member('newcomer', AFTER_THE_PROOF, {
        admissionVoucher: await voucher(
          'newcomer',
          { userId: 'mallory', deviceId: 'dev-m' },
          MALLORY_SECRET
        ),
      }),
    ]);
    leaves.push('newcomer:dev-n');

    expect(await admissionProven('ws-1', KG, 'mallory')).toBe(false);
    expect(await admissionProven('ws-1', KG, 'newcomer')).toBe(false);
  });

  it('records the roots at the first community sync, before any ask', async () => {
    listWorkspaceMembers.mockResolvedValue([member('alice'), member('carol')]);
    await observeAdmissionState('ws-1', KG);

    // Later, the server shows a backdated member who has since joined the tree.
    leaves.push('mallory:dev-m');
    listWorkspaceMembers.mockResolvedValue([member('alice'), member('carol'), member('mallory')]);

    expect(await admissionProven('ws-1', KG, 'mallory')).toBe(false);
    expect(await admissionProven('ws-1', KG, 'carol')).toBe(true);
  });
});

describe('a removal the MLS layer recorded at merge ends the admissions before it', () => {
  it('a removed member who comes back with their old voucher reads from arrival on', async () => {
    const old = await voucher('newcomer', carol, CAROL_SECRET, { keyGroupId: KG, epoch: 5 });
    leaves.push('newcomer:dev-n');
    listWorkspaceMembers.mockResolvedValue([
      member('alice'),
      member('carol'),
      member('newcomer', AFTER_THE_PROOF, { admissionVoucher: old }),
    ]);
    expect(await admissionProven('ws-1', KG, 'newcomer')).toBe(true);

    // Kicked at epoch 8 - a commit this device merged, live or on catch-up - then back by an
    // external commit with the voucher they had before.
    departures.set('newcomer', [8]);
    epoch = 10;
    leaves = ['alice:alice-laptop', 'carol:dev-c', 'newcomer:dev-n2'];
    listWorkspaceMembers.mockResolvedValue([
      member('alice'),
      member('carol'),
      member('newcomer', '2026-12-05T00:00:00.000Z', { admissionVoucher: old }),
    ]);
    expect(await admissionProven('ws-1', KG, 'newcomer')).toBe(false);

    // Re-admitted for real: a voucher signed after the removal.
    listWorkspaceMembers.mockResolvedValue([
      member('alice'),
      member('carol'),
      member('newcomer', '2026-12-05T00:00:00.000Z', {
        admissionVoucher: await voucher('newcomer', carol, CAROL_SECRET, {
          keyGroupId: KG,
          epoch: 10,
        }),
      }),
    ]);
    expect(await admissionProven('ws-1', KG, 'newcomer')).toBe(true);
  });

  it('a repair - the device removed and re-added in ONE commit (replaceMember) - keeps the admission', async () => {
    leaves.push('newcomer:dev-n');
    listWorkspaceMembers.mockResolvedValue([
      member('alice'),
      member('carol'),
      member('newcomer', AFTER_THE_PROOF, {
        admissionVoucher: await voucher('newcomer', carol, CAROL_SECRET, {
          keyGroupId: KG,
          epoch: 5,
        }),
      }),
    ]);
    expect(await admissionProven('ws-1', KG, 'newcomer')).toBe(true);

    // A device repair is one commit that never empties the user's leaves: no departure is recorded.
    epoch = 7;
    leaves = ['alice:alice-laptop', 'carol:dev-c', 'newcomer:dev-n'];

    expect(await admissionProven('ws-1', KG, 'newcomer')).toBe(true);
  });
});

describe('a signer counts as of when THIS device first observed the voucher, not as of now', () => {
  it('a voucher from a member of the old bureau, observed before they left, still admits', async () => {
    listWorkspaceMembers.mockResolvedValue([member('alice'), member('carol')]);
    await observeAdmissionState('ws-1', KG);
    const signedBefore = await voucher('newcomer', carol, CAROL_SECRET, {
      keyGroupId: KG,
      epoch: 5,
    });
    // This device's sync sees the newcomer's row, voucher included, at epoch 6.
    epoch = 6;
    listWorkspaceMembers.mockResolvedValue([
      member('alice'),
      member('carol'),
      member('newcomer', AFTER_THE_PROOF, { admissionVoucher: signedBefore }),
    ]);
    await observeAdmissionState('ws-1', KG);

    // carol leaves the community at epoch 7: off the roster, out of the tree.
    departures.set('carol', [7]);
    epoch = 7;
    leaves = ['alice:alice-laptop', 'newcomer:dev-n'];
    listWorkspaceMembers.mockResolvedValue([
      member('alice'),
      member('newcomer', AFTER_THE_PROOF, { admissionVoucher: signedBefore }),
    ]);

    expect(await admissionProven('ws-1', KG, 'newcomer')).toBe(true);
  });

  it('a removed signer BACKDATING a voucher to before their removal admits nobody', async () => {
    listWorkspaceMembers.mockResolvedValue([member('alice'), member('carol')]);
    await observeAdmissionState('ws-1', KG);
    // carol is removed at epoch 7; her pinned key still signs, and she writes epoch 5 into it.
    departures.set('carol', [7]);
    epoch = 9;
    leaves = ['alice:alice-laptop', 'newcomer:dev-n'];
    listWorkspaceMembers.mockResolvedValue([
      member('alice'),
      member('newcomer', AFTER_THE_PROOF, {
        admissionVoucher: await voucher('newcomer', carol, CAROL_SECRET, {
          keyGroupId: KG,
          epoch: 5,
        }),
      }),
    ]);

    expect(await admissionProven('ws-1', KG, 'newcomer')).toBe(false);
  });

  it('observes nothing while a commit of the key group is still held - a pending removal included', async () => {
    listWorkspaceMembers.mockResolvedValue([member('alice'), member('carol')]);
    await observeAdmissionState('ws-1', KG);
    // carol was removed at epoch 7 while this device was away: the commit waits in its mailbox,
    // unmerged, and the roster already shows a voucher she backdated to epoch 5.
    drained = false;
    epoch = 6;
    leaves = ['alice:alice-laptop', 'carol:dev-c', 'newcomer:dev-n'];
    listWorkspaceMembers.mockResolvedValue([
      member('alice'),
      member('newcomer', AFTER_THE_PROOF, {
        admissionVoucher: await voucher('newcomer', carol, CAROL_SECRET, {
          keyGroupId: KG,
          epoch: 5,
        }),
      }),
    ]);
    await observeAdmissionState('ws-1', KG);
    expect(await admissionProven('ws-1', KG, 'newcomer')).toBe(false);

    // The commit is merged: the voucher is first observed now, after carol's removal.
    departures.set('carol', [7]);
    epoch = 7;
    drained = true;
    leaves = ['alice:alice-laptop', 'newcomer:dev-n'];
    expect(await admissionProven('ws-1', KG, 'newcomer')).toBe(false);
  });

  it('at start-up, observes a voucher the moment the first full pull drains the key group', async () => {
    leaves.push('newcomer:dev-n');
    listWorkspaceMembers.mockResolvedValue([
      member('alice'),
      member('carol'),
      member('newcomer', AFTER_THE_PROOF, {
        admissionVoucher: await voucher('newcomer', carol, CAROL_SECRET),
      }),
    ]);
    // The start-up sync runs before the first pull has listed the mailbox.
    drained = false;
    await observeAdmissionState('ws-1', KG);
    expect(await admissionVerdict('ws-1', KG, 'newcomer')).toBe('unobserved');

    // The pull empties the mailbox: the observation follows the drain, with no sync and no ask.
    const info = vi.mocked(console.info);
    drainNow();
    await vi.waitFor(() =>
      expect(info.mock.calls.flat().join(' ')).toContain('admission vouchers observed')
    );

    // Recorded: a later undrained moment no longer matters to this voucher.
    drained = false;
    expect(await admissionVerdict('ws-1', KG, 'newcomer')).toBe('proven');
  });

  it('refuses a voucher that claims a place after the one this device first saw it at', async () => {
    leaves.push('newcomer:dev-n');
    listWorkspaceMembers.mockResolvedValue([
      member('alice'),
      member('carol'),
      member('newcomer', AFTER_THE_PROOF, {
        admissionVoucher: await voucher('newcomer', carol, CAROL_SECRET, {
          keyGroupId: KG,
          epoch: 9,
        }),
      }),
    ]);

    expect(await admissionProven('ws-1', KG, 'newcomer')).toBe(false);
  });

  it('after a ledger loss, the observation restarts: a late-seeing device grants less, never more', async () => {
    listWorkspaceMembers.mockResolvedValue([member('alice'), member('carol')]);
    await observeAdmissionState('ws-1', KG);
    const genuine = await voucher('newcomer', carol, CAROL_SECRET, { keyGroupId: KG, epoch: 5 });
    leaves.push('newcomer:dev-n');
    listWorkspaceMembers.mockResolvedValue([
      member('alice'),
      member('carol'),
      member('newcomer', AFTER_THE_PROOF, { admissionVoucher: genuine }),
    ]);
    expect(await admissionProven('ws-1', KG, 'newcomer')).toBe(true);

    // carol is removed at epoch 7 and back at 8, still a root. While the ledger holds, the voucher
    // was observed at epoch 5, before her removal, and admits.
    departures.set('carol', [7]);
    epoch = 8;
    expect(await admissionProven('ws-1', KG, 'newcomer')).toBe(true);

    // The ledger is lost: every voucher is observed anew, NOW - after carol's removal - so hers no
    // longer admits on this device. Less past on a device that saw late, never more.
    localStorage.clear();
    expect(await admissionProven('ws-1', KG, 'newcomer')).toBe(false);
  });

  it('a voucher signed after the signer was removed admits nobody', async () => {
    listWorkspaceMembers.mockResolvedValue([member('alice'), member('carol')]);
    await observeAdmissionState('ws-1', KG);
    departures.set('carol', [7]);
    leaves = ['alice:alice-laptop'];

    epoch = 9;
    leaves.push('newcomer:dev-n');
    listWorkspaceMembers.mockResolvedValue([
      member('alice'),
      member('newcomer', AFTER_THE_PROOF, {
        admissionVoucher: await voucher('newcomer', carol, CAROL_SECRET, {
          keyGroupId: KG,
          epoch: 9,
        }),
      }),
    ]);

    expect(await admissionProven('ws-1', KG, 'newcomer')).toBe(false);
  });
});

describe('an invite link admits only until the expiry signed into it', () => {
  /** The instant this device first observes the voucher - its own clock, an upper bound only. */
  const OBSERVED_AT = 1_800_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(OBSERVED_AT);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A link carol's device showed, expiring at `expiresAt`, redeemed by the newcomer. */
  async function linkVoucher(expiresAt: number) {
    const grant = await mintInviteLinkGrant(
      'ws-1',
      carol,
      { keyGroupId: KG, epoch: 5 },
      OBSERVED_AT - 1000,
      expiresAt,
      webCryptoEngine,
      (m) => webCryptoEngine.signWithSessionKey(CAROL_SECRET, m)
    );
    return encodeAdmissionVoucher(await redeemInviteLinkGrant(grant, 'newcomer', webCryptoEngine));
  }

  async function provenWith(admissionVoucher: string) {
    leaves.push('newcomer:dev-n');
    listWorkspaceMembers.mockResolvedValue([
      member('alice'),
      member('carol'),
      member('newcomer', AFTER_THE_PROOF, { admissionVoucher }),
    ]);
    return admissionProven('ws-1', KG, 'newcomer');
  }

  it('admits through a link observed before its expiry', async () => {
    expect(await provenWith(await linkVoucher(OBSERVED_AT + 60_000))).toBe(true);
  });

  it('does not admit through a link first observed after its expiry', async () => {
    expect(await provenWith(await linkVoucher(OBSERVED_AT - 1))).toBe(false);
  });
});

describe('identities compare in their ONE canonical form (leafIdentity.ts), as Rust compares them', () => {
  it('roots a member however the roster, the tree and the ask each spell their id', async () => {
    // A user id is printable ASCII (#2276), and canonicalUserId lowercases its letters, as Rust's
    // `to_ascii_lowercase` does: three spellings, one member.
    keys.set('ELODIE:dev-e', new Uint8Array(32).fill(5));
    leaves.push('ELODIE:dev-e');
    listWorkspaceMembers.mockResolvedValue([member('alice'), member('carol'), member('Elodie')]);

    expect(await admissionProven('ws-1', KG, 'elodie')).toBe(true);
  });

  it('counts a voucher this device signed, whatever case the session spells its user in', async () => {
    // This device is always admitted; its session spells the user 'ALICE', whose own row is late.
    installRuntime('ALICE');
    keys.set('alice:alice-laptop', ALICE_PK);
    leaves = ['alice:alice-laptop', 'newcomer:dev-n'];
    listWorkspaceMembers.mockResolvedValue([
      member('alice', AFTER_THE_PROOF),
      member('newcomer', AFTER_THE_PROOF, {
        admissionVoucher: await voucher(
          'newcomer',
          { userId: 'ALICE', deviceId: 'alice-laptop' },
          ALICE_SECRET
        ),
      }),
    ]);

    expect(await admissionProven('ws-1', KG, 'newcomer')).toBe(true);
  });

  it('finds a signer in the tree when the voucher spells its user in another case', async () => {
    pins.clear();
    leaves.push('newcomer:dev-n');
    listWorkspaceMembers.mockResolvedValue([
      member('alice'),
      member('carol'),
      member('newcomer', AFTER_THE_PROOF, {
        admissionVoucher: await voucher(
          'NewComer',
          { userId: 'Carol', deviceId: 'dev-c' },
          CAROL_SECRET
        ),
      }),
    ]);

    expect(await admissionProven('ws-1', KG, 'newcomer')).toBe(true);
  });
});
