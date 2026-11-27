// @vitest-environment happy-dom
import {
  canOfferHistoryTo,
  grantSinceFor,
  floorDrawsGrantNotice,
  HISTORY_GRANT_NOTICE_FIRST_VERSION,
  grantSinceForDate,
  historyGrantPayload,
  issuedGrantFor,
  liftArrivalSpan,
  noteIssuedGrant,
  parseHistoryGrant,
  type HistoryGrant,
} from './historyGrant';
import { forgetHistoryAsks, takeAddressedAsk } from './historyAddressing';
import { dropOwnExcludedMessages, readerHistorySelection } from './historyEntitlement';
import { sendHistoryGrantAsk } from './groupActions';
import { visibleNoticeSpec } from './visibleNotices';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';
import { decodeAppMessage } from '$lib/proto/codec';
import type { IStorage } from '$lib/db';
import type { ExclusionWindow } from '$lib/mls-client/mlsDeliveryApi';

/**
 * A member sends their history to a newcomer (owner, 2026-11-25): each layer of the grant -
 * docs/wiki/protocols/history-reconciliation.md#a-member-may-send-their-history-to-a-newcomer-owner-2026-11-25.
 */
const GROUP = 'g1';
const ARRIVAL = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const GRANT: HistoryGrant = {
  grantId: 'grant-0001',
  newcomer: 'newbie',
  granter: 'alice:alice-phone',
  since: ARRIVAL - 7 * DAY,
};

describe('the grant frame', () => {
  it('reads back what it was written as, checked against the sender', () => {
    const read = parseHistoryGrant(historyGrantPayload(GRANT), 'alice', 'alice-phone');
    expect(read).toEqual({ grant: GRANT });
  });

  it('refuses a grant in another member s name, or naming another device of the sender', () => {
    expect(parseHistoryGrant(historyGrantPayload(GRANT), 'mallory')).toEqual({
      refused: 'granter-is-not-the-sender',
    });
    expect(parseHistoryGrant(historyGrantPayload(GRANT), 'alice', 'alice-laptop')).toEqual({
      refused: 'granter-is-not-the-sender',
    });
  });

  it('refuses a grant to oneself, and a malformed one', () => {
    expect(
      parseHistoryGrant(historyGrantPayload({ ...GRANT, newcomer: 'alice' }), 'alice')
    ).toEqual({ refused: 'grant-to-self' });
    expect(parseHistoryGrant({ ...historyGrantPayload(GRANT), since: -1 }, 'alice')).toEqual({
      refused: 'malformed',
    });
    expect(parseHistoryGrant({ ...historyGrantPayload(GRANT), grantId: 'x' }, 'alice')).toEqual({
      refused: 'malformed',
    });
    expect(parseHistoryGrant({ ...historyGrantPayload(GRANT), granter: 'alice' }, 'alice')).toEqual(
      { refused: 'malformed' }
    );
  });

  it('draws the notice for every member, and none for a forged one', () => {
    expect(visibleNoticeSpec('historyGranted', historyGrantPayload(GRANT), 'alice')).toEqual({
      event: 'historyGranted',
      actor: 'alice',
      targets: ['newbie'],
      since: GRANT.since,
    });
    expect(visibleNoticeSpec('historyGranted', historyGrantPayload(GRANT), 'mallory')).toBeNull();
  });
});

describe('the start date', () => {
  const NOW = ARRIVAL;
  it('maps each shortcut, everything to 0', () => {
    expect(grantSinceFor('24h', NOW)).toBe(NOW - DAY);
    expect(grantSinceFor('7d', NOW)).toBe(NOW - 7 * DAY);
    expect(grantSinceFor('30d', NOW)).toBe(NOW - 30 * DAY);
    expect(grantSinceFor('everything', NOW)).toBe(0);
  });

  it('takes a past calendar date at its local midnight, and refuses a future or broken one', () => {
    expect(grantSinceForDate('2023-01-02', NOW)).toBe(new Date(2023, 0, 2).getTime());
    expect(grantSinceForDate('2999-01-01', NOW)).toBeNull();
    expect(grantSinceForDate('nope', NOW)).toBeNull();
  });
});

describe('the lift - the arrival span only, never a gap', () => {
  const GAP: ExclusionWindow = { from: ARRIVAL - 20 * DAY, until: ARRIVAL - 10 * DAY };
  const SPAN: ExclusionWindow = { from: 0, until: ARRIVAL };

  it('starts the arrival span at the grant date and keeps every gap', () => {
    expect(liftArrivalSpan([SPAN, GAP], ARRIVAL - 30 * DAY)).toEqual([
      { from: 0, until: ARRIVAL - 30 * DAY },
      GAP,
    ]);
  });

  it('lifts the span whole for everything', () => {
    expect(liftArrivalSpan([SPAN, GAP], 0)).toEqual([GAP]);
  });

  it('never widens the span, and keeps a span with no arrival', () => {
    expect(liftArrivalSpan([SPAN], ARRIVAL + DAY)).toEqual([SPAN]);
    expect(liftArrivalSpan([{ from: 0, until: null }], 0)).toEqual([{ from: 0, until: null }]);
  });
});

describe('the button - offered for a newcomer of a private group only', () => {
  const group = { conversationType: 'group' as const, lifecycle: 'active' as const };
  const base = {
    conversation: group,
    target: 'newbie',
    self: 'alice',
    members: ['alice', 'newbie'],
    minClientVersion: HISTORY_GRANT_NOTICE_FIRST_VERSION,
  };

  it('is offered for an added member of a ready private group', () => {
    expect(canOfferHistoryTo(base)).toBe(true);
  });

  // Principle 1: the exception rests on the notice every member reads, so it is offered only while
  // no build admitted by the server's floor would receive the hand-over without drawing it.
  it('is hidden while the served client floor is below the first build that draws the notice', () => {
    expect(HISTORY_GRANT_NOTICE_FIRST_VERSION).toBe('1.8.3-alpha.1');
    expect(canOfferHistoryTo({ ...base, minClientVersion: '1.7.0' })).toBe(false);
    expect(canOfferHistoryTo({ ...base, minClientVersion: null })).toBe(false);
    expect(canOfferHistoryTo({ ...base, minClientVersion: '1.8.3' })).toBe(true);
    expect(canOfferHistoryTo({ ...base, minClientVersion: '1.9.0' })).toBe(true);
  });

  it('is never offered to oneself, nor for a person no longer a member', () => {
    expect(canOfferHistoryTo({ ...base, target: 'Alice' })).toBe(false);
    expect(canOfferHistoryTo({ ...base, members: ['alice'] })).toBe(false);
  });

  it('is never offered in a 1:1, a community salon, "Mes notes", or a group not ready', () => {
    for (const conversationType of ['direct', 'channel', 'self'] as const) {
      expect(canOfferHistoryTo({ ...base, conversation: { ...group, conversationType } })).toBe(
        false
      );
    }
    expect(
      canOfferHistoryTo({ ...base, conversation: { ...group, lifecycle: 'pending' as const } })
    ).toBe(false);
  });
});

describe('the issued grants - what the granter answers from', () => {
  beforeEach(() => localStorage.clear());

  it('answers the grant it issued, to that person, in that conversation only', () => {
    expect(noteIssuedGrant('alice', GROUP, GRANT)).toBe(true);
    expect(issuedGrantFor('alice', GROUP, GRANT.grantId, 'NEWBIE')).toEqual(GRANT);
    expect(issuedGrantFor('alice', GROUP, GRANT.grantId, 'mallory')).toBeNull();
    expect(issuedGrantFor('alice', 'g2', GRANT.grantId, 'newbie')).toBeNull();
    expect(issuedGrantFor('alice', GROUP, 'grant-9999', 'newbie')).toBeNull();
    expect(issuedGrantFor('bob', GROUP, GRANT.grantId, 'newbie')).toBeNull();
  });
});

describe('the sealed ask under a grant', () => {
  beforeEach(() => forgetHistoryAsks());

  async function askUnderGrant() {
    const mlsService = createMlsServiceStub();
    const storage = {
      getMessages: vi.fn().mockResolvedValue([]),
      getConversation: vi.fn().mockResolvedValue(null),
    } as unknown as IStorage;
    const sent = await sendHistoryGrantAsk(GROUP, GRANT, 'newbie:newbie-phone', {
      mlsService,
      log: vi.fn(),
      storage,
      deviceKeyB64: 'k',
    });
    const [[, bytes]] = vi.mocked(mlsService.sendMessage).mock.calls;
    const decoded = decodeAppMessage(bytes as Uint8Array);
    return {
      sent,
      event: decoded?.system?.event,
      payload: JSON.parse(decoded?.system?.data || '{}'),
    };
  }

  it('names the granter, the grant, a request id and a key', async () => {
    const { sent, event, payload } = await askUnderGrant();
    expect(sent).toBe(true);
    expect(event).toBe('history_grant_ask');
    expect(payload).toMatchObject({
      from: 'newbie:newbie-phone',
      to: GRANT.granter,
      grantId: GRANT.grantId,
    });
    expect(typeof payload.requestId).toBe('string');
    expect(typeof payload.answerKey).toBe('string');
    expect(payload.since).toBeGreaterThanOrEqual(GRANT.since);
  });

  it('takes an answer from the granting device alone', async () => {
    const { payload } = await askUnderGrant();
    expect(takeAddressedAsk(GROUP, payload.requestId, 'carol:carol-phone', true).refused).toBe(
      'not-the-granter'
    );
    expect(takeAddressedAsk(GROUP, payload.requestId, 'alice:alice-laptop', true).refused).toBe(
      'not-the-granter'
    );
    const taken = takeAddressedAsk(GROUP, payload.requestId, 'alice:alice-phone', true).taken;
    expect(taken?.ask).toMatchObject({ kind: 'digest', grant: { grantId: GRANT.grantId } });
  });
});

describe('the answer and the receiver - lifted from the grant date, gaps still withheld', () => {
  const GAP: ExclusionWindow = { from: ARRIVAL - 3 * DAY, until: ARRIVAL - 2 * DAY };
  const windows = new Map([['newbie', [{ from: 0, until: ARRIVAL }, GAP]]]);
  const msg = (id: string, at: number) => ({ id, timestamp: at, serverTimestamp: at });
  const BEFORE_GRANT = msg('before-grant', ARRIVAL - 10 * DAY);
  const IN_GAP = msg('in-gap', ARRIVAL - 2.5 * DAY);
  const GRANTED = msg('granted', ARRIVAL - 5 * DAY);
  const AFTER = msg('after', ARRIVAL + DAY);
  const all = [BEFORE_GRANT, IN_GAP, GRANTED, AFTER];

  function deps() {
    const mlsService = createMlsServiceStub();
    vi.mocked(mlsService.getGroupWithheld).mockResolvedValue(windows);
    return { mlsService, log: vi.fn() };
  }

  it('the granter selects from the grant date, keeping the gap withheld', async () => {
    const chosen = await readerHistorySelection(GROUP, all, deps(), 'newbie', GRANT.since);
    expect(chosen?.kept.map((m) => m.id)).toEqual(['granted', 'after']);
  });

  it('without a grant, nothing before the arrival is selected', async () => {
    const chosen = await readerHistorySelection(GROUP, all, deps(), 'newbie');
    expect(chosen?.kept.map((m) => m.id)).toEqual(['after']);
  });

  it('the receiver lifts its drop for a granted answer only', async () => {
    const lifted = await dropOwnExcludedMessages(GROUP, 'newbie', all, deps(), GRANT.since);
    expect(lifted?.map((m) => m.id)).toEqual(['granted', 'after']);
    const plain = await dropOwnExcludedMessages(GROUP, 'newbie', all, deps());
    expect(plain?.map((m) => m.id)).toEqual(['after']);
  });
});

describe('floorDrawsGrantNotice - the floor names the first BUILD, pre-release included', () => {
  it.each([
    ['1.7.0', false],
    ['1.8.3-alpha.1', true],
    ['1.8.3-alpha.2', true],
    ['1.8.3', true],
    ['1.9.0', true],
    ['1.8.2', false],
    ['1.8.3-alpha.0', false],
    ['', false],
    [null, false],
    [undefined, false],
  ] as const)('floor %s draws the button: %s', (floor, expected) => {
    expect(floorDrawsGrantNotice(floor)).toBe(expected);
  });
});
