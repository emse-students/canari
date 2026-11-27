import { describe, expect, it } from 'vitest';
import {
  cappedFrameHeight,
  MAIL_FRAME_MAX_HEIGHT_PX,
  readMailFrameMessage,
} from './mailFrameMessages';

/** What the mail frame may tell its parent: two shapes, read and never trusted. */

describe('readMailFrameMessage', () => {
  it('reads the two shapes our script sends', () => {
    expect(readMailFrameMessage({ type: 'mail-frame-height', h: 412.4 })).toEqual({
      kind: 'height',
      height: 413,
    });
    expect(readMailFrameMessage({ type: 'mail-frame-link', href: ' https://a.test ' })).toEqual({
      kind: 'link',
      href: 'https://a.test',
    });
  });

  it('drops anything else: a bad height, an unsafe address, another shape', () => {
    for (const data of [
      null,
      'mail-frame-height',
      { type: 'mail-frame-height', h: '400' },
      { type: 'mail-frame-height', h: Number.NaN },
      { type: 'mail-frame-height', h: Number.POSITIVE_INFINITY },
      { type: 'mail-frame-height', h: -1 },
      { type: 'mail-frame-link', href: 'javascript:alert(1)' },
      { type: 'mail-frame-link', href: 'fr.emse.canari://chat/1' },
      { type: 'mail-frame-link', href: 42 },
      { type: 'navigate', href: 'https://a.test' },
    ]) {
      expect(readMailFrameMessage(data)).toBeNull();
    }
  });
});

describe('cappedFrameHeight', () => {
  it('keeps a height up to the cap, and cuts one beyond it', () => {
    expect(cappedFrameHeight(900)).toEqual({ height: 900, capped: false });
    expect(cappedFrameHeight(MAIL_FRAME_MAX_HEIGHT_PX)).toEqual({
      height: MAIL_FRAME_MAX_HEIGHT_PX,
      capped: false,
    });
    expect(cappedFrameHeight(MAIL_FRAME_MAX_HEIGHT_PX * 3)).toEqual({
      height: MAIL_FRAME_MAX_HEIGHT_PX,
      capped: true,
    });
  });
});
