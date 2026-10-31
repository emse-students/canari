/**
 * THE BROADCASTER'S STATE MACHINE (WP-L5): the pre-live preview, the live on air, a camera away
 * (the app in the background, or the lens taken), and the end - with every dependency injected, so
 * each transition is tested with a fake recorder, camera and server.
 *
 * ```
 * preview --start--> starting --201--> live <--re-acquired-- away
 *    ^                  |                |  \--hidden / lens lost--^
 *    +---- refused -----+                |
 *                                  End / 410 / refusal --> ending? --> ended
 * ```
 *
 * THE CAMERA IS GIVEN BACK WHEN THE APP IS HIDDEN, ON BOTH PLATFORMS - the reel camera's rule. WP-L1
 * measured two different behaviours if it is kept: the Android WebView ENDS the track ~6 s after
 * `hidden` and never brings it back, iOS Safari MUTES it and unmutes on return. Releasing on `hidden`
 * makes both one path - the recorder is stopped (its last chunk still sent), and the return opens the
 * camera again and starts a NEW recorder on the SAME live: the segment index continues, the media time
 * is shifted past the gap (`fmp4Segments.ts`), and viewers see the pause. Nothing records twice: a
 * recorder exists only between an acquisition and its release.
 *
 * WHETHER THE LIVE STILL EXISTS IS THE SERVER'S ANSWER, never a client timer. On return the live is
 * read (`GET /api/lives/:id`): ended (the 60 s window passed, the hour, a moderation cut) is the end
 * screen; anything else re-acquires, and the uploader's next verdict stays the authority. While on
 * air, a `410` from the uploader ends the screen the same way.
 *
 * A REUSED `LIVE_ALREADY_OPEN` is not resumed: a live started by a previous screen (a crash, a kill)
 * is ended by the server's absence rule within its window, and the member is told to wait for it.
 */

import { generateMediaCek } from '$lib/mediaCrypto';
import type { CameraOpener, CameraSession } from '$lib/reels/cameraSession.svelte';
import { isTransportFailure } from '$lib/utils/transportFailure';
import {
  endLive,
  fetchLive,
  fetchLiveLimits,
  fetchLiveRules,
  isLiveCut,
  isLiveRefusal,
  LiveRefusalError,
  LiveSegmentUploader,
  startLive,
  type LiveSegmentUploaderOptions,
} from './api';
import { sealLiveSegment } from './liveCrypto';
import {
  ScreenWakeLock,
  createMixContext,
  openLiveScreen,
  screenShareAvailable,
} from './liveDevice';
import {
  liveRecordingSupported,
  startLiveRecorder,
  type LiveRecorderHandle,
  type LiveRecorderStarter,
} from './liveRecorder';
import { LiveSegmentPipeline } from './liveSegmentPipeline';
import {
  LIVE_BACKLOG_MARGIN_SEGMENTS,
  LIVE_RECORDER_STOP_BOUND_MS,
  LIVE_SEGMENT_MS,
} from './constants';
import type { LiveEndResult, LiveLimits, LiveRulesStatus, LiveView } from './types';

/** What a live broadcasts: the camera, or - on a desktop browser - the screen. */
export type LiveSource = 'camera' | 'screen';

/** Where the broadcast stands; see the diagram in the module comment. */
export type LiveBroadcastPhase = 'preview' | 'starting' | 'live' | 'away' | 'ending' | 'ended';

/** Why a start was refused - one sentence each on the pre-live screen. */
export type LiveStartProblem =
  | 'muted'
  | 'rules-not-accepted'
  | 'suspended'
  | 'withdrawn'
  | 'already-open'
  | 'association-forbidden'
  | 'rate-limited'
  | 'disabled'
  | 'offline'
  | 'unsupported'
  | 'failed';

/** Why the limits could not be read (the Start button waits for them). */
export type LiveLimitsProblem = 'disabled' | 'offline' | 'failed';

/** Why the broadcast ended - one sentence each on the end screen. */
export type LiveEndCause =
  /** The member pressed End. */
  | 'broadcaster'
  /** The server ended it while on air: the hour, or a moderation cut (a `410`). */
  | 'server'
  /** A moderator cut it (a `410` whose `endReason` is `cut`): its own sentence, never "the hour". */
  | 'cut'
  /** The server ended it while the camera was away: past the reconnect window, most often. */
  | 'server-while-away'
  /** A refusal the uploader cannot get past, or a recorder that would not start. */
  | 'failed'
  /**
   * The server stored nothing for longer than it keeps a silent live: the connection was lost, and
   * nothing still queued could be watched.
   */
  | 'connection-lost'
  /**
   * The server still stores segments, but slower than they are recorded: the backlog outgrew the
   * reconnect window's worth, so viewers fall further behind every minute.
   */
  | 'upload-too-slow';

/** Whether the segments are getting through: `retrying` is the quiet "reconnecting" badge. */
export type LiveUploadHealth = 'ok' | 'retrying';

/** The uploader as the broadcast uses it. */
export type LiveUploaderLike = Pick<
  LiveSegmentUploader,
  'enqueue' | 'nextIndex' | 'backlog' | 'idle' | 'stop'
>;

/** Everything the broadcast reaches outside itself. */
export interface LiveBroadcastDeps {
  fetchLiveLimits: () => Promise<LiveLimits>;
  fetchLiveRules: () => Promise<LiveRulesStatus>;
  startLive: (
    keyHex: string,
    associationId?: string,
    acceptedRulesVersion?: number
  ) => Promise<LiveView>;
  fetchLive: (liveId: string) => Promise<LiveView>;
  endLive: (liveId: string) => Promise<LiveEndResult>;
  createUploader: (liveId: string, options: LiveSegmentUploaderOptions) => LiveUploaderLike;
  seal: (
    keyHex: string,
    liveId: string,
    index: number,
    plain: Uint8Array
  ) => Promise<Uint8Array<ArrayBuffer>>;
  generateKeyHex: () => Promise<string>;
  recordingSupported: () => boolean;
  startRecorder: LiveRecorderStarter;
  wakeLock: { hold(): Promise<void>; release(): void };
  /** A monotonic clock, in ms. */
  now: () => number;
  /** Resolves after `ms`: the BOUND on a wait that has no verdict of its own, never a decision. */
  sleep: (ms: number) => Promise<void>;
  isHidden: () => boolean;
  /** Whether this browser may broadcast its screen (desktop only). */
  screenShareAvailable: () => boolean;
  /** Opens the screen (and the microphone) as a live's source. */
  /** Opens the screen with the mixing context made inside the click ({@link createAudioContext}). */
  openScreen: (context: AudioContext | null) => Promise<MediaStream>;
  /** Makes and resumes the mixing context; called synchronously in the click that picks the screen. */
  createAudioContext: () => AudioContext | null;
}

/** The real dependencies. */
export function defaultLiveBroadcastDeps(): LiveBroadcastDeps {
  return {
    fetchLiveLimits,
    fetchLiveRules,
    startLive,
    fetchLive,
    endLive,
    createUploader: (liveId, options) => new LiveSegmentUploader(liveId, options),
    seal: sealLiveSegment,
    generateKeyHex: async () => (await generateMediaCek()).keyHex,
    recordingSupported: liveRecordingSupported,
    startRecorder: startLiveRecorder,
    wakeLock: new ScreenWakeLock(),
    now: () => performance.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    screenShareAvailable,
    openScreen: (context) => openLiveScreen(context),
    createAudioContext: () => createMixContext(),
  };
}

/** A start refusal, read from its type and code - never its message. */
export function startProblemOf(error: unknown): LiveStartProblem {
  if (error instanceof LiveRefusalError) {
    if (error.code === 'LIVE_MUTED') return 'muted';
    if (error.code === 'LIVE_RULES_NOT_ACCEPTED') return 'rules-not-accepted';
    if (error.kind === 'suspended') return 'suspended';
    if (error.kind === 'withdrawn') return 'withdrawn';
    if (error.code === 'LIVE_ALREADY_OPEN') return 'already-open';
    if (error.code === 'LIVE_ASSOCIATION_FORBIDDEN') return 'association-forbidden';
    if (error.kind === 'rate-limited') return 'rate-limited';
    if (error.kind === 'disabled') return 'disabled';
    return 'failed';
  }
  if (isTransportFailure(error)) return 'offline';
  console.error('[LIVE-BROADCAST] the start threw something untyped', error);
  return 'failed';
}

/** A limits failure, read the same way. */
function limitsProblemOf(error: unknown): LiveLimitsProblem {
  if (isLiveRefusal(error, 'disabled')) return 'disabled';
  if (isTransportFailure(error)) return 'offline';
  return 'failed';
}

export class LiveBroadcast {
  phase = $state<LiveBroadcastPhase>('preview');
  limits = $state.raw<LiveLimits | null>(null);
  /** The member's standing with the first-live rules (L11), read with the limits. */
  rules = $state.raw<LiveRulesStatus | null>(null);
  /** The member tapped "I accept" on THIS screen: the start then sends the version. */
  rulesAcceptedHere = $state(false);
  limitsProblem = $state<LiveLimitsProblem | null>(null);
  startProblem = $state<LiveStartProblem | null>(null);
  /** `suspended`: when the suspension ends (ISO string, as the server sent it), else null. */
  startSuspendedUntil = $state<string | null>(null);
  endCause = $state<LiveEndCause | null>(null);
  health = $state<LiveUploadHealth>('ok');
  /** Segments sealed and waiting for the server. */
  backlog = $state(0);
  liveId = $state<string | null>(null);
  /**
   * Why the screen is `away` when it is not the camera's doing: the recorder's output could not be
   * read or sent, so Retry starts a fresh recorder. Null for a background or a lens taken.
   */
  awayProblem = $state<'unsendable' | null>(null);
  /** Whether this engine records the live's container at all (read once). */
  readonly supported: boolean;
  /** A desktop browser that can broadcast its screen: the sheet then offers the choice. */
  readonly canShareScreen: boolean;
  /** What the live broadcasts; chosen in the preview ({@link chooseSource}), fixed once on air. */
  source = $state<LiveSource>('camera');
  /** True while the screen picker (or the camera it falls back to) is opening: the choice is locked. */
  choosingSource = $state(false);
  /** The share was stopped from the browser's bar while the live was still starting: end on landing. */
  #screenGoneWhileStarting = false;
  /** The camera's opener, kept while the screen's stands in for it. */
  #cameraOpener: CameraOpener | null = null;

  readonly #deps: LiveBroadcastDeps;
  #keyHex: string | null = null;
  #uploader: LiveUploaderLike | null = null;
  #pipeline: LiveSegmentPipeline | null = null;
  #recorder: LiveRecorderHandle | null = null;
  /** The pipeline generation the current recorder's chunks are pushed to, fixed at its creation. */
  #pipelineGeneration: number | null = null;
  /**
   * The last paused recorder handing over its final chunk (bounded), then its generation closed:
   * a new recorder and the end both wait for it, so nothing of the old one lands after.
   */
  #stopping: Promise<void> = Promise.resolve();
  /** Removes the listeners on the recorded track; replaced per recorder. */
  #trackWatch: AbortController | null = null;
  /** Bumped by every recorder started and every pause: a stale recorder's event is ignored. */
  #recorderGeneration = 0;
  /** Bumped by every re-acquisition and every hide: a stale one stops at its next await. */
  #reacquireGeneration = 0;
  #startedAt: number | null = null;
  /** When the server last STORED a segment (the live's start before the first): what it has heard. */
  #lastStoredAt: number | null = null;
  /** The uploader heard the server's end (`410`) while the End was draining: the server ended it first. */
  /** The cause the server's own `410` gave while the End was draining, or null (the member's end). */
  #serverEndedWhileEnding: 'server' | 'cut' | null = null;
  #firstRecordAt: number | null = null;
  #disposed = false;

  constructor(
    readonly camera: CameraSession,
    readonly associationId: string | null,
    deps: LiveBroadcastDeps = defaultLiveBroadcastDeps()
  ) {
    this.#deps = deps;
    this.supported = deps.recordingSupported();
    this.canShareScreen = deps.screenShareAvailable();
    console.debug(
      `[LIVE-BROADCAST] screen for ${associationId ? `association ${associationId}` : 'the member'}, recordable ${this.supported}`
    );
  }

  /** Milliseconds on air, from a monotonic clock; 0 before the live started. */
  elapsedMs(): number {
    return this.#startedAt === null ? 0 : this.#deps.now() - this.#startedAt;
  }

  /**
   * Reads the server's numbers and the member's standing with the rules, together: the Start
   * button waits for both, and either failing is the same "could not read" with its Retry.
   */
  async loadLimits(): Promise<void> {
    this.limitsProblem = null;
    try {
      const [limits, rules] = await Promise.all([
        this.#deps.fetchLiveLimits(),
        this.#deps.fetchLiveRules(),
      ]);
      this.limits = limits;
      this.rules = rules;
      console.debug(
        `[LIVE-BROADCAST] rules v${rules.version}, accepted v${rules.acceptedVersion ?? '-'}`
      );
    } catch (e) {
      this.limitsProblem = limitsProblemOf(e);
      console.warn(`[LIVE-BROADCAST] limits not read (${this.limitsProblem})`);
    }
  }

  /**
   * Whether the rules must be accepted on this screen before Start: the account's accepted version
   * is below the current one (never accepted, or the rules changed), and it was not accepted here.
   */
  get rulesPending(): boolean {
    if (this.rules === null || this.rulesAcceptedHere) return false;
    return (this.rules.acceptedVersion ?? 0) < this.rules.version;
  }

  /** The member tapped "I accept the rules": the next start records it with the server. */
  acceptRules(): void {
    if (this.rules === null) return;
    console.log(`[LIVE-BROADCAST] rules v${this.rules.version} accepted on screen`);
    this.rulesAcceptedHere = true;
    if (this.startProblem === 'rules-not-accepted') this.startProblem = null;
  }

  /** Whether Start may be pressed now. */
  get canStart(): boolean {
    return (
      this.phase === 'preview' &&
      this.supported &&
      this.limits !== null &&
      this.rules !== null &&
      !this.rulesPending &&
      this.camera.phase === 'live' &&
      this.camera.stream !== null
    );
  }

  /**
   * The server refused the start for the rules (a version raised since they were read): read them
   * again, which shows them. A failed read is the limits' own "could not read" with its Retry
   * (Start waits for the rules again), never a guess at the standing.
   */
  async #rulesRefused(): Promise<void> {
    this.rulesAcceptedHere = false;
    try {
      this.rules = await this.#deps.fetchLiveRules();
    } catch (e) {
      this.rules = null;
      this.limitsProblem = limitsProblemOf(e);
      console.warn(`[LIVE-BROADCAST] rules not re-read after the refusal (${this.limitsProblem})`);
    }
  }

  /** Starts the live on the camera already open. */
  async start(): Promise<void> {
    if (!this.canStart) {
      console.warn(`[LIVE-BROADCAST] start refused locally in ${this.phase}`);
      if (!this.supported) this.startProblem = 'unsupported';
      return;
    }
    console.log(`[LIVE-BROADCAST] starting`);
    this.phase = 'starting';
    // A stop remembered from an EARLIER start must not end this one.
    this.#screenGoneWhileStarting = false;
    this.startProblem = null;
    this.startSuspendedUntil = null;
    let live: LiveView;
    let keyHex: string;
    try {
      keyHex = await this.#deps.generateKeyHex();
      live = await this.#deps.startLive(
        keyHex,
        this.associationId ?? undefined,
        this.rulesAcceptedHere ? this.rules?.version : undefined
      );
    } catch (e) {
      this.#screenGoneWhileStarting = false;
      if (this.#disposed) return;
      this.startProblem = startProblemOf(e);
      if (this.startProblem === 'suspended' && e instanceof LiveRefusalError) {
        this.startSuspendedUntil = e.suspendedUntil;
      }
      if (this.startProblem === 'rules-not-accepted') await this.#rulesRefused();
      if (this.#disposed) return;
      this.phase = 'preview';
      console.warn(`[LIVE-BROADCAST] start refused (${this.startProblem})`);
      return;
    }
    if (this.#disposed) {
      console.warn(`[LIVE-BROADCAST] ${live.id} started after the screen closed - ending it`);
      this.#endBestEffort(live.id);
      return;
    }
    this.#keyHex = keyHex;
    this.liveId = live.id;
    this.#startedAt = this.#deps.now();
    this.#lastStoredAt = this.#startedAt;
    this.#uploader = this.#deps.createUploader(live.id, {
      startIndex: live.nextIndex,
      onStored: () => {
        this.#lastStoredAt = this.#deps.now();
        this.health = 'ok';
        this.#noteBacklog();
      },
      onRetry: () => {
        if (this.health !== 'retrying') console.warn('[LIVE-BROADCAST] reconnecting');
        this.health = 'retrying';
        this.#noteBacklog();
      },
      onStopped: (error) => this.#uploaderStopped(error),
    });
    const limits = this.limits!;
    this.#pipeline = new LiveSegmentPipeline({
      seal: (index, plain) => this.#deps.seal(this.#keyHex!, live.id, index, plain),
      nextIndex: () => this.#uploader!.nextIndex,
      enqueue: (index, sealed) => {
        this.#uploader!.enqueue(index, sealed);
        this.#noteBacklog();
      },
      maxSegmentBytes: limits.segmentMaxBytes,
      now: this.#deps.now,
      onBroken: (generation) => this.#pipelineBroken(generation),
    });
    this.#goOnAir();
  }

  /**
   * Chooses what the live broadcasts, in the preview only. The screen's picker is the member's click
   * (a browser lets `getDisplayMedia` run only on one), so this is called FROM the choice's handler.
   * A picker that is dismissed - or a microphone that is refused - returns to the CAMERA at once: the
   * member asked for nothing the camera does not already answer, and the camera's own fault, if any,
   * is then the one shown.
   */
  async chooseSource(next: LiveSource): Promise<void> {
    if (this.phase !== 'preview' || next === this.source || this.choosingSource) return;
    if (next === 'screen' && !this.canShareScreen) {
      console.warn('[LIVE-BROADCAST] the screen was chosen where it cannot be shared - ignored');
      return;
    }
    console.log(`[LIVE-BROADCAST] source ${this.source} -> ${next}`);
    this.choosingSource = true;
    // SYNCHRONOUSLY, before any await: the context needs the click's user activation to run.
    const context = next === 'screen' ? this.#deps.createAudioContext() : null;
    try {
      await this.#switchSource(next, context);
    } finally {
      this.choosingSource = false;
    }
  }

  /** The body of {@link chooseSource}, run with the choice locked. */
  async #switchSource(next: LiveSource, context: AudioContext | null): Promise<void> {
    this.source = next;
    if (next === 'screen') {
      const previous = this.camera.swapOpener(() => this.#deps.openScreen(context));
      this.#cameraOpener ??= previous;
    } else if (this.#cameraOpener) {
      this.camera.swapOpener(this.#cameraOpener);
    }
    await this.camera.start();
    if (next === 'screen' && this.camera.phase === 'error') {
      console.warn(
        `[LIVE-BROADCAST] the screen was not shared (${this.camera.fault}) - back to the camera`
      );
      this.source = 'camera';
      this.camera.swapOpener(this.#cameraOpener!);
      await this.camera.start();
    }
  }

  /**
   * The member stopped the share from the browser's own bar while on air: THE LIVE ENDS, cleanly,
   * through the ordinary End. It does not fall back to the camera - a live that silently switched
   * from what the member chose to show to their face is a surprise nobody agreed to - and it does
   * not re-ask for a screen, which needs a click this code does not have.
   */
  async screenShareStopped(): Promise<void> {
    if (this.source !== 'screen') return;
    if (this.phase === 'starting') {
      // The live row is being created: it cannot be ended yet, and going on air on a dead share would
      // re-open the screen without a click. It ends the moment the start lands ({@link goOnAir}).
      console.log(
        '[LIVE-BROADCAST] the screen share stopped while starting - ending once it lands'
      );
      this.#screenGoneWhileStarting = true;
      return;
    }
    if (this.phase !== 'live' && this.phase !== 'away') return;
    console.log('[LIVE-BROADCAST] the screen share was stopped from the browser - ending the live');
    await this.end();
  }

  /** The app left the screen. */
  appHidden(): void {
    if (this.source === 'screen') {
      // A hidden tab is the normal state of a screen share (the member is looking at what they
      // share), and the share cannot be re-opened without a click: nothing is paused.
      console.debug('[LIVE-BROADCAST] the page is hidden, the screen share goes on');
      return;
    }
    console.debug(`[LIVE-BROADCAST] app hidden in ${this.phase}`);
    ++this.#reacquireGeneration;
    if (this.phase === 'live') {
      this.#pauseRecording('the app is in the background');
      this.phase = 'away';
    }
    // 'ending' included: the camera is held there only until the last chunk is out, never past a hide.
    if (this.phase !== 'ended') this.camera.suspend();
  }

  /** The app is back on screen. */
  appVisible(): void {
    if (this.source === 'screen') return;
    console.debug(`[LIVE-BROADCAST] app visible in ${this.phase}`);
    if (this.phase === 'preview' || this.phase === 'starting') {
      this.camera.resume();
    } else if (this.phase === 'away') {
      void this.reacquire();
    }
  }

  /**
   * Opens the camera again on the SAME live (the return from the background, or the Retry of a lens
   * that was taken): the server first, then the camera, then a new recorder.
   */
  async reacquire(): Promise<void> {
    if (this.phase !== 'away' || !this.liveId) return;
    const attempt = ++this.#reacquireGeneration;
    const liveId = this.liveId;
    console.log(`[LIVE-BROADCAST] re-acquiring the camera for ${liveId} (#${attempt})`);
    try {
      await this.#deps.fetchLive(liveId);
    } catch (e) {
      if (attempt !== this.#reacquireGeneration || this.phase !== 'away') return;
      if (isLiveRefusal(e, 'ended') || isLiveRefusal(e, 'not-found')) {
        const cut = isLiveCut(e);
        console.warn(
          `[LIVE-BROADCAST] ${liveId} ${cut ? 'was cut by moderation' : 'ended'} while the camera was away`
        );
        this.#finish(cut ? 'cut' : 'server-while-away', false);
        return;
      }
      // No verdict (offline, a 5xx): the camera comes back, and the uploader's next answer decides.
      console.warn(
        '[LIVE-BROADCAST] the live could not be read on return - re-acquiring anyway',
        e
      );
    }
    if (attempt !== this.#reacquireGeneration || this.phase !== 'away') return;
    await this.camera.start();
    if (attempt !== this.#reacquireGeneration || this.phase !== 'away') return;
    if (this.camera.phase !== 'live' || !this.camera.stream) {
      // Refused, busy, or the app went away again: the screen shows the camera's own fault and a
      // Retry, and the live keeps its window.
      console.warn(`[LIVE-BROADCAST] camera not back (${this.camera.phase}/${this.camera.fault})`);
      return;
    }
    // The previous recorder's last chunk goes into ITS generation before a new one begins.
    await this.#stopping;
    if (attempt !== this.#reacquireGeneration || this.phase !== 'away') return;
    this.#goOnAir();
  }

  /**
   * The member confirmed End. The device's part is over as soon as the last chunk is sealed and
   * queued: the camera, the screen lock and the recorder are given back THEN, not after the network.
   * What is left is the queue reaching the server, waited for at most the server's reconnect window
   * (past it the server has ended the live by absence anyway) - and the screen offers to leave
   * before that, which {@link dispose} honours.
   */
  async end(): Promise<void> {
    if (this.phase !== 'live' && this.phase !== 'away') return;
    const liveId = this.liveId!;
    console.log(`[LIVE-BROADCAST] ending ${liveId}`);
    this.phase = 'ending';
    ++this.#reacquireGeneration;
    this.#pauseRecording('the live is ending');
    await this.#stopping;
    await this.#pipeline?.flush();
    if (this.#disposed) return;
    this.#pipeline?.close();
    this.camera.stop();
    console.debug(
      `[LIVE-BROADCAST] camera given back; ${this.#uploader?.backlog ?? 0} segments to send`
    );
    const window = this.limits?.reconnectWindowMs ?? 0;
    const drained = await this.#bounded(
      this.#uploader ? this.#uploader.idle() : Promise.resolve(),
      window,
      'the last segments'
    );
    if (this.#disposed) return;
    if (!drained) console.warn(`[LIVE-BROADCAST] ${liveId}: the queue is dropped unsent`);
    this.#release();
    try {
      await this.#deps.endLive(liveId);
    } catch (e) {
      if (isLiveCut(e)) {
        console.warn('[LIVE-BROADCAST] the End was answered by a moderation cut');
        this.#serverEndedWhileEnding = 'cut';
      } else if (!isLiveRefusal(e, 'ended') && !isLiveRefusal(e, 'not-found')) {
        console.warn(
          '[LIVE-BROADCAST] the end was not confirmed - the server ends it by absence',
          e
        );
      }
    }
    // A 410 heard while draining means the server had ended it first (the hour, a moderation cut).
    this.#settle(this.#serverEndedWhileEnding ?? 'broadcaster');
  }

  /** The screen is going away (closed, navigated, the page hidden for good): nothing stays on air. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const open = this.phase === 'live' || this.phase === 'away' || this.phase === 'ending';
    console.debug(`[LIVE-BROADCAST] dispose in ${this.phase}`);
    ++this.#reacquireGeneration;
    this.#pauseRecording('the screen is closing');
    this.#release();
    if (open && this.liveId) this.#endBestEffort(this.liveId);
  }

  /**
   * The live's key, for the chat that seals with it (WP-L6), or null before a start. Set in the same
   * step as `liveId`, so a screen reading both once `liveId` is set reads the pair. Never logged.
   */
  get chatKey(): string | null {
    return this.#keyHex;
  }

  /**
   * The chat's loop heard the server's verdict that the live is over (`410` or the `404` of a purged
   * live) before the uploader did: the SAME end as the uploader's own verdict, never a second rule -
   * so the end screen, a moderation cut's included, does not depend on which request heard it first.
   */
  chatHeardEnd(verdict: unknown): void {
    console.debug(`[LIVE-BROADCAST] the chat heard the end of ${this.liveId} in ${this.phase}`);
    if (this.phase !== 'live' && this.phase !== 'away' && this.phase !== 'ending') return;
    if (!isLiveRefusal(verdict, 'ended') && !isLiveRefusal(verdict, 'not-found')) {
      console.warn('[LIVE-BROADCAST] the chat reported an end that is no end verdict - ignored');
      return;
    }
    this.#uploaderStopped(verdict);
  }

  /** Starts recording the camera in hand, or goes `away` when there is none to record. */
  #goOnAir(): void {
    if (this.#screenGoneWhileStarting) {
      this.#screenGoneWhileStarting = false;
      console.log('[LIVE-BROADCAST] the screen share is gone - ending the live that just started');
      this.phase = 'away';
      void this.end();
      return;
    }
    const stream = this.camera.stream;
    if (this.#deps.isHidden() || this.camera.phase !== 'live' || !stream) {
      console.debug('[LIVE-BROADCAST] no camera to record yet - away until it is back');
      this.phase = 'away';
      // Hidden: the return re-acquires. Visible (the camera was given back and reopened during the
      // start, or is still opening): re-acquire now, since no return is coming to do it.
      if (!this.#deps.isHidden()) void this.reacquire();
      return;
    }
    const generation = ++this.#recorderGeneration;
    const first = this.#firstRecordAt === null;
    const now = this.#deps.now();
    // Silence is measured ON AIR only: nothing is stored while away, so a clock left running across
    // a background would read the whole absence as a lost connection at the first enqueue.
    this.#lastStoredAt = now;
    this.#firstRecordAt ??= now;
    // The generation is FIXED in this recorder's callback: its last chunk, arriving after a pause,
    // still lands in its own splitter and never in the next recorder's.
    const pipelineGeneration = this.#pipeline!.beginGeneration(
      first ? 0 : now - this.#firstRecordAt
    );
    this.#pipelineGeneration = pipelineGeneration;
    try {
      this.#recorder = this.#deps.startRecorder(
        stream,
        (chunk) => void this.#pipeline?.push(pipelineGeneration, chunk),
        (error) => this.#recorderFailed(generation, error)
      );
    } catch (e) {
      console.error('[LIVE-BROADCAST] no recorder on this stream - ending', e);
      this.#finish('failed', true);
      return;
    }
    this.#watchTrack(stream, generation);
    this.phase = 'live';
    this.health = 'ok';
    this.awayProblem = null;
    void this.#deps.wakeLock.hold();
    console.log(`[LIVE-BROADCAST] on air (recorder ${generation})`);
  }

  /** Listens to the recorded lens: an `ended` while visible is a lens taken (another app, a revoke). */
  #watchTrack(stream: MediaStream, generation: number): void {
    this.#trackWatch?.abort();
    const watch = new AbortController();
    this.#trackWatch = watch;
    const lens = stream.getVideoTracks()[0];
    const opts = { signal: watch.signal };
    lens?.addEventListener?.(
      'ended',
      () => {
        if (generation !== this.#recorderGeneration || this.phase !== 'live') return;
        console.warn('[LIVE-BROADCAST] the lens ended under the live - away until Retry');
        this.#pauseRecording('the lens ended');
        this.phase = 'away';
      },
      opts
    );
    // iOS mutes a track it pauses; the recorder carries on and the unmute resumes the picture. Read
    // so a field log says what happened, never acted on: nothing records twice.
    lens?.addEventListener?.('mute', () => console.warn('[LIVE-BROADCAST] the lens muted'), opts);
    lens?.addEventListener?.('unmute', () => console.debug('[LIVE-BROADCAST] lens unmuted'), opts);
  }

  #recorderFailed(generation: number, error: unknown): void {
    if (generation !== this.#recorderGeneration || this.phase !== 'live') return;
    console.error('[LIVE-BROADCAST] the recorder failed on air - away until Retry', error);
    this.#awayUntilRetry('the recorder failed');
  }

  /**
   * The pipeline could not read or frame a chunk of `generation`, or could not send several of its
   * fragments in a row: that recorder sends nothing any more, so the screen must not go on saying "on air". The camera is given back and Retry starts a
   * fresh recorder - a fresh init - on the same live.
   */
  #pipelineBroken(generation: number): void {
    if (generation !== this.#pipelineGeneration || this.phase !== 'live') {
      console.warn(
        `[LIVE-BROADCAST] pipeline generation ${generation} broke after its recorder was let go - nothing to stop`
      );
      return;
    }
    console.error('[LIVE-BROADCAST] the recorder output cannot be sent - away until Retry');
    this.#awayUntilRetry('the recorder output cannot be sent');
    this.awayProblem = 'unsendable';
  }

  #awayUntilRetry(why: string): void {
    this.#pauseRecording(why);
    this.camera.stop();
    this.phase = 'away';
  }

  /**
   * Stops the current recorder and forgets it. Its last chunk is still handed over - waited for at
   * most {@link LIVE_RECORDER_STOP_BOUND_MS} - and its pipeline generation is then closed, which
   * LOGS any bytes it still held; {@link #stopping} resolves when both are done.
   */
  #pauseRecording(why: string): void {
    console.debug(`[LIVE-BROADCAST] recording paused: ${why}`);
    ++this.#recorderGeneration;
    this.#trackWatch?.abort();
    this.#trackWatch = null;
    const recorder = this.#recorder;
    const generation = this.#pipelineGeneration;
    this.#recorder = null;
    this.#pipelineGeneration = null;
    this.#deps.wakeLock.release();
    if (!recorder && generation === null) return;
    const lastChunk = recorder
      ? this.#bounded(recorder.stop(), LIVE_RECORDER_STOP_BOUND_MS, "the recorder's last chunk")
      : Promise.resolve(true);
    const previous = this.#stopping;
    this.#stopping = Promise.all([previous, lastChunk]).then(async () => {
      if (generation !== null) await this.#pipeline?.endGeneration(generation);
    });
  }

  /**
   * Resolves true when `work` settles within `ms`, false when the bound came first (logged). A
   * rejection counts as settled and is logged: the wait is over either way.
   */
  async #bounded(work: Promise<unknown>, ms: number, what: string): Promise<boolean> {
    const settled = work.then(
      () => true,
      (e: unknown) => {
        console.warn(`[LIVE-BROADCAST] ${what} failed`, e);
        return true;
      }
    );
    const done = await Promise.race([settled, this.#deps.sleep(ms).then(() => false)]);
    if (!done)
      console.warn(`[LIVE-BROADCAST] ${what}: nothing within ${ms} ms - not waited for longer`);
    return done;
  }

  /**
   * Reads the queue's backlog onto the screen and ends what the server cannot recover - measured on
   * what it last STORED, not on the count alone:
   * - nothing stored for longer than `reconnectWindowMs`: the server ends a live that silent anyway,
   *   so the connection is lost (`connection-lost`);
   * - still storing, but the backlog past the window's worth of segments: the uplink is slower than
   *   real time, viewers fall further behind every minute and memory grows (~23 MB a minute), so
   *   the live ends saying so (`upload-too-slow`) - never that the connection was lost.
   */
  #noteBacklog(): void {
    const backlog = this.#uploader?.backlog ?? 0;
    this.backlog = backlog;
    if ((this.phase !== 'live' && this.phase !== 'away') || !this.limits) return;
    const window = this.limits.reconnectWindowMs;
    const now = this.#deps.now();
    const silentMs = now - (this.#lastStoredAt ?? now);
    if (silentMs > window) {
      console.warn(
        `[LIVE-BROADCAST] nothing stored for ${Math.round(silentMs)} ms, past the ${window} ms the server keeps a silent live - connection lost, ending`
      );
      this.#finish('connection-lost', true);
      return;
    }
    const cap = Math.ceil(window / LIVE_SEGMENT_MS) + LIVE_BACKLOG_MARGIN_SEGMENTS;
    if (backlog <= cap) return;
    console.warn(
      `[LIVE-BROADCAST] ${backlog} segments waiting, over the ${cap} the reconnect window holds, while the server still stores (last ${Math.round(silentMs)} ms ago) - the upload is too slow, ending`
    );
    this.#finish('upload-too-slow', true);
  }

  #uploaderStopped(error: unknown): void {
    const ended = isLiveRefusal(error, 'ended') || isLiveRefusal(error, 'not-found');
    if (this.phase === 'ending') {
      // The End is draining and settles the screen, but must not call the server's end the member's.
      if (ended) {
        const cut = isLiveCut(error);
        console.warn(
          `[LIVE-BROADCAST] the server ${cut ? 'cut' : 'ended'} the live while the End was draining`
        );
        this.#serverEndedWhileEnding = cut ? 'cut' : 'server';
      }
      return;
    }
    if (this.phase === 'ended') return;
    const cause: LiveEndCause = isLiveCut(error)
      ? 'cut'
      : ended
        ? this.phase === 'away'
          ? 'server-while-away'
          : 'server'
        : 'failed';
    console.warn(`[LIVE-BROADCAST] the uploader stopped (${cause})`);
    this.#finish(cause, !ended);
  }

  /** Ends the screen at once: nothing recorded or sent any more. */
  #finish(cause: LiveEndCause, endOnServer: boolean): void {
    ++this.#reacquireGeneration;
    this.#pauseRecording(`the live ended (${cause})`);
    this.#release();
    if (endOnServer && this.liveId) this.#endBestEffort(this.liveId);
    this.#settle(cause);
  }

  #settle(cause: LiveEndCause): void {
    const s = this.#pipeline?.stats;
    console.log(
      `[LIVE-BROADCAST] ${this.liveId} ended (${cause}) after ${Math.round(this.elapsedMs() / 1000)} s: ` +
        `${s?.segments ?? 0} segments, ${s?.dropped ?? 0} dropped, ${s?.notOnKeyframe ?? 0} off a keyframe`
    );
    this.endCause = cause;
    this.phase = 'ended';
  }

  /** Gives back everything held: the queue (its unsent bytes dropped), the pipeline, the camera, the screen lock. */
  #release(): void {
    ++this.#recorderGeneration;
    this.#trackWatch?.abort();
    this.#trackWatch = null;
    this.#pipeline?.close();
    this.#uploader?.stop();
    this.camera.stop();
    this.#deps.wakeLock.release();
  }

  #endBestEffort(liveId: string): void {
    this.#deps.endLive(liveId).then(
      (r) => console.debug(`[LIVE-BROADCAST] ${liveId} ended on leaving (${r.endReason})`),
      (e: unknown) => {
        if (isLiveRefusal(e, 'ended') || isLiveRefusal(e, 'not-found')) return;
        console.warn(
          `[LIVE-BROADCAST] ${liveId} not ended on leaving - the server ends it by absence`,
          e
        );
      }
    );
  }
}
