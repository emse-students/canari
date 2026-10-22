import {
  MLS_MAX_PAST_EPOCHS,
  isBeyondPastEpochWindow,
  mlsFrameEpoch,
  readCommitFrame,
} from './mls-frame-epoch';
import { externalCommitFrame, mlsFrame as frame } from '../testing/mlsFrameFixture';

const GROUP = '68227a77-0515-43d7-b7ee-2943bfa78f1f';

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

  it('reads a well-formed external commit as one, whatever the length prefixes', () => {
    expect(readCommitFrame(externalCommitFrame(GROUP, 9n))).toEqual({
      groupId: GROUP,
      epoch: 9,
      external: true,
    });
    expect(readCommitFrame(externalCommitFrame(GROUP, 9n, 2))?.external).toBe(true);
    // A non-empty authenticated_data is skipped by its own length.
    expect(readCommitFrame(frame(1, GROUP, 9n, 1, [4, 2, 0xaa, 0xbb, 3]))?.external).toBe(true);
  });

  it('refuses a PublicMessage that is not a well-formed external commit - Canari sends none', () => {
    // A member sender in the clear, an external commit whose content is not a commit, a truncation.
    expect(readCommitFrame(frame(1, GROUP, 9n, 1, [1, 0, 3]))).toBeNull();
    expect(readCommitFrame(frame(1, GROUP, 9n, 1, [4, 0, 1]))).toBeNull();
    expect(readCommitFrame(frame(1, GROUP, 9n, 1, [4]))).toBeNull();
    expect(readCommitFrame(frame(1, GROUP, 9n, 1, [4, 5, 0]))).toBeNull();
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
