import {
  MLS_MAX_PAST_EPOCHS,
  isBeyondPastEpochWindow,
  mlsFrameEpoch,
  readCommitFrame,
} from './mls-frame-epoch';
import {
  externalCommitBody,
  externalCommitFrame,
  mlsFrame as frame,
} from '../testing/mlsFrameFixture';

const GROUP = '68227a77-0515-43d7-b7ee-2943bfa78f1f';

/** An external join and an external rejoin, as openmls 0.9.1 serialises them (test keys only). */
const OPENMLS_EXTERNAL_JOIN =
  'AAEAAQlnLWZpeHR1cmUAAAAAAAAAAQQAAyQBAAYgOCLkSd2kNbHIU+XR3oxNCyuuPMDptWtWQkvRhomzRWsBIFkuVwY4iSGN02zJnZcokkMZEEjXaa5YgrICogi6WEJPIAlHohaXM/nICLkuTUHJbTqrtgc7PQyQd55DZSrVADfDAAEMdXNlci1jOmRldi1jAgABBgABAAIAAwAAAgABAyBNH5VPQmEJCaaCMS5RHKcI1CdfstCIkst4GZFrVRzIdABAQEkZTINTLBCc9D5us2cjJo2WZ5hkNEF1LF2t+CH1bvzyw7sqbvvRJLwDP+tG9udsPD75/hPiHTOkR6QjMk3AGw9AdSDqTrXs0vxWfAyEzNCcEJJjvu9watUBAkSBFoh4TLDldkBSIIz5Kqs1HtMLgMAexNg1EyeCzBwtl8RoIjw6JA6gfG1DMF6WL/xcV8duKyuCQXihVcOTuK/ALYZuzY+zC8gYSpZQI+AAtIFPUq+7pJcYo4SzLUBAGZVJgiByCceTcJaYEjTKO+e7HxX0FzWZFrc5sUxbBnApeck0kPt8kE2nTsJjs57t9Ie9PKjYavIwKeC38mU4DyAZEaCMIg1tqjQsW4WvCSYOB7klcPqYJZHhYHgYYeBa8w==';
const OPENMLS_EXTERNAL_REJOIN =
  'AAEAAQlnLWZpeHR1cmUAAAAAAAAAAQQAAysBAAYgB2IrV49aQM1XL1Bui1dLj8e20xKDgwLWzfpwOHgkamkBAAMAAAABASD40eQfJ550CJm9l1b85zd94W45g10V8UZjLJyHUcrgdyBg2fo/u3+PD7Rvmyzjd581mPDjhDQh29PejY1OmuJXhAABDHVzZXItYjpkZXYtYgIAAQYAAQACAAMAAAIAAQMggMwhkj/1bVP80J6GhKiNeSSjCP284tAOrYSKkmmAg5cAQECKWsDfsMorpGGQC1WqKIx1cNgzTUd/irCsSqEKqUAmm/2S1fRRL2/V1X7erAE0COR743Oav8AjZP9j2CAAS80PQHUgp2Q/PpWvFVIBBMivyymacbt04jBAOLaLJw2gCwQ1IQVAUiDXb+xsBTNcRRo0+lNgAiCdH7lk9Vgk67B+lC6j1ElIVzAbYB38jszO8n4duIM2NK/6Evh9jYOTolsrMTqokjv0puxlBagok5K/uT0gY+T0V0xAQOlTNmhiOGr9XdI3W2irsZsVtAq6z67RoW5izETc2/EvWvtrcNtEb1o74QVNxhh3dpWT71GfhYjggpIYdpB/ZQEg0VN12NRyQXbfmKQqm63wtFRCRcxOweKRzETEwr7N5AQ=';

describe('mlsFrameEpoch', () => {
  it('reads an application frame (PrivateMessage) at its epoch', () => {
    expect(mlsFrameEpoch(frame(2, GROUP, 12n))).toBe(12);
  });

  it('reads a commit (PublicMessage) at its base epoch', () => {
    expect(mlsFrameEpoch(frame(1, GROUP, 11n))).toBe(11);
  });

  it('honours the two- and four-byte length prefixes', () => {
    expect(mlsFrameEpoch(frame(2, GROUP, 7n, 2))).toBe(7);
    expect(mlsFrameEpoch(frame(2, GROUP, 7n, 4))).toBe(7);
  });

  it('answers null for anything that is not a framed MLS 1.0 message', () => {
    // A Welcome is wire_format 3: it carries no clear epoch, and the rule does not speak about it.
    expect(mlsFrameEpoch(frame(3, GROUP, 5n))).toBeNull();
    expect(
      mlsFrameEpoch(Buffer.from([0x00, 0x02, 0x00, 0x02, 0x00]).toString('base64'))
    ).toBeNull();
    expect(mlsFrameEpoch(frame(2, GROUP, 5n).slice(0, 20))).toBeNull();
    expect(mlsFrameEpoch('')).toBeNull();
  });
});

describe('readCommitFrame', () => {
  it('reads a member commit (PrivateMessage) as its group and epoch', () => {
    expect(readCommitFrame(frame(2, GROUP, 9n))).toEqual({
      groupId: GROUP,
      epoch: 9,
      external: false,
    });
  });

  it('reads a well-formed external commit as one, with its leaf, whatever the length prefixes', () => {
    expect(readCommitFrame(externalCommitFrame(GROUP, 9n, 'user-1:device-1'))).toEqual({
      groupId: GROUP,
      epoch: 9,
      external: true,
      leafIdentity: 'user-1:device-1',
    });
    expect(readCommitFrame(externalCommitFrame(GROUP, 9n, 'user-1:device-1', 2))?.external).toBe(
      true
    );
    // A non-empty authenticated_data is skipped by its own length.
    const body = externalCommitBody('user-2:phone');
    expect(readCommitFrame(frame(1, GROUP, 9n, 1, [4, 2, 0xaa, 0xbb, 3, ...body]))).toMatchObject({
      external: true,
      leafIdentity: 'user-2:phone',
    });
  });

  it('reads the leaf of external commits openmls itself produced: a first join and a rejoin', () => {
    // Emitted by mls-core (openmls 0.9.1) on 2026-10-22: `user-c:dev-c` joining `g-fixture` at
    // epoch 1 (ExternalInit only), and `user-b:dev-b` rejoining it (ExternalInit + a Remove of its
    // own old leaf) - the two shapes a Canari external commit takes.
    expect(readCommitFrame(OPENMLS_EXTERNAL_JOIN)).toEqual({
      groupId: 'g-fixture',
      epoch: 1,
      external: true,
      leafIdentity: 'user-c:dev-c',
    });
    expect(readCommitFrame(OPENMLS_EXTERNAL_REJOIN)).toEqual({
      groupId: 'g-fixture',
      epoch: 1,
      external: true,
      leafIdentity: 'user-b:dev-b',
    });
  });

  it('refuses a PublicMessage that is not a well-formed external commit - Canari sends none', () => {
    // A member sender in the clear, an external commit whose content is not a commit, a truncation.
    expect(readCommitFrame(frame(1, GROUP, 9n, 1, [1, 0, 3]))).toBeNull();
    expect(readCommitFrame(frame(1, GROUP, 9n, 1, [4, 0, 1]))).toBeNull();
    expect(readCommitFrame(frame(1, GROUP, 9n, 1, [4]))).toBeNull();
    expect(readCommitFrame(frame(1, GROUP, 9n, 1, [4, 5, 0]))).toBeNull();
    // A commit with no path (RFC 9420 makes it mandatory on an external commit), and one whose
    // credential is not a basic one: no leaf to hold to the caller, so no external commit.
    expect(readCommitFrame(frame(1, GROUP, 9n, 1, [4, 0, 3, 0, 0]))).toBeNull();
    const x509 = externalCommitBody('user-1:device-1');
    // proposals<V> (1 + length), the presence byte, two 33-byte keys, then the u16's low byte.
    x509[1 + x509[0] + 1 + 33 + 33 + 1] = 0x02;
    expect(readCommitFrame(frame(1, GROUP, 9n, 1, [4, 0, 3, ...x509]))).toBeNull();
  });

  it('refuses anything that is not a framed commit', () => {
    expect(readCommitFrame(frame(3, GROUP, 9n))).toBeNull();
    expect(readCommitFrame(externalCommitFrame(GROUP, 9n).slice(0, 20))).toBeNull();
    expect(readCommitFrame('cGF5bG9hZA==')).toBeNull();
  });
});

describe('isBeyondPastEpochWindow', () => {
  // `mls-core` keeps two past epochs (`max_past_epochs(2)`), pinned on the client by
  // `tests/past_epoch_frame.rs`: one commit behind still decrypts, three behind is
  // `PastEpochApplication`. The server's reading must agree with that boundary exactly.
  it('keeps the current epoch and the two before it readable', () => {
    expect(MLS_MAX_PAST_EPOCHS).toBe(2);
    expect(isBeyondPastEpochWindow(141, 141)).toBe(false);
    expect(isBeyondPastEpochWindow(140, 141)).toBe(false);
    expect(isBeyondPastEpochWindow(139, 141)).toBe(false);
  });

  it('reads a frame three or more epochs behind as unreadable to an up-to-date member', () => {
    // The measured shape: requests sealed at 135-138 into a key group at 141.
    expect(isBeyondPastEpochWindow(138, 141)).toBe(true);
    expect(isBeyondPastEpochWindow(135, 141)).toBe(true);
  });

  it('says nothing about a frame AHEAD of the group', () => {
    expect(isBeyondPastEpochWindow(142, 141)).toBe(false);
  });
});
