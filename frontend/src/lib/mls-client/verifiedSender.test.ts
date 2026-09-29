import {
  assertVerifiedSender,
  checkVerifiedSender,
  SenderMismatchError,
  resetReportedSenderMismatches,
  setSenderMismatchReporter,
  type SenderMismatchReporter,
} from './verifiedSender';

/**
 * WP-G2-1 and G2-1b (channel-encryption section 21.1): the sender a delivery envelope names is
 * compared with the one OpenMLS verified; a disagreement is logged, REPORTED, and then refused.
 */

let reporter: ReturnType<typeof vi.fn<SenderMismatchReporter>>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetReportedSenderMismatches();
  reporter = vi.fn<SenderMismatchReporter>().mockResolvedValue(undefined);
  setSenderMismatchReporter(reporter);
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  setSenderMismatchReporter(null);
  error.mockRestore();
});

describe('checkVerifiedSender', () => {
  it('says nothing when the envelope names the verified user and device', () => {
    expect(
      checkVerifiedSender('g-1', { userId: 'Bob', deviceId: 'dev-b', path: 'live' }, 'bob:dev-b')
    ).toBeNull();
    expect(reporter).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('reports an envelope naming ANOTHER USER, which is what every consumer attributes by', () => {
    expect(checkVerifiedSender('g-1', { userId: 'mallory', path: 'live' }, 'bob:dev-b')).toBe(
      'user'
    );
    expect(reporter).toHaveBeenCalledWith({
      groupId: 'g-1',
      path: 'live',
      kind: 'user',
      envelopeUserId: 'mallory',
      envelopeDeviceId: null,
      verifiedIdentity: 'bob:dev-b',
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('SENDER MISMATCH (user)'));
  });

  it('reports a device the envelope names differently, the half a sender asserts itself', () => {
    expect(
      checkVerifiedSender('g-1', { userId: 'bob', deviceId: 'dev-x', path: 'history' }, 'bob:dev-b')
    ).toBe('device');
    expect(reporter).toHaveBeenCalledWith(expect.objectContaining({ kind: 'device' }));
  });

  it('reports a credential it cannot read, since that frame is one whose sender nobody checked', () => {
    expect(checkVerifiedSender('g-1', { userId: 'bob', path: 'distribution' }, null)).toBe(
      'unverifiable'
    );
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'unverifiable', verifiedIdentity: null })
    );
  });

  it('compares nothing when there is no envelope, or no verified sender on that path', () => {
    expect(checkVerifiedSender('g-1', undefined, 'bob:dev-b')).toBeNull();
    expect(checkVerifiedSender('g-1', { userId: 'mallory', path: 'live' }, undefined)).toBeNull();
    expect(reporter).not.toHaveBeenCalled();
  });

  it('reports one disagreement once, and logs every occurrence', () => {
    for (let i = 0; i < 3; i++) {
      checkVerifiedSender('g-1', { userId: 'mallory', path: 'live' }, 'bob:dev-b');
    }
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(3);

    // Another path is another question: it is reported on its own.
    checkVerifiedSender('g-1', { userId: 'mallory', path: 'history' }, 'bob:dev-b');
    expect(reporter).toHaveBeenCalledTimes(2);
  });

  it('says it could not report when nothing is wired, rather than dropping the measurement', () => {
    setSenderMismatchReporter(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    checkVerifiedSender('g-1', { userId: 'mallory', path: 'live' }, 'bob:dev-b');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no reporter is wired'));
    warn.mockRestore();
  });
});

describe('assertVerifiedSender (WP-G2-1b)', () => {
  it('lets an agreeing frame through', () => {
    expect(() =>
      assertVerifiedSender('g-1', { userId: 'bob', deviceId: 'dev-b', path: 'live' }, 'bob:dev-b')
    ).not.toThrow();
  });

  it('REFUSES a disagreement with a typed error naming its kind, after reporting it', () => {
    let thrown: unknown;
    try {
      assertVerifiedSender('g-1', { userId: 'mallory', path: 'live' }, 'bob:dev-b');
    } catch (e) {
      thrown = e;
    }
    // Typed, because every consumer decides by `instanceof` - never by reading the sentence.
    expect(thrown).toBeInstanceOf(SenderMismatchError);
    expect((thrown as InstanceType<typeof SenderMismatchError>).kind).toBe('user');
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('REFUSED'));
  });

  it('refuses a credential it cannot read', () => {
    expect(() => assertVerifiedSender('g-1', { userId: 'bob', path: 'history' }, null)).toThrow(
      SenderMismatchError
    );
  });
});
