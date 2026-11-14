/**
 * THE CANVAS THAT COMPOSES A DESKTOP LIVE (owner, 2026-11-14): the camera and the shared screen are
 * drawn, per the current scene (`liveScenes.ts`), onto ONE canvas of a FIXED size, and the recorder
 * records that canvas's track - so what the viewers see, what a replay keeps and what the member's
 * preview shows are the same frames, and a scene switch never touches the recorder.
 *
 * THREE INVARIANTS:
 * - THE CANVAS IS {@link STUDIO_FRAME} FOR ITS WHOLE LIFE. Set once in the constructor, never
 *   written again: a source that changes size (a shared window resized mid-live) is fitted anew
 *   inside its box, and the recorder never sees a resolution change (owner's reading of
 *   `1.6.12-alpha.2`: a resize while sharing broke every frame after it at the viewer).
 * - A FRAME IS DRAWN ON EVERY TICK OF THE CLOCK AND ON NOTHING ELSE. The clock is a worker's
 *   (`liveFrameClock.ts`), so a hidden tab keeps its rate; each draw pushes exactly one frame
 *   (`requestFrame` on a `captureStream(0)` track), so the frame rate IS the clock's.
 * - THE SOURCES ARE READ, NOT HELD. The compositor asks for the current camera and screen streams on
 *   each tick and follows a change by itself (a camera re-opened, a screen granted); the streams
 *   belong to whoever opened them, and stopping the compositor stops only its own track.
 *
 * The source `<video>` elements are DETACHED (never in the document): measured on Chrome, a detached
 * element playing a `MediaStream` keeps delivering fresh frames while the tab is hidden.
 */

import {
  STUDIO_FRAME,
  containRect,
  coverCrop,
  sceneLayout,
  type LiveScene,
  type LiveSceneSource,
  type OverlaySettings,
  type Rect,
  type SceneDraw,
} from './liveScenes';
import type { FrameClock } from './liveFrameClock';

/** The frames between two `[LIVE-STUDIO] drew` summary lines (30 s at 30 fps). */
export const COMPOSITOR_SUMMARY_FRAMES = 900;

/** The panel colour of a card (the pause screen, a camera switched off). */
const CARD_FILL = 'rgb(28 28 30)';
const CARD_TEXT = 'rgb(235 235 240)';

/** The words drawn INTO the picture - localized by the caller (Paraglide), never here. */
export interface CompositorLabels {
  pause: string;
  cameraOff: string;
}

/** The part of a 2D context the compositor uses (a fake in tests). */
export type CompositorContext = Pick<
  CanvasRenderingContext2D,
  'fillRect' | 'drawImage' | 'save' | 'restore' | 'beginPath' | 'arc' | 'clip' | 'fill' | 'fillText'
> & {
  fillStyle: CanvasRenderingContext2D['fillStyle'];
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
};

/** What the compositor needs from its surroundings - every one injectable. */
export interface CompositorDeps {
  /** A fresh canvas: the compositor sizes it once and never again. */
  createCanvas: () => HTMLCanvasElement;
  /** A fresh, detached video element per source. */
  createVideo: () => HTMLVideoElement;
  clock: FrameClock;
  /** The camera stream now, or null (none open, or the camera switched off). */
  camera: () => MediaStream | null;
  /** The shared screen now, or null. */
  screen: () => MediaStream | null;
  /** A monotonic clock in ms, for the draw-cost summary. */
  now: () => number;
}

/** The track a `captureStream(0)` canvas gives: a frame is pushed only by `requestFrame`. */
type CanvasTrack = MediaStreamTrack & { requestFrame?: () => void };

interface SourceElement {
  el: HTMLVideoElement;
  stream: MediaStream | null;
}

export class LiveCompositor {
  /** The composed picture: the ONE video track a desktop live records. */
  readonly track: MediaStreamTrack;
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CompositorContext;
  readonly #deps: CompositorDeps;
  readonly #sources: Record<LiveSceneSource, SourceElement>;
  #scene: LiveScene = 'camera';
  #overlay: OverlaySettings;
  #cameraOn = true;
  #labels: CompositorLabels = { pause: '', cameraOff: '' };
  #running = false;
  #frames = 0;
  #drawMs = 0;

  constructor(overlay: OverlaySettings, deps: CompositorDeps) {
    this.#deps = deps;
    this.#overlay = overlay;
    const canvas = deps.createCanvas();
    canvas.width = STUDIO_FRAME.width;
    canvas.height = STUDIO_FRAME.height;
    this.#canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false }) as CompositorContext | null;
    if (!ctx) throw new Error('live compositor: the canvas gave no 2d context');
    this.#ctx = ctx;
    const track = canvas.captureStream(0).getVideoTracks()[0];
    if (!track) throw new Error('live compositor: the canvas gave no video track');
    this.track = track;
    this.#sources = {
      camera: { el: this.#detachedVideo(deps.createVideo()), stream: null },
      screen: { el: this.#detachedVideo(deps.createVideo()), stream: null },
    };
    console.debug(
      `[LIVE-STUDIO] compositor made at ${STUDIO_FRAME.width}x${STUDIO_FRAME.height}, captureStream(0)`
    );
  }

  /** The size the picture is encoded at - {@link STUDIO_FRAME}, read from the canvas itself. */
  get size(): { width: number; height: number } {
    return { width: this.#canvas.width, height: this.#canvas.height };
  }

  /** Starts drawing on the clock (idempotent). */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#deps.clock.start(() => this.drawFrame());
  }

  /** Stops the clock, its own track and the source elements; the sources' streams are their owners'. */
  stop(): void {
    if (!this.#running && this.track.readyState === 'ended') return;
    this.#running = false;
    this.#deps.clock.stop();
    this.track.stop();
    for (const source of Object.values(this.#sources)) {
      source.el.srcObject = null;
      source.stream = null;
    }
    console.debug(`[LIVE-STUDIO] compositor stopped after ${this.#frames} frames`);
  }

  setScene(scene: LiveScene): void {
    this.#scene = scene;
  }

  setOverlay(overlay: OverlaySettings): void {
    this.#overlay = overlay;
  }

  /** False while the member switched the camera off: its box draws the `camera-off` card. */
  setCameraOn(on: boolean): void {
    this.#cameraOn = on;
  }

  setLabels(labels: CompositorLabels): void {
    this.#labels = labels;
  }

  /** Draws one frame of the current scene and pushes it to the track. Called by the clock. */
  drawFrame(): void {
    const started = this.#deps.now();
    this.#follow('camera', this.#cameraOn ? this.#deps.camera() : null);
    this.#follow('screen', this.#deps.screen());
    const ctx = this.#ctx;
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, STUDIO_FRAME.width, STUDIO_FRAME.height);
    const cameraShown = this.#sources.camera.stream !== null;
    for (const op of sceneLayout(this.#scene, this.#overlay, cameraShown)) this.#draw(op);
    (this.track as CanvasTrack).requestFrame?.();
    this.#drawMs += this.#deps.now() - started;
    if (++this.#frames % COMPOSITOR_SUMMARY_FRAMES === 0) {
      console.info(
        `[LIVE-STUDIO] drew ${this.#frames} frames, ${(this.#drawMs / COMPOSITOR_SUMMARY_FRAMES).toFixed(2)} ms each on average (scene ${this.#scene})`
      );
      this.#drawMs = 0;
    }
  }

  /** Points `source`'s element at `stream` when it changed (a camera re-opened, a screen granted). */
  #follow(source: LiveSceneSource, stream: MediaStream | null): void {
    const slot = this.#sources[source];
    if (slot.stream === stream) return;
    console.debug(`[LIVE-STUDIO] ${source} ${stream ? 'follows a new stream' : 'has no stream'}`);
    slot.stream = stream;
    slot.el.srcObject = stream;
    if (stream) {
      slot.el.play().catch((err: unknown) => {
        console.warn(`[LIVE-STUDIO] the ${source} element did not play - its box stays black`, err);
      });
    }
  }

  #draw(op: SceneDraw): void {
    const ctx = this.#ctx;
    ctx.save();
    if (op.round) {
      const { x, y, width, height } = op.box;
      ctx.beginPath();
      ctx.arc(x + width / 2, y + height / 2, Math.min(width, height) / 2, 0, Math.PI * 2);
      ctx.clip();
    }
    if (op.kind === 'card') this.#drawCard(op.card, op.box);
    else this.#drawSource(op.source, op.box, op.fit);
    ctx.restore();
  }

  #drawSource(source: LiveSceneSource, box: Rect, fit: 'contain' | 'cover'): void {
    const { el, stream } = this.#sources[source];
    if (!stream) return;
    const size = { width: el.videoWidth, height: el.videoHeight };
    if (fit === 'contain') {
      const at = containRect(size, box);
      if (at) this.#ctx.drawImage(el, at.x, at.y, at.width, at.height);
      return;
    }
    const crop = coverCrop(size, box);
    if (crop) {
      this.#ctx.drawImage(
        el,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        box.x,
        box.y,
        box.width,
        box.height
      );
    }
  }

  #drawCard(card: 'pause' | 'camera-off', box: Rect): void {
    const ctx = this.#ctx;
    ctx.fillStyle = CARD_FILL;
    ctx.fillRect(box.x, box.y, box.width, box.height);
    const text = card === 'pause' ? this.#labels.pause : this.#labels.cameraOff;
    if (!text) return;
    // The line scales with its box: large on the pause screen, small in a corner overlay.
    const px = Math.max(
      14,
      Math.round(Math.min(box.height, box.width) * (card === 'pause' ? 0.08 : 0.1))
    );
    ctx.fillStyle = CARD_TEXT;
    ctx.font = `600 ${px}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, box.x + box.width / 2, box.y + box.height / 2, box.width * 0.9);
  }

  #detachedVideo(el: HTMLVideoElement): HTMLVideoElement {
    el.muted = true;
    el.playsInline = true;
    el.autoplay = true;
    return el;
  }
}
