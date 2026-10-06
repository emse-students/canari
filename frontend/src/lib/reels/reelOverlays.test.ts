import { describe, expect, it } from 'vitest';
import {
  MAX_OVERLAY_TEXT_LENGTH,
  broughtToFront,
  createEmojiOverlay,
  createTextOverlay,
  emojiSize,
  overlayFontSize,
  withTextEdit,
  withTransform,
  withoutOverlay,
} from './reelOverlays';

describe('reel overlays', () => {
  it('creates centred, upright overlays with distinct ids, and refuses empty text', () => {
    const a = createTextOverlay('  hi  ', '#fff')!;
    const b = createEmojiOverlay('\u{1F525}');
    expect(a).toMatchObject({ kind: 'text', text: 'hi', x: 0.5, y: 0.5, scale: 1, rotation: 0 });
    expect(b).toMatchObject({ kind: 'emoji', x: 0.5, y: 0.5, scale: 1, rotation: 0 });
    expect(a.id).not.toBe(b.id);
    expect(createTextOverlay('   ', '#fff')).toBeNull();
    expect(createTextOverlay('x'.repeat(500), '#fff')!.text).toHaveLength(MAX_OVERLAY_TEXT_LENGTH);
  });

  it('changes one overlay and leaves the others the same objects', () => {
    const a = createTextOverlay('a', '#fff')!;
    const b = createEmojiOverlay('\u{1F525}');
    const moved = withTransform([a, b], a.id, { x: 0.1, y: 0.2, scale: 2, rotation: 1 });
    expect(moved[0]).toMatchObject({ x: 0.1, y: 0.2, scale: 2, rotation: 1, text: 'a' });
    expect(moved[1]).toBe(b);
    expect(withoutOverlay(moved, a.id)).toEqual([b]);
  });

  it('brings the handled overlay to the top, once', () => {
    const a = createTextOverlay('a', '#fff')!;
    const b = createTextOverlay('b', '#fff')!;
    expect(broughtToFront([a, b], a.id).map((o) => o.id)).toEqual([b.id, a.id]);
    const already = [a, b];
    expect(broughtToFront(already, b.id)).toBe(already);
  });

  it('rewords and recolours text only, never to an empty string', () => {
    const a = createTextOverlay('a', '#fff')!;
    const e = createEmojiOverlay('\u{1F525}');
    const edited = withTextEdit([a, e], a.id, { text: ' new ', color: '#000' });
    expect(edited[0]).toMatchObject({ text: 'new', color: '#000' });
    expect(withTextEdit([a], a.id, { text: '   ' })[0]).toMatchObject({ text: 'a' });
    expect(withTextEdit([e], e.id, { color: '#000' })[0]).toBe(e);
  });

  it('sizes both kinds from the SHORT side of the frame', () => {
    expect(overlayFontSize(1080, 1920)).toBeCloseTo(0.07 * 1080);
    expect(overlayFontSize(1920, 1080, 2)).toBeCloseTo(0.07 * 1080 * 2);
    expect(emojiSize(720, 1280)).toBeCloseTo(0.2 * 720);
  });
});
