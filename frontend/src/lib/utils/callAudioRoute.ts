/**
 * Where the page asks a call's audio element to sound on iOS: the loudspeaker or the earpiece.
 *
 * WebKit lists NO output labelled "earpiece" - the receiver is not an enumerable device, it is where
 * a PlayAndRecord session (the microphone is held) sounds BY DEFAULT. So the earpiece is never
 * found by label, and asking for it means "the default output": `setSinkId('')` when the engine has
 * `setSinkId` (it undoes an earlier loudspeaker choice), nothing at all when it has not (nothing was
 * ever moved off the default). Only the loudspeaker is looked up by label, and failing to find it IS
 * a fact worth a line. The REAL route is the audio session's, read natively by the proximity handler
 * (`canari_ios.mm`), which is what decides the screen-off; this is the page's best-effort request.
 */
export type SpeakerRoutePlan =
  | { kind: 'device'; deviceId: string }
  | { kind: 'default' }
  | { kind: 'already-default' }
  | { kind: 'unavailable' };

/** The subset of a media device this reads. */
export interface RouteCandidate {
  kind: string;
  label: string;
  deviceId: string;
}

/**
 * Decides the route for `speaker` (true = loudspeaker). `canSetSink` is whether the element has
 * `setSinkId` at all.
 */
export function planSpeakerRoute(
  devices: readonly RouteCandidate[],
  speaker: boolean,
  canSetSink: boolean
): SpeakerRoutePlan {
  if (!canSetSink) return speaker ? { kind: 'unavailable' } : { kind: 'already-default' };
  const kind = speaker ? 'speaker' : 'earpiece';
  const target = devices.find(
    (d) => d.kind === 'audiooutput' && d.label.toLowerCase().includes(kind)
  );
  if (target) return { kind: 'device', deviceId: target.deviceId };
  return speaker ? { kind: 'unavailable' } : { kind: 'default' };
}

/** The subset of an audio element the router moves. */
export interface RoutableSink {
  setSinkId?: (id: string) => Promise<void>;
}

/** What the router needs from its host, so a test can hand in its own. */
export interface SpeakerRouterDeps {
  enumerate: () => Promise<readonly RouteCandidate[]>;
  log: (line: string) => void;
}

/**
 * The page's request to move ONE audio element to the loudspeaker or the earpiece, ordered.
 *
 * `enumerate()` is async and nothing else orders two requests for the same element: a fast speaker
 * on -> off would let the first one's `setSinkId(speaker)` land AFTER the second one's
 * `setSinkId('')`, leaving the voice on the loudspeaker under an earpiece UI. So each request takes
 * a generation for its element BEFORE the await and a result that is no longer the latest is dropped
 * after it (a state check, not a delay). Elements are independent: the voice and the ringback never
 * cancel each other.
 */
export function createSpeakerRouter(deps: SpeakerRouterDeps) {
  const generations = new Map<object, number>();
  return async function route(sink: RoutableSink, speaker: boolean): Promise<void> {
    const mine = (generations.get(sink) ?? 0) + 1;
    generations.set(sink, mine);
    try {
      const kind = speaker ? 'speaker' : 'earpiece';
      const devices = await deps.enumerate();
      if (generations.get(sink) !== mine) return;
      const plan = planSpeakerRoute(devices, speaker, typeof sink.setSinkId === 'function');
      // The earpiece is the DEFAULT output of a call, never a listed device.
      if (plan.kind === 'already-default') return;
      if (plan.kind === 'unavailable' || !sink.setSinkId) {
        deps.log(`[Call] WARN no '${kind}' output to route to on this engine - route unchanged`);
        return;
      }
      await sink.setSinkId(plan.kind === 'device' ? plan.deviceId : '');
      deps.log(`[Call] audio routed to ${plan.kind === 'device' ? kind : 'the default output'}`);
    } catch (e) {
      deps.log(`[Call] audio routing failed: ${String(e)}`);
    }
  };
}
