// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ReelExportError,
  drawDecorations,
  renderEditedReelMedia,
  type ReelEdits,
} from './reelEditor';
import { createStrokeOverlay } from './reelStrokes';
import { createEmojiOverlay, createTextOverlay, type ReelOverlay } from './reelOverlays';

describe('renderEditedReelMedia', () => {
  it('renders a decorated image to WebP with its source dimensions', async () => {
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'width', { value: 120, writable: true });
    Object.defineProperty(canvas, 'height', { value: 80, writable: true });
    vi.spyOn(document, 'createElement').mockImplementation((name) => {
      if (name === 'canvas') return canvas;
      return document.createElementNS('http://www.w3.org/1999/xhtml', name) as never;
    });
    vi.spyOn(canvas, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fillText: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(canvas, 'toDataURL').mockReturnValue(`data:image/webp;base64,${btoa('edited')}`);
    const image = { naturalWidth: 120, naturalHeight: 80 } as HTMLImageElement;
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = image.naturalWidth;
        naturalHeight = image.naturalHeight;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          this.onload?.();
        }
      }
    );
    const edits: ReelEdits = { overlays: [] };
    const result = await renderEditedReelMedia(new Blob(['source'], { type: 'image/jpeg' }), edits);
    expect(result.width).toBe(120);
    expect(result.height).toBe(80);
    expect(result.blob.type).toBe('image/webp');
  });
});

describe('drawDecorations', () => {
  function recorder() {
    const calls: [string, ...unknown[]][] = [];
    const state: Record<string, unknown> = {};
    const context = new Proxy(state, {
      get: (target, key: string) =>
        key in target ? target[key] : (...args: unknown[]) => void calls.push([key, ...args]),
      set: (target, key: string, value) => {
        target[key] = value;
        calls.push([`set ${key}`, value]);
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    return { calls, context };
  }

  it('paints a text overlay at its centre, rotated, at the scaled size of the SHORT side', () => {
    const { calls, context } = recorder();
    const text = createTextOverlay('salut', '#ffffff')!;
    const overlays: ReelOverlay[] = [{ ...text, x: 0.25, y: 0.75, scale: 2, rotation: 0.5 }];
    drawDecorations(context, { overlays }, 200, 400, 'Nunito', new Map());
    const names = calls.map((c) => c[0]);
    expect(names.indexOf('save')).toBeLessThan(names.indexOf('translate'));
    expect(calls.find((c) => c[0] === 'translate')).toEqual(['translate', 50, 300]);
    expect(calls.find((c) => c[0] === 'rotate')).toEqual(['rotate', 0.5]);
    // 0.07 of the short side (200) at scale 2.
    expect(calls.find((c) => c[0] === 'set font')![1]).toMatch(/^700 28(\.0+\d)?px Nunito$/);
    expect(calls.find((c) => c[0] === 'fillText')).toEqual(['fillText', 'salut', 0, 0]);
    expect(names[names.length - 1]).toBe('restore');
  });

  it('paints a stroke overlay in short-side units, moved, turned and scaled like any overlay', () => {
    const { calls, context } = recorder();
    const stroke = createStrokeOverlay(
      [
        { x: 100, y: 100 },
        { x: 300, y: 100 },
      ],
      400,
      800,
      '#f05b5b',
      0.01
    )!;
    drawDecorations(
      context,
      { overlays: [{ ...stroke, scale: 2, rotation: 0.25 }] },
      400,
      800,
      'x',
      new Map()
    );
    // Centre (200, 100) of a 400x800 frame: 0.5, 0.125 -> (200, 100); short side 400, scale 2.
    expect(calls.find((c) => c[0] === 'translate')).toEqual(['translate', 200, 100]);
    expect(calls.find((c) => c[0] === 'rotate')).toEqual(['rotate', 0.25]);
    expect(calls.find((c) => c[0] === 'set lineWidth')).toEqual(['set lineWidth', 8]);
    expect(calls.find((c) => c[0] === 'moveTo')).toEqual(['moveTo', -200, 0]);
    expect(calls.find((c) => c[0] === 'lineTo')).toEqual(['lineTo', 200, 0]);
  });

  it('paints a pill text: the chosen colour fills the pill, the glyphs take the contrasting ink', () => {
    const { calls, context } = recorder();
    (context as unknown as Record<string, unknown>).measureText = () => ({ width: 100 });
    const text = createTextOverlay('pill', '#ffcf33', { font: 'serif', background: 'pill' })!;
    drawDecorations(context, { overlays: [text] }, 1000, 2000, 'Nunito', new Map());
    // 0.07 of the short side (1000) = 70px: padding 0.5em each side, height (1.2 + 0.4)em.
    expect(calls.find((c) => c[0] === 'set font')![1]).toBe(
      '700 70px Georgia, "Times New Roman", serif'
    );
    expect(calls.find((c) => c[0] === 'roundRect')).toEqual([
      'roundRect',
      -85,
      -56,
      170,
      112,
      24.5,
    ]);
    const fills = calls.filter((c) => c[0] === 'set fillStyle').map((c) => c[1]);
    expect(fills).toEqual(['#ffcf33', '#050505']);
    expect(calls.some((c) => c[0] === 'set shadowBlur')).toBe(false);
  });

  it('paints an emoji overlay from its loaded picture, centred on its origin', () => {
    const { calls, context } = recorder();
    const emoji = { ...createEmojiOverlay('\u{1F525}'), scale: 1.5 };
    const picture = {} as CanvasImageSource;
    drawDecorations(
      context,
      { overlays: [emoji] },
      200,
      400,
      'Nunito',
      new Map([[emoji.id, picture]])
    );
    // 0.2 of the short side (200) at scale 1.5 is 60 px, drawn from -30.
    expect(calls.find((c) => c[0] === 'drawImage')).toEqual([
      'drawImage',
      picture,
      -30,
      -30,
      60,
      60,
    ]);
  });

  it('draws the overlays in order, the last one on top', () => {
    const { calls, context } = recorder();
    const first = createTextOverlay('un', '#fff')!;
    const second = createTextOverlay('deux', '#fff')!;
    drawDecorations(context, { overlays: [first, second] }, 100, 100, 'x', new Map());
    const drawn = calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
    expect(drawn).toEqual(['un', 'deux']);
  });
});

// The VIDEO path is WebCodecs through mediabunny, never `captureStream` (WebKit has none).
const mbState = vi.hoisted(() => ({
  valid: true,
  track: true as boolean,
  executeError: null as Error | null,
  process: null as null | ((sample: unknown) => unknown),
  captured: [] as unknown[],
}));

vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  QUALITY_HIGH: 'high',
  BlobSource: class {},
  BufferTarget: class {
    buffer: ArrayBuffer | null = new Uint8Array([1, 2, 3]).buffer;
  },
  Mp4OutputFormat: class {},
  Input: class {
    async getPrimaryVideoTrack() {
      return mbState.track
        ? { getDisplayWidth: async () => 721, getDisplayHeight: async () => 1281 }
        : null;
    }
    dispose() {}
  },
  Output: class {
    target = new (class {
      buffer: ArrayBuffer | null = new Uint8Array([1, 2, 3]).buffer;
    })();
    async getMimeType() {
      return 'video/mp4; codecs="avc1.640028"';
    }
  },
  Conversion: {
    init: async (options: { video: { process: (s: unknown) => unknown } }) => {
      mbState.process = options.video.process;
      return {
        isValid: mbState.valid,
        discardedTracks: [{ track: { type: 'video' }, reason: 'undecodable_source_codec' }],
        execute: async () => {
          if (mbState.executeError) throw mbState.executeError;
        },
      };
    },
  },
}));

describe('renderEditedReelMedia, video', () => {
  const edits: ReelEdits = { overlays: [] };
  const video = () => new Blob(['v'], { type: 'video/mp4' });
  function stubCanvas() {
    const context = {
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue(context);
    const original = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((name: string) =>
      name === 'canvas' ? canvas : original(name)
    );
    return { canvas, context };
  }
  afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(mbState, { valid: true, track: true, executeError: null, process: null });
  });

  it('renders on WebCodecs with no captureStream and no MediaRecorder, to even sides', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    const { canvas } = stubCanvas();
    const result = await renderEditedReelMedia(video(), edits);
    expect(result.width).toBe(720);
    expect(result.height).toBe(1280);
    expect(result.blob.type).toContain('video/mp4');
    expect(canvas.width).toBe(720);
    vi.unstubAllGlobals();
  });

  it('draws each decoded frame, then the overlays, and hands the canvas back', async () => {
    const { canvas, context } = stubCanvas();
    await renderEditedReelMedia(video(), edits);
    const draw = vi.fn();
    const out = mbState.process!({ draw });
    expect(draw).toHaveBeenCalledWith(context, 0, 0, 720, 1280);
    expect(out).toBe(canvas);
  });

  it('refuses a file with no video track as a typed unreadable fault', async () => {
    stubCanvas();
    mbState.track = false;
    await expect(renderEditedReelMedia(video(), edits)).rejects.toMatchObject({
      fault: 'unreadable',
    });
  });

  it('refuses an engine that cannot convert as a typed unsupported fault', async () => {
    stubCanvas();
    mbState.valid = false;
    const failure = renderEditedReelMedia(video(), edits);
    await expect(failure).rejects.toBeInstanceOf(ReelExportError);
    await expect(failure).rejects.toMatchObject({ fault: 'unsupported' });
  });

  it('names an encoder failure as the encode fault', async () => {
    stubCanvas();
    mbState.executeError = new Error('boom');
    await expect(renderEditedReelMedia(video(), edits)).rejects.toMatchObject({ fault: 'encode' });
  });
});
